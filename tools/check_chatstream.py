# -*- coding: utf-8 -*-
"""判据：模型层"发出去必须出字"——不许**零分片、零错误、静默结束**。

用户报的 bug（原话）：「**现在 AI 聊天，我输出东西之后，它是没办法出字儿的**」。
查实的根因（有证据）：
  · 会话 160 那轮（20:17:07）`chat_event` 里 20 条事件**没有一条 message_update**，
    `trace` 里 input/output tokens 全 0 —— 说明模型层一个字都没吐；
  · 渠道请求日志里客户端打的是 `/v1/responses`，而本机 8317 的中转只转发
    chat-completions 格式的分片 → 正文全被吃掉，只剩一个 `data: [DONE]`；
  · 我们原来的 `stream_chat()` 遇到"HTTP 200 + 没有 data 分片"就**静默 return**，
    于是界面既没有字、也没有任何提示。

这个脚本用一个**假渠道**把上面那种响应原样复现出来，然后要求：
  ① 假渠道"/responses 流式只回 [DONE]、/responses 非流式 404、/chat/completions 非流式正常"
     → 我们的客户端**必须自己回退**并把正文吐出来（这就是修好的标志）；
  ② 假渠道**全都是空的** → 必须吐一条**说人话的错误**（不许静默）；
  ③ 流式 / 非流式两条路都要有：流式 ≥3 个分片、非流式 = 1 个整段；
  ④ （可选 --live）真实渠道打一句，必须出字。

 ⑥ （第 31 轮加）**声明的接口一个分片都不给时，必须换另一种接口再流一次** ——
    这正本机"修补站"的实况：声明 `/responses`，它流式只回 `data: [DONE]`，
    而同一个中转的 `/chat/completions` 是**逐字吐**的。⑥ 要求这条路上拿到 **≥3 个分片**（真流式），
    而不是退回整段（老行为：1 片 = 字是一次蹦出来的，用户看到的就是"没有流式"）。

反证（必须报红）：
  LLM_NOFALLBACK=1 server/venv/bin/python tools/check_chatstream.py   → ① 必须红（回退没接上）
  LLM_NOSTREAM_RETRY=1 ...                                            → ⑥ 必须红（只剩 1 片整段）
  LLM_NOSTREAM_RETRY=1 LLM_NOFALLBACK=1 ...                           → ① 与 ⑥ 都红
  LLM_NOFALLBACK=1 LLM_SILENT=1 ...                                   → ② 也必须红（静默无输出）
  LLM_FORCE_STREAM=1 ...                                              → ③ 必须红（两种方式没区分）

用法：server/venv/bin/python tools/check_chatstream.py [--live]
产出：docs/聊天下字实测.json（反证写 -反证-<名字>.json）
"""
import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import db as dbm                       # noqa: E402
from server.llm.providers import stream_chat        # noqa: E402
from server.store import P                          # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
ANSWER = "今天天气不错，正好晒晒被子。"


