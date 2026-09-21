#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型挂了会不会自动换一个（docs/11 阶段 16.8）实测。

做法：临时加一个「指向死地址」的供应商（127.0.0.1:1，肯定连不上）+ 一个模型，
     用这个模型去调 /api/write/summary（流式），看服务器会不会：
       ① 先吐一条 notice 说明「XX 没连上，已自动换 YY 重试」；
       ② 然后真的用 YY 把正文写出来。
     跑完把这个临时供应商删掉（不留垃圾）。

跑法：server/venv/bin/python tools/verify_fallback.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
SLUG = "example-book"
CHAPTER = "manuscript/第001章-荒原雪夜.md"
BAD_NAME = "ZZ自测死渠道"
results: list[tuple[str, bool, str]] = []


def pw() -> str:
    try:
        return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8")).get("app_password") or "")
    except Exception:
        return ""


class C:
    def __init__(self):
        self.cookie = ""
        self.op = urllib.request.build_opener()

    def call(self, path, method="GET", body=None, raw=False):
        req = urllib.request.Request(BASE + path, method=method)
        if self.cookie:
            req.add_header("cookie", self.cookie)
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, data, timeout=180) as r:
                sc = r.headers.get("set-cookie")
                if sc:
                    self.cookie = sc.split(";")[0]
                txt = r.read().decode("utf-8", "replace")
                if raw:
                    return r.status, txt
                try:
                    return r.status, json.loads(txt)
                except Exception:
                    return r.status, txt
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")


def check(name, ok, why=""):
    results.append((name, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:200]))


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1

    # 先清掉上次可能的残留（只认「ZZ自测」这个名字，绝不碰用户自己的渠道）
    st, snap = c.call("/api/config/snapshot")
    provs = (((snap or {}).get("effective") or {}).get("models") or {}).get("providers") or {}
    for grp, p in provs.items():
        if str(p.get("name") or "").startswith("ZZ自测"):
            print("  清掉上次残留的自测渠道：", p.get("name"), p.get("id"))
            c.call("/api/config/models/provider?id=%s" % p.get("id"), "DELETE")
    # 模型 key 走 /api/models（写作链路用的就是它：group/modelId）
    st, d = c.call("/api/config/models/provider", "POST", {
        "name": BAD_NAME, "group": "ZZSELFTEST", "modelApi": "openai-completions",
        "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "self-test-not-a-real-key",
        "models": [{"id": "dead-model", "name": "死渠道模型"}]})
    pid = (d or {}).get("id") if isinstance(d, dict) else None
    check("① 临时加了个连不上的渠道", st == 200 and pid, f"{st} {d}")
    if not pid:
        return 1

    st, lib = c.call("/api/models")
    keys = [m["key"] for m in ((lib or {}).get("models") or [])] if isinstance(lib, dict) else []
    bad_key = next((k for k in keys if k.endswith("dead-model")), "")
    others = [k for k in keys if not k.endswith("dead-model")]
    check("① 这个死渠道进了模型库，而且还有别的能用的模型",
          bool(bad_key) and bool(others), f"bad={bad_key} others={len(others)}")
    if not bad_key or not others:
        c.call("/api/config/models/provider?id=%s" % pid, "DELETE")
        return 1

    # ② 流式：用死模型写作（apply=false，只回文本、不碰书稿），看有没有自动换一个
    st, txt = c.call("/api/write/generate", "POST", {
        "slug": SLUG, "path": CHAPTER, "mode": "chapter", "modelKey": bad_key,
        "stream": True, "apply": False, "maxTokens": 80}, raw=True)
    evs = []
    for chunk in txt.split("\n\n"):
        if chunk.startswith("data: "):
            try:
                evs.append(json.loads(chunk[6:]))
            except Exception:
                pass
    kinds = [e.get("type") for e in evs]
    notice = next((e.get("notice") or "" for e in evs if e.get("type") == "notice"), "")
    done = next((e for e in evs if e.get("type") == "done"), {})
    text = (done or {}).get("text") or ""
    print("     事件序列：", kinds[:8], "| notice:", notice[:90], "| 正文长度:", len(text))
    check("② 流式：主模型挂了会先说明「已自动换 X 重试」", "自动换" in notice, notice)
    check("② 流式：换了之后真的把正文写出来了", len(text) > 40, f"len={len(text)}")
    check("② 流式：done 里报的是换过之后的模型（不是那个死渠道）",
          bool(done.get("model")) and not str(done.get("model")).endswith("dead-model"),
          done.get("model"))

    # ②b 非流式（summary/outline 这种要落库的走法）也得能自动换
    st, d = c.call("/api/write/summary", "POST", {
        "slug": SLUG, "path": CHAPTER, "modelKey": bad_key, "maxTokens": 64})
    check("②b 非流式接口也自动换了模型",
          st == 200 and isinstance(d, dict) and len(str(d.get("text") or "")) > 10
          and not str(d.get("model") or "").endswith("dead-model"),
          f"{st} {str(d)[:160]}")

    # ③ 收尾：删掉临时渠道；顺便确认模型库干净了
    st, d = c.call("/api/config/models/provider?id=%s" % pid, "DELETE")
    check("③ 临时渠道删掉了", st == 200, f"{st} {d}")
    st, lib = c.call("/api/models")
    left = [m["key"] for m in ((lib or {}).get("models") or []) if m["key"].endswith("dead-model")]
    check("③ 模型库里没有残留", not left, left)

    bad = [r for r in results if not r[1]]
    print("\n=== 共 %d 项：通过 %d，失败 %d ===" % (len(results), len(results) - len(bad), len(bad)))
    Path("docs/模型降级实测.json").write_text(json.dumps(
        {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results),
         "ok": len(results) - len(bad), "fail": len(bad),
         "events": kinds[:20], "notice": notice, "textChars": len(text),
         "finalModel": (done or {}).get("model"),
         "results": [{"name": n, "ok": o, "why": w} for n, o, w in results]},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print("报告： docs/模型降级实测.json")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
