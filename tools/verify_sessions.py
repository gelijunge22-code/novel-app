#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话检索实测（docs/11 阶段 16.7「会话归档与检索：历史对话可搜」）。

做法：先读一个真会话，从它的正文里取一个词，再拿这个词去搜 —— 必须搜得到、而且要带命中上下文；
再用一个肯定不存在的词搜 —— 必须是 0，不许「搜什么都返回全部」。

跑法：server/venv/bin/python tools/verify_sessions.py
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
results: list[tuple[str, bool, str]] = []


def pw() -> str:
    try:
        return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8")).get("app_password") or "")
    except Exception:
        return ""


class C:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def call(self, path, method="GET", body=None):
        req = urllib.request.Request(BASE + path, method=method)
        d = None
        if body is not None:
            d = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, d, timeout=60) as r:
                t = r.read().decode("utf-8", "replace")
                try:
                    return r.status, json.loads(t)
                except Exception:
                    return r.status, t
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")


def check(n, ok, why=""):
    results.append((n, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + n + ("" if ok else "   —— " + str(why)[:200]))


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1

    st, d = c.call("/api/agent/sessions?limit=20")
    items = (d or {}).get("items") or []
    check("① 能列出会话", st == 200 and bool(items), f"{st} n={len(items)}")
    if not items:
        print("  这台机器上还没有会话，没得搜（接口本身是通的）")
        return 0
    sid = items[0]["sessionId"]

    st, det = c.call("/api/agent/sessions/%s" % sid)
    raw = json.dumps(det, ensure_ascii=False)
    words = re.findall(r"[\u4e00-\u9fa5]{3,6}", raw)
    term = words[0] if words else ""
    check("② 从会话正文里取到一个检索词", bool(term), f"term={term!r}")
    if not term:
        return 1

    q = urllib.parse.quote(term)
    st, d = c.call("/api/agent/sessions?limit=20&q=" + q)
    hits = (d or {}).get("items") or []
    got = [h for h in hits if h["sessionId"] == sid]
    check("③ 搜真词能搜到这个会话", st == 200 and bool(got), f"{st} hits={[h['sessionId'] for h in hits]}")
    hit = str(got[0].get("hit") or "") if got else ""
    check("④ 命中处带上下文（正文里命中截正文、只在标题/摘要命中就退到那里）",
          term in hit, hit)
    if got:
        print("     命中片段：", str(got[0]["hit"])[:80])

    st, d = c.call("/api/agent/sessions?limit=20&q=" + urllib.parse.quote("ZZ肯定搜不到的词QQ"))
    bad_hits = (d or {}).get("items") or []
    check("⑤ 搜不存在的词返回 0（不许什么都返回）", st == 200 and not bad_hits, f"{st} n={len(bad_hits)}")

    st, d = c.call("/api/agent/sessions?limit=20")
    check("⑥ 不带检索词时还是全量", st == 200 and len((d or {}).get("items") or []) >= len(items),
          f"{st} n={len((d or {}).get('items') or [])}")

    bad = [r for r in results if not r[1]]
    print("\n=== 共 %d 项：通过 %d，失败 %d ===" % (len(results), len(results) - len(bad), len(bad)))
    Path("docs/会话检索实测.json").write_text(json.dumps(
        {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "term": term, "sessionId": sid,
         "total": len(results), "ok": len(results) - len(bad), "fail": len(bad),
         "results": [{"name": n, "ok": o, "why": w} for n, o, w in results]},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print("报告： docs/会话检索实测.json")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