class Fake(BaseHTTPRequestHandler):
    """模拟出问题的那种中转：流式只回 [DONE]、非流式 /responses 不通、completions 正常。"""
    mode = "broken"
    hits: list = []

    def log_message(self, *a):       # 别把噪声打进日志
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, text):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for piece in text:
            chunk = {"choices": [{"delta": {"content": piece}, "index": 0}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        payload = json.loads(self.rfile.read(n) or b"{}")
        path = self.path
        streaming = bool(payload.get("stream"))
        Fake.hits.append({"path": path, "stream": streaming})
        if Fake.mode == "hang":
            # ← 线上那种"连得上、就是不吐字"的中转（本机 8317 现在就是这样：
            #   /v1/models 秒回 200，chat/completions 60 秒一个字节都没有）。
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            time.sleep(120)                   # 一直挂着，什么都不发
            return
        if Fake.mode == "broken":
            if path.endswith("/responses"):
                if streaming:                 # ← 复现线上那种"只有 [DONE]"的响应
                    self._json_ok_sse_done()
                    return
                self._json(404, {"error": {"message": "no such endpoint"}})
                return
            if streaming:
                self._sse(ANSWER)             # 原样正常
                return
            self._json(200, {"choices": [{"message": {"role": "assistant", "content": ANSWER},
                                          "finish_reason": "stop"}]})
            return
        # mode == "dead"：怎么说都不给正文
        if streaming:
            self._json_ok_sse_done()
            return
        self._json(200, {"choices": [{"message": {"role": "assistant", "content": ""}}]})

    def _json_ok_sse_done(self):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


async def ask(base: str, api: str, stream=None, first_token_s=None) -> dict:
    provider = {"id": 0, "name": "假渠道", "model_api": api, "base_url": base,
                "api_key": "test", "options_json": "{}"}
    t0 = time.time()
    deltas, errs, ttft = [], [], 0
    async for ev in stream_chat(provider, "fake-model",
                               [{"role": "user", "content": "今天天气"}], system="短答",
                               stream=stream, first_token_s=first_token_s):
        if ev["type"] == "delta":
            if not ttft:
                ttft = int((time.time() - t0) * 1000)
            deltas.append(ev["delta"])
        elif ev["type"] == "error":
            errs.append(ev["error"])
    return {"text": "".join(deltas), "errors": errs, "ttft": ttft, "deltas": deltas,
            "ms": int((time.time() - t0) * 1000), "hits": list(Fake.hits)}


async def main() -> int:
    live = "--live" in sys.argv
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/v1" % srv.server_address[1]

    problems, steps = [], []

    # ① 线上那种坏渠道：必须自己回退出字
    Fake.mode = "broken"
    Fake.hits = []
    fake_injected = {}
    if os.environ.get("LLM_BADAPI"):
        fake_injected = {"api": os.environ["LLM_BADAPI"]}
    r1 = await ask(base, fake_injected.get("api") or "openai-responses")
    ok1 = bool(r1["text"].strip()) and not r1["errors"]
    steps.append({"step": "① 坏渠道（/responses 流式只回 [DONE]、非流式 404，completions 正常）",
                  "expect": "自己回退并吐出正文", "res": {k: v for k, v in r1.items() if k != "hits"},
                  "ok": ok1})
    if not ok1:
        problems.append("① 坏渠道下没出字（回退没接上）：text=%r errors=%r" % (r1["text"], r1["errors"]))

    # ② 死渠道：必须说人话，不许静默
    Fake.mode = "dead"
    Fake.hits = []
    r2 = await ask(base, "openai-responses")
    ok2 = (not r2["text"].strip()) and bool(r2["errors"]) and ("没有返回内容" in r2["errors"][0])
    steps.append({"step": "② 死渠道（怎么问都不给正文）", "expect": "吐一条说人话的错误",
                  "res": {k: v for k, v in r2.items() if k != "hits"}, "ok": ok2})
    if not ok2:
        problems.append("② 死渠道下静默无输出（这正是用户看到的\"出不了字\"）：errors=%r" % (r2["errors"],))

    # ③ 流式 / 非流式**两条路都要有，而且看得出区别**
    Fake.mode = "broken"
    Fake.hits = []
    r_on = await ask(base, "openai-completions", stream=True)
    r_off = await ask(base, "openai-completions", stream=False)
    ok3 = (len(r_on["deltas"]) >= 3) and (len(r_off["deltas"]) == 1) and r_off["text"].strip()
    steps.append({"step": "③ 流式 vs 非流式（同一个假渠道）",
                  "expect": "流式 ≥3 个分片、非流式 = 1 个整段",
                  "res": {"on": {"deltas": len(r_on["deltas"]), "text": r_on["text"][:20]},
                          "off": {"deltas": len(r_off["deltas"]), "text": r_off["text"][:20]}},
                  "ok": ok3})
    if not ok3:
        problems.append("③ 两种出字方式没区分开：流式 %d 片 / 非流式 %d 片"
                        % (len(r_on["deltas"]), len(r_off["deltas"])))

    # ④ 卡住的渠道（连得上、一个字不吐）：必须在看门狗时间内**说出原因**，不许干等
    #    用户报的"发出去出不了字"就包括这一种：界面一直"回复中…"，人只能干等。
    Fake.mode = "hang"
    Fake.hits = []
    loose = bool(os.environ.get("CHATSTREAM_NOWATCH"))     # 反证：把看门狗调松 = 老行为
    ft = 45.0 if loose else 1.5
    try:
        r4 = await asyncio.wait_for(ask(base, "openai-completions", first_token_s=ft), timeout=6.0)
        r4["timeout"] = False
    except asyncio.TimeoutError:
        r4 = {"timeout": True, "errors": [], "text": "", "ms": 6000, "deltas": []}
    ok4 = ((not r4["timeout"]) and bool(r4["errors"]) and ("没有第一个字" in r4["errors"][0])
           and r4["ms"] < 4000 and not r4["text"].strip())
    steps.append({"step": "④ 卡住的渠道（连得上但不吐字）",
                  "expect": "看门狗时间内说出原因，绝不干等（本次看门狗 %.1fs）" % ft,
                  "res": {"errors": r4["errors"], "ms": r4["ms"], "timeout": r4["timeout"]},
                  "ok": ok4})
    if not ok4:
        problems.append("④ 卡住的渠道下界面只能干等（既没字也没原因）：%s"
                        % json.dumps({"timeout": r4["timeout"], "errors": r4["errors"],
                                      "ms": r4["ms"]}, ensure_ascii=False))
    # ⑥ 声明的接口零分片 → 换另一种接口再流一次（必须真流式，≥3 片）
    Fake.mode = "broken"
    Fake.hits = []
    r6 = await ask(base, "openai-responses")
    ok6 = len(r6["deltas"]) >= 3 and r6["text"].strip()
    steps.append({"step": "⑥ 声明 /responses 但那边只回 [DONE] → 换 /chat/completions 再流",
                  "expect": "仍然是**逐字**出（≥3 个分片），不是退回整段",
                  "res": {"chunks": len(r6["deltas"]), "chunk_sizes": [len(d) for d in r6["deltas"]][:8],
                          "text": r6["text"][:40],
                          "tried": [h["path"].rsplit("/", 1)[-1] for h in r6["hits"] if h["stream"]]},
                  "ok": ok6})
    if not ok6:
        problems.append("⑥ 零分片时没有换另一种接口重流（拿到 %d 片 —— 1 片就是「整段蹦出来」，"
                        "用户看到的就是「没有流式」）" % len(r6["deltas"]))

    Fake.mode = "broken"
    srv.shutdown()

    # ⑤ 真实渠道（可选）：当前会话用的那个模型必须出字
    if live:
        dbm.init(P.db)
        row = dbm.db().one("SELECT model_key FROM chat_session WHERE model_key!='' "
                           "ORDER BY updated_at DESC LIMIT 1")
        mk = os.environ.get("CHATSTREAM_MODEL") or (row or {}).get("model_key") or ""
        from server.llm.providers import provider_of
        provider, mid = provider_of(mk)
        provider = dict(provider)
        deltas, errs, ttft = [], [], 0
        t0 = time.time()
        async for ev in stream_chat(provider, mid,
                                   [{"role": "user", "content": "请只回四个字：测试通过"}],
                                   system="回答要短，别解释。", temperature=0.2):
            if ev["type"] == "delta":
                if not ttft:
                    ttft = int((time.time() - t0) * 1000)
                deltas.append(ev["delta"])
            elif ev["type"] == "error":
                errs.append(ev["error"])
        text = "".join(deltas)
        ok3 = bool(text.strip()) and not errs
        # 诚实记一笔：**这个渠道自己给了几片**。1 片 = 渠道把整段一次给全（本机两条都这样），
        # 那就不是"我们没接流式"，而是渠道不给分片 —— 界面层用逐字显现补体感（见 e2e-chatstream.js 乙）。
        steps.append({"step": "⑤ 真实渠道（%s / %s）" % (provider["name"], mid),
                      "expect": "出字（并记下这个渠道自己吐几片）",
                      "res": {"text": text[:80], "errors": errs, "ttft": ttft,
                              "chunks": len(deltas), "lump": len(deltas) <= 2,
                              "chunk_sizes": [len(d) for d in deltas][:8],
                              "ms": int((time.time() - t0) * 1000)}, "ok": ok3})
        if not ok3:
            problems.append("⑤ 真实渠道没出字：text=%r errors=%r" % (text, errs))

    rep = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "live": live,
           "nofallback": bool(os.environ.get("LLM_NOFALLBACK")),
           "nostream_retry": bool(os.environ.get("LLM_NOSTREAM_RETRY")),
           "silent": bool(os.environ.get("LLM_SILENT")),
           "nowatch": bool(os.environ.get("CHATSTREAM_NOWATCH")),
           "steps": steps, "problems": problems}
    name = "docs/聊天下字实测.json"
    if os.environ.get("CHATSTREAM_NOWATCH"):
        name = "docs/聊天下字实测-反证-没看门狗.json"
    elif os.environ.get("LLM_FORCE_STREAM"):
        name = "docs/聊天下字实测-反证-装没看见非流式.json"
    elif os.environ.get("LLM_NOFALLBACK") and os.environ.get("LLM_SILENT"):
        name = "docs/聊天下字实测-反证-静默.json"
    elif os.environ.get("LLM_NOFALLBACK"):
        name = "docs/聊天下字实测-反证-不回退.json"
    elif os.environ.get("LLM_NOSTREAM_RETRY"):
        name = "docs/聊天下字实测-反证-不换接口重流.json"
    (ROOT / name).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    for s in steps:
        print(("  ✓ " if s["ok"] else "  ✗ ") + s["step"] + " —— " + s["expect"])
        print("      " + json.dumps(s["res"], ensure_ascii=False)[:240])
    print(("\n全过 ✅" if not problems else "\n有红 ❌ " + "；".join(problems)) + "  → " + name)
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
