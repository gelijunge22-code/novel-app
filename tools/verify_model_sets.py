#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型组实测（docs/11 阶段 17.5「模型组：一套配置复用到多处；按用途指定」）。

要证的是「真生效」，不是「能存下来」：
  ① 模型库里至少有两个可用的模型（不然这套东西没意义）
  ② 建一个组：规划用 A、写正文用 B、润色用 A
  ③ 启用后 /write/status 的「每种用途用谁」立刻变成 A/B/A
  ④ /write/context 按 mode=outline 拿到的 modelKey 就是 A（写作链路真的会用它）
  ⑤ /model-sets/resolve 说明来源是「模型组」
  ⑥ 关掉组：解析结果回到启用前的样子（不启用就不影响原有行为）
  ⑦ 删掉组：列表里没有了，不残留
  ⑧ 乱给用途 / 给不存在的模型 / 启用不存在的组 -> 明确报错（不是默默吞掉）

跑法：server/venv/bin/python tools/verify_model_sets.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
SLUG = "example-book"   # 用户那本真书（只读它的状态，不改稿）
NAME = "自测组-%s" % time.strftime("%m%d-%H%M%S")
results: list[tuple[str, bool, str]] = []


def pw() -> str:
    try:
        return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
                   .get("app_password") or "")
    except Exception:
        return ""


def u(v) -> str:
    return urllib.request.quote(str(v), safe="")


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
            t = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(t)
            except Exception:
                return e.code, t


def check(n, ok, why=""):
    results.append((n, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + n + ("" if ok else "   —— " + str(why)[:220]))


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1

    st, lib = c.call("/api/models")
    models = [m["key"] for m in ((lib or {}).get("models") or [])]
    check("① 模型库里有可用的模型（≥2 个才能分用途）", st == 200 and len(models) >= 2,
          f"{st} n={len(models)}")
    if len(models) < 2:
        return 1
    A, B = models[0], models[1]

    st, before = c.call("/api/write/status?slug=%s" % u(SLUG))
    base_purposes = (before or {}).get("purposes") or {}
    check("② 装上组之前，先记下「每种用途用谁」", st == 200 and bool(base_purposes),
          f"{st} {base_purposes}")

    st, sets0 = c.call("/api/model-sets")
    check("③ 用途清单是四项（规划/写正文/润色改写/杂活）",
          st == 200 and len((sets0 or {}).get("purposes") or []) == 4,
          json.dumps(sets0, ensure_ascii=False)[:200])

    st, d = c.call("/api/model-sets/save", "POST", {
        "name": NAME, "note": "自测：规划用第一个，写正文用第二个",
        "members": {"planner": A, "writer": B, "polish": A}})
    check("④ 建组：规划=A、写正文=B、润色=A", st == 200 and (d or {}).get("members") == 3,
          f"{st} {json.dumps(d, ensure_ascii=False)[:200]}")

    st, d = c.call("/api/model-sets/activate", "POST", {"name": NAME})
    check("⑤ 启用这个组", st == 200 and (d or {}).get("active") == NAME, f"{st} {d}")

    st, st_now = c.call("/api/write/status?slug=%s" % u(SLUG))
    p = (st_now or {}).get("purposes") or {}
    check("⑥ /write/status 的「每种用途用谁」真的变了（planner=A, writer=B, polish=A）",
          p.get("planner") == A and p.get("writer") == B and p.get("polish") == A,
          json.dumps(p, ensure_ascii=False)[:240])

    st, ctx = c.call("/api/write/context?slug=%s&mode=outline" % u(SLUG))
    check("⑦ 真·生效：按 mode=outline 准备上下文时，用的就是 A（不是只显示给人看）",
          st == 200 and (ctx or {}).get("modelKey") == A and (ctx or {}).get("purpose") == "planner",
          f"{st} {json.dumps(ctx or {}, ensure_ascii=False)[:160]}")

    st, d = c.call("/api/model-sets/resolve?slug=%s&purpose=polish" % u(SLUG))
    check("⑧ resolve 说得清来源（via=模型组、setModel=A）",
          st == 200 and (d or {}).get("via") == "模型组" and (d or {}).get("setModel") == A,
          json.dumps(d, ensure_ascii=False)[:200])

    st, d = c.call("/api/model-sets/activate", "POST", {"name": ""})
    st2, st_after = c.call("/api/write/status?slug=%s" % u(SLUG))
    check("⑨ 关掉组：回到原来的解析结果（不启用就不影响老行为）",
          st == 200 and (st_after or {}).get("purposes") == base_purposes,
          json.dumps((st_after or {}).get("purposes"), ensure_ascii=False)[:200])

    st, d = c.call("/api/model-sets/save", "POST", {"name": NAME, "members": {"乱写的用途": A}})
    check("⑩ 乱给用途：明确报错", st == 400, f"{st} {json.dumps(d, ensure_ascii=False)[:120]}")
    st, d = c.call("/api/model-sets/save", "POST", {"name": NAME, "members": {"writer": "不存在的组/模型"}})
    check("⑪ 给不存在的模型：明确报错", st == 400, f"{st} {json.dumps(d, ensure_ascii=False)[:120]}")
    st, d = c.call("/api/model-sets/activate", "POST", {"name": "根本没有这个组"})
    check("⑫ 启用不存在的组：404", st == 404, f"{st} {d}")

    st, d = c.call("/api/model-sets", "DELETE", None)
    check("⑬ 删组不带名字：报错而不是删错东西", st in (400, 422), f"{st}")
    st, d = c.call("/api/model-sets?name=%s" % u(NAME), "DELETE")
    check("⑭ 删掉自测组", st == 200, f"{st} {d}")
    st, d = c.call("/api/model-sets")
    left = [s["name"] for s in ((d or {}).get("sets") or [])]
    check("⑮ 列表里不再有它（不留垃圾）", NAME not in left, f"还剩 {left}")

    ok = sum(1 for _, o, _ in results if o)
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results), "ok": ok,
           "fail": len(results) - ok,
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "模型组实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                   encoding="utf-8")
    print(f"\n=== 共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/模型组实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
