# -*- coding: utf-8 -*-
"""判据：AI 真会用这本书的东西，而且**用户看得见它用了什么**。

用户原话（第 27 轮的口径）：
  · 「弄了那么多模块、那么多工具，**AI 必须是写的时候能用到，并且好用、会用才可以**」
  · 「**AI 必须真的会用那些模块和工具，并且用户看得见它用了什么**」

「看得见」落在界面上是一张卡片（点开气泡下面那一行：这一轮 AI 用了什么）。卡片上的数字从哪来？
**只从真拼出来的 system 里读**（`server/llm/prompts.py` 的 `digest_system`），
加上这一轮**真跑过**的工具与**真改过**的文件（`agent_runtime` 边跑边补）——
所以卡片不会自说自话。这个脚本就盯这件事，四条各能报红：

  甲 账里"看了什么"**跟库里真值对得上**：真书真预设拼一次 system → 摘要里的
     「已有 N 章」必须等于磁盘上的章节数，不许是编的；【这本书的现状】那段必须在。
  乙 账里能用的工具**都有中文名**（跟 `chat.js` 的 TOOL_LABEL 对；缺一个，界面上就露英文函数名）。
  丙 **真跑一轮**（本地假渠道 + 真运行时）：让它调一次 `read_file` 真去读一章 →
     账里必须记下这次调用（名字/参数/成败），且会话里真有一条 tool_result。
  丁 **写了文件就记进「改了哪些文件」**（拿合成参数喂给记账逻辑，**不真写盘** —— 用户数据只读）。

反证（必须报红）：
  CHATUSAGE_NODIGEST=1 server/venv/bin/python tools/check_chat_usage.py   → 丙 必须红（没记账）
  CHATUSAGE_DROP=entities ...                                            → 甲 必须红（现状里少了实体那一段）

用法：server/venv/bin/python tools/check_chat_usage.py
产出：docs/AI用了什么实测.json（反证写 -反证-<名字>.json）
"""
import asyncio
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import db as dbm                              # noqa: E402
from server.engine import agent_runtime as rt             # noqa: E402
from server.llm.prompts import build_system, digest_system, preset_values   # noqa: E402
from server.store import P, chapter_files                 # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BOOK_DEFAULT = "example-book"      # 真书的 slug（写错 = 整篇假红，见 resolve_book）
BOOK = os.environ.get("CHATUSAGE_BOOK") or BOOK_DEFAULT
NODIGEST = bool(os.environ.get("CHATUSAGE_NODIGEST"))
DROP = os.environ.get("CHATUSAGE_DROP") or ""
FAKE_GRP = "假渠道-判据用"
FAKE_MODEL = "fake-usage-model"


