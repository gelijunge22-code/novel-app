#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""**「AI 对话出不了字」的判据**（第 42 轮 · 用户点名"这个实际上才是最主要搞的东西"）。

根因（我实测钉死的，不是猜的）：
  第 33 轮把 `steps_for()` 的返回值从**三元组**改成了**四元组**（多一个"这一棒是不是正文"，
  为了让预设里"正文交给主创"真的能换人），可是 `orchestra.run()` 里发 run_start 事件的那一行
  还在按三元解包：
      "steps": [... for r, t, _p in steps]
  → 抛 `ValueError: too many values to unpack (expected 3)`。
  而且它是在**发第一个事件的时候**抛的 → 整轮**连第一棒都没跑**就结束。
  用户在界面上看到的就是：发出去一句话 → 只有一个空的"正在打字" → 什么都没有。

判据：
  甲（静态）源码里不许再出现"按三元包解 `steps_for()` 的结果"这种写法；
  乙（动态）真跑一轮（临时会话 + 用户那本书的 slug）：
       ① 落到库里的 assistant 条目 ≥1 且正文 ≥20 字；
       ② 事件流里 `text_delta` ≥3 个（真的是一个字一个字出来的）；
       ③ 一条「编排出错」都不许有；
       ④ 跑完状态回到 idle；
  丙（收尾）临时会话删干净（库里一行不留 —— 测试不许往用户的库里留东西）。

反证：`python3 tools/check_orchestra.py --force unpack`
      —— 把**改前那一行源码**喂给甲，甲必须报红（证明甲不是空判据）。
用法：python3 tools/check_orchestra.py [--force unpack]
产出：docs/编排出字实测.json     退出码 0 = 全过
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path("/home/ubuntu/novel-app")
sys.path.insert(0, str(ROOT))       # 直连库统计事件用（跟线上一个包名）
import httpx  # noqa: E402
BASE = "http://127.0.0.1:8899"
SLUG = "example-book"   # 用户那本真书（只读它的 slug，不动它的内容）
OUT = ROOT / "docs/编排出字实测.json"
FORCE = ""
if "--force" in sys.argv:
    FORCE = sys.argv[sys.argv.index("--force") + 1]

rows = []


def check(name, ok, why=""):
    rows.append({"name": name, "ok": bool(ok), "why": str(why)[:600]})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:240]))
    return bool(ok)


# 「改前那一行」的指纹：按三元包解 steps（多了个"是不是正文"之后必然炸）
THREE_UNPACK = re.compile(r"for\s+\w+\s*,\s*\w+\s*,\s*\w+\s+in\s+steps\b")


def check_static(src: str, tag: str = "甲"):
    """只看**拿到 `steps_for()` 返回值之后**的那一段。

    踩过的坑：第一版扫整份文件，于是把 `steps_for()` 自己内部那两行
    （`for r, t, d in steps` / `for role, title, demand in steps` —— 它们遍历的是
    MODES 里的**三元组**，本来就该按三个解）也当成了违规 → **假红**。
    判据要么精确、要么就会一会儿误报一会儿漏报。
    """
    tail = src.split("steps = steps_for(")[-1] if "steps = steps_for(" in src else src
    hits = [m.group(0) for m in THREE_UNPACK.finditer(tail)]
    return check(f"{tag} 拿到 steps_for() 之后，没有「按三元包解 steps」（改前那行的写法）",
                 not hits, "命中：" + " / ".join(hits))


def main() -> int:
    src = (ROOT / "server/engine/orchestra.py").read_text("utf-8")
    if FORCE == "unpack":
        # 「改前那一整段」：从拿 steps 到发 run_start（甲只看这一段）
        old = ('        steps = steps_for(mode, slug)\n'
               '        events.emit(sid, "orchestra_run_start", {\n'
               '            "steps": [{"role": r, "roleName": ROLES[r]["name"], "title": t}\n'
               '                      for r, t, _p in steps]}, invocation_id=inv)')
        print("  ⚠ 反证模式：把改前那一段源码喂给甲（甲必须报红）")
        check_static(old, "甲(反证)")
        return _finish()

    check_static(src)

    pw = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text())["app_password"]
    with httpx.Client(base_url=BASE, timeout=30) as c:
        r = c.post("/api/app/login", json={"password": pw})
        assert r.status_code == 200, r.text
        sid = c.post("/api/agent/sessions", json={
            "profileKey": "leader.default", "currentProjectRoot": SLUG,
            "title": f"zz-出字判据-{int(time.time())}"}).json()["sessionId"]
        try:
            c.post(f"/api/agent/sessions/{sid}/invocations",
                   json={"mode": "plan", "message": {"text": "只回一句话：这本书的开头怎么样？"}})
            snap = None
            for _ in range(40):
                time.sleep(4)
                snap = c.get(f"/api/agent/sessions/{sid}").json()
                if snap["summary"]["status"] != "running":
                    break
            es = (snap.get("history") or {}).get("entries") or []
            asst = [e for e in es if e.get("type") == "assistant"]
            texts = [str((e.get("content") or {}).get("preview") or "") for e in asst]
            best = max([len(t) for t in texts] or [0])
            errs = [e for e in es if e.get("type") == "system"
                    and "编排出错" in str((e.get("content") or {}).get("preview") or "")]
            deltas = 0
            try:
                from server import db as dbm
                dbm.init(ROOT / "data/app.db")
                for row in dbm.db().query("SELECT payload_json FROM chat_event WHERE session_id=?", (sid,)):
                    if '"text_delta"' in row["payload_json"]:
                        deltas += 1
            except Exception as e:
                print("  （直连库数事件失败：" + repr(e)[:80] + "）")

            check(f"乙① 真跑一轮之后，有 {len(asst)} 条 AI 回复落到库里（最长正文 {best} 字 ≥20）",
                  len(asst) >= 1 and best >= 20, f"assistant={len(asst)} 最长={best}")
            check(f"乙② 事件流里有 {deltas} 个 text_delta（≥3 = 真的一点点出字）", deltas >= 3, deltas)
            check("乙③ 没有「编排出错」", not errs,
                  " / ".join(str((e.get("content") or {}).get("preview"))[:120] for e in errs))
            check("乙④ 跑完状态回到 idle", snap["summary"]["status"] == "idle",
                  snap["summary"]["status"])
        finally:
            c.delete(f"/api/agent/sessions/{sid}")
    time.sleep(0.5)
    try:
        from server import db as dbm
        dbm.init(ROOT / "data/app.db")
        left = dbm.db().scalar("SELECT COUNT(*) FROM chat_entry WHERE session_id=?", (sid,), default=-1)
        check("丙 临时会话连条目一起删干净了（测试不留痕）", left == 0, f"剩 {left} 行")
    except Exception as e:
        check("丙 临时会话连条目一起删干净了（测试不留痕）", False, repr(e)[:120])
    return _finish()


def _finish() -> int:
    ok = sum(1 for r in rows if r["ok"])
    OUT.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "force": FORCE or "（正常）",
                               "total": len(rows), "ok": ok,
                               "fails": [r["name"] for r in rows if not r["ok"]], "items": rows},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 编排出字检查 {ok}/{len(rows)} ===")
    print("报告：docs/编排出字实测.json")
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