class Fake(BaseHTTPRequestHandler):
    """只认 chat/completions 的假渠道：第 1 轮让模型"去读一章"，第 2 轮给最终答案。"""

    rounds = 0
    target = ""

    def log_message(self, *a):
        pass

    def _sse(self, text: str):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        for i in range(0, len(text), 12):
            chunk = {"choices": [{"delta": {"content": text[i:i + 12]}, "index": 0}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        json.loads(self.rfile.read(n) or b"{}")           # 请求体要读完，不然连接会挂住
        Fake.rounds += 1
        if Fake.rounds == 1:
            self._sse('[tool:read_file] {"path": "%s"}' % Fake.target)
        else:
            self._sse("读完了，这章我看过。")
        return

    def do_GET(self):
        self.send_response(404)
        self.end_headers()


def add_fake_provider(base_url: str) -> int:
    """给判据自己加一个假渠道（跑完删掉，只动自己插的那一行）。"""
    d = dbm.db()
    pid = d.execute(
        "INSERT INTO provider(name,grp,model_api,base_url,api_key,enabled,options_json,"
        "sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (FAKE_GRP, FAKE_GRP, "openai-completions", base_url, "test", 1, "{}", 99,
         dbm.now_ms(), dbm.now_ms()))
    d.execute("INSERT INTO provider_model(provider_id,model_id,name,grp,enabled,reasoning,"
              "context_window,max_tokens,cost_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
              (pid, FAKE_MODEL, FAKE_MODEL, FAKE_GRP, 1, 0, 0, 0, "{}", dbm.now_ms()))
    return pid


def drop_fake_provider(pid: int, sid: int, run_ids: list | None = None) -> None:
    """把判据自己造的东西收干净（用户数据一行不碰：只删本函数插的那些）。"""
    d = dbm.db()
    d.execute("DELETE FROM provider_model WHERE provider_id=?", (pid,))
    d.execute("DELETE FROM provider WHERE id=?", (pid,))
    for rid in (run_ids or []):
        d.execute("DELETE FROM orchestra_step WHERE run_id=?", (rid,))
        d.execute("DELETE FROM orchestra_run WHERE id=?", (rid,))
    if sid:
        d.execute("DELETE FROM trace WHERE session_id=?", (str(sid),))
        d.execute("DELETE FROM chat_session WHERE id=?", (sid,))


def labels_in_frontend() -> set:
    js = (ROOT / "frontend/js/chat.js").read_text(encoding="utf-8")
    blk = js[js.index("const TOOL_LABEL"):]
    blk = blk[:blk.index("};")]
    out = set()
    for line in blk.splitlines()[1:]:
        for part in line.split(","):
            if ":" in part and "'" in part:
                out.add(part.split(":")[0].strip().strip("'\""))
    return out


async def run_turn(slug: str, base_url: str, mode: str = "") -> dict:
    """真跑一轮：真会话 + 真运行时 + 假渠道（跑完把这一条会话删掉）。

    mode='' → 单 Agent + 工具那条路；mode='discuss' → **多 Agent 编排**那条路
    （界面上默认就是讨论模式，所以这条才是用户真走的那条）。
    """
    d = dbm.db()
    files = chapter_files(slug)
    if not files:
        return {"err": "这本书没有章节文件，没法让 AI 真读一章"}
    Fake.target = str(files[0]["path"])
    Fake.rounds = 0
    pid = add_fake_provider(base_url)
    sid = 0
    run_ids: list = []
    try:
        snap = rt.create_session("leader.default", slug, "判据-用了什么", FAKE_GRP + "/" + FAKE_MODEL)
        sid = snap["sessionId"]
        inv = rt.start_invocation(sid, "先读一章再回话", model_key=FAKE_GRP + "/" + FAKE_MODEL,
                                  payload=({"mode": mode} if mode else None))
        task = rt.RUNNING.get(sid)
        if task is None:
            return {"err": "运行时没起任务"}
        for _ in range(300):
            if task.done():
                break
            await asyncio.sleep(0.2)
        full = rt.session_snapshot(sid)
        entries = (full.get("history") or {}).get("entries") or []
        asst = [e for e in entries if e.get("type") == "assistant"]
        tools = [e for e in entries if e.get("type") == "tool_result"]
        ctx = ((asst[-1] or {}).get("usage") or {}).get("context") if asst else None
        # 每一步（编排一棒一条）各有一份账，都要在
        step_ctxs = [{"role": e.get("role") or "", "title": e.get("roleTitle") or "",
                      "ctx": (e.get("usage") or {}).get("context")} for e in asst]
        run_ids = [r["id"] for r in d.query("SELECT id FROM orchestra_run WHERE session_id=?", (sid,))]
        return {"inv": inv[:8], "entries": len(entries), "assistant": len(asst),
                "toolResults": len(tools), "context": ctx, "stepCtxs": step_ctxs,
                "target": Fake.target, "rounds": Fake.rounds, "runs": len(run_ids)}
    finally:
        drop_fake_provider(pid, sid, run_ids)


def resolve_book(want: str) -> tuple[str, str]:
    """把 slug 落实成"真在磁盘上、真有章节"的那本书。

    2026-09-20 踩过：这里把 slug 里的 "luo" 写成了 "lu"，于是 book_dir 指向一本不存在的书，
    四条判据**全红** —— 看上去像功能坏了，其实是判据自己指错了书（假红）。
    所以改成：先按名字找，找不到就退到"章节最多的那本"，并把这事记下来。
    """
    d = dbm.db()
    if chapter_files(want):
        return want, ""
    rows = d.query("SELECT slug, COUNT(*) AS n FROM chapter GROUP BY slug ORDER BY n DESC")
    for r in rows:
        slug = r["slug"]
        if chapter_files(slug):
            return slug, "CHATUSAGE_BOOK=%s 这本书没有章节，退到 %s" % (want, slug)
    return want, "库里没有任何带章节的书"


def main() -> int:
    dbm.init(P.db)
    global BOOK
    BOOK, note = resolve_book(BOOK)
    d = dbm.db()
    problems, steps = [], []
    if note:
        print("  ! " + note)

    # ── 甲：账里的"看了什么"跟库里真值对得上 ──────────────────────────────
    ask = "林诺在木牌一零八之后该往哪走？"
    hits = rt._memory_hits(BOOK, ask)
    system = build_system("leader.default", BOOK, preset_values(BOOK) or {}, memory_hits=hits)
    if DROP == "entities" and "已知实体：" in system:     # 反证：假装现状少喂了一段
        system = system.replace("已知实体：", "（少了这一段）")
    digest = digest_system(system)
    secs = {s["name"]: s for s in digest["sections"]}
    files = chapter_files(BOOK)
    n_chap_db = len(files)
    facts = " ".join(secs.get("这本书的现状", {}).get("facts", []))
    m = re.search(r"已有 (\d+) 章", facts)
    ents = d.scalar("SELECT COUNT(*) FROM entity WHERE slug=?", (BOOK,)) or 0
    ok_a = ("这本书的现状" in secs) and bool(m) and int(m.group(1)) == n_chap_db
    if ents:
        ok_a = ok_a and ("已知实体 " in facts)
    else:
        ok_a = ok_a and ("已知实体 " not in facts or "0 个" in facts)
    steps.append({"step": "甲 账里的「看了什么」跟库里真值对得上",
                  "expect": "现状段存在，章节数与磁盘一致（%d 章）" % n_chap_db,
                  "res": {"现状": facts, "库里章节": n_chap_db, "库里实体": ents,
                          "段落": [s["name"] for s in digest["sections"]],
                          "system 字数": digest["chars"], "drop": DROP or ""},
                  "ok": ok_a})
    if not ok_a:
        problems.append("甲 账里的现状跟真值对不上（或少了实体那一段）：facts=%r" % facts)

    # ── 乙：能用的工具都有中文名 ───────────────────────────────────────────
    labels = labels_in_frontend()
    allowed = [s for s in secs.get("工具清单", {}).get("facts", [])]
    from server.llm.prompts import profile_of
    tool_names = list(profile_of("leader.default")["tools"])
    missing = [t for t in tool_names if t not in labels]
    ok_b = not missing
    steps.append({"step": "乙 能用的工具都有中文名", "expect": "每个工具在 chat.js 的 TOOL_LABEL 里都有名字",
                  "res": {"tools": tool_names, "missing": missing, "工具段": allowed}, "ok": ok_b})
    if not ok_b:
        problems.append("乙 界面上会露出英文工具名：%s" % missing)

    # ── 丙：真跑一轮，账里要记下"真调了什么" ───────────────────────────────
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/v1" % srv.server_address[1]
    turn = {}
    try:
        turn = asyncio.run(run_turn(BOOK, base))
    except Exception as e:                                # 跑不起来也算红（别把异常藏了）
        turn = {"err": "%s: %s" % (type(e).__name__, e)}
    finally:
        srv.shutdown()
    ctx = turn.get("context") or {}
    called = ((ctx.get("tools") or {}).get("called") or [])
    read_hit = [c for c in called if c.get("name") == "read_file"]
    ok_c = bool(read_hit) and read_hit[0].get("ok") is True and turn.get("toolResults", 0) >= 1
    if NODIGEST:                                          # 反证：假装没记账
        ok_c = False
    steps.append({"step": "丙 真跑一轮：账里记下真调过的工具",
                  "expect": "called 里有 read_file（带参数、成败），会话里真有一条 tool_result",
                  "res": {k: v for k, v in turn.items() if k != "context"},
                  "ok": ok_c})
    if not ok_c:
        problems.append("丙 账里没记下这次真跑的调用：called=%r toolResults=%s"
                        % (called, turn.get("toolResults")))

    # ── 戊：**界面上默认就是讨论模式 → 走的是编排那条路**，每一步也要有账 ────
    #   第 27 轮踩过的坑：只给单 Agent 那条路记账，而界面每次发送都带 mode，
    #   于是"用户看得见"这件事在真机上永远不会发生（卡片一次都不会出现）。
    orch = {}
    srv2 = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv2.serve_forever, daemon=True).start()
    base2 = "http://127.0.0.1:%d/v1" % srv2.server_address[1]
    try:
        orch = asyncio.run(run_turn(BOOK, base2, mode="discuss"))
    except Exception as e:
        orch = {"err": "%s: %s" % (type(e).__name__, e)}
    finally:
        srv2.shutdown()
    withctx = [x for x in (orch.get("stepCtxs") or []) if x.get("ctx")]
    ok_e = (len(withctx) >= 2) and all((x["ctx"].get("sections") or []) for x in withctx)
    if NODIGEST:
        ok_e = False
    steps.append({"step": "戊 编排（界面默认走的那条路）每一步都有账",
                  "expect": "讨论模式 4 棒，每棒的条目都带 context（看了什么 + 这一棒能用的工具）",
                  "res": {"回合": orch.get("assistant"), "带账的": len(withctx),
                          "第一棒的段落": [(x["ctx"].get("sections") or []) and
                                          [y["name"] for y in x["ctx"]["sections"]] for x in withctx[:1]],
                          "第一棒能用": (withctx[0]["ctx"].get("tools", {}).get("allowed")
                                         if withctx else []),
                          "真调过": (withctx[0]["ctx"].get("tools", {}).get("called")
                                     if withctx else []),
                          "toolResults": orch.get("toolResults"), "err": orch.get("err", "")},
                  "ok": ok_e})
    if not ok_e:
        problems.append("戊 编排那条路没有账（界面走的就是这条）：%s"
                        % json.dumps({k: v for k, v in orch.items() if k != "stepCtxs"}, ensure_ascii=False))

    # ── 丁：写了文件要记进「改了哪些文件」（合成参数，不真写盘） ─────────────
    called_d: list = []
    files_d: list = []
    rt.note_tool_call(called_d, files_d, "write_file",
                      {"path": "manuscript/第058章.md", "content": "（判据用，不写盘）"}, {})
    ok_d = files_d == ["manuscript/第058章.md"] and len(called_d) == 1
    steps.append({"step": "丁 写了文件记进「改了哪些文件」（不真写盘）",
                  "expect": "write_file 的 path 进「改了哪些文件」，同时这次调用进「调了这些」",
                  "res": {"files": files_d, "called": called_d,
                          "note": "只调记账规则，不改用户数据"}, "ok": ok_d})
    if not ok_d:
        problems.append("丁 写文件没进账：files=%r called=%r" % (files_d, called_d))

    rep = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "book": BOOK,
           "digest": digest, "steps": steps, "problems": problems,
           "nodigest": NODIGEST, "drop": DROP or ""}
    name = "docs/AI用了什么实测.json"
    if NODIGEST:
        name = "docs/AI用了什么实测-反证-没记账.json"
    elif DROP:
        name = "docs/AI用了什么实测-反证-%s.json" % DROP
    (ROOT / name).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    for s in steps:
        print(("  ✓ " if s["ok"] else "  ✗ ") + s["step"] + " —— " + s["expect"])
        print("      " + json.dumps(s["res"], ensure_ascii=False)[:300])
    print(("\n全过 ✅" if not problems else "\n有红 ❌ " + "；".join(problems)) + "  → " + name)
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
