#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SSE 事件契约测试：后端 emit 的种类 vs 前端订阅的种类，必须一字不差。

为什么要有这个测试（真踩过的坑）：
    浏览器只把「命名事件」（`event: xxx`）派发给**同名监听器**，`onmessage` 收不到。
    后端 SSE 推实时事件时用的是 `event: <kind>`，所以前端 `addEventListener` 少写一个，
    那一类事件就在界面上**静默消失** —— 不报错、不白屏，就是"某个功能好像没做"。
    2026-09-19 就是这个原因：`api.js` 里漏了 `message_start` 与 `orchestra_*` 四个，
    于是多 Agent 的角色徽章、编排进度在实时那一屏永远出不来（刷新读快照才看得到）。

这个测试扫两边源码，把种类抠出来对比，少一个/多一个都判失败。
用法：server/venv/bin/python tools/verify_sse_contract.py
产出：docs/SSE契约实测.json
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/SSE契约实测.json"

API_JS = ROOT / "frontend/js/api.js"
CHAT_JS = ROOT / "frontend/js/chat.js"
SERVER = ROOT / "server"

# 后端 emit 的种类：events.emit(sid, "kind") / events.emit(sid, 'kind') / emit(sid, "kind")
EMIT_RE = re.compile(r"""emit\(\s*[A-Za-z_][\w.]*\s*,\s*["']([a-z_]+)["']""")

# 前端订阅：api.js 的 SSE_KINDS 名单（唯一出处）+ 兼容老写法 addEventListener('x', ...)
LIST_RE = re.compile(r"const SSE_KINDS = \[(.*?)\];", re.S)
QUOTED_RE = re.compile(r"""["']([a-z_]+)["']""")


def backend_kinds() -> set:
    kinds = set()
    for p in SERVER.rglob("*.py"):
        if any(part in {"venv", "__pycache__", ".pytest_cache"} for part in p.parts):
            continue
        txt = p.read_text(encoding="utf-8", errors="ignore")
        kinds |= set(EMIT_RE.findall(txt))
    return kinds


def frontend_kinds() -> set:
    txt = API_JS.read_text(encoding="utf-8")
    m = LIST_RE.search(txt)
    names = set()
    if m:
        names |= set(QUOTED_RE.findall(m.group(1)))
    names |= set(re.findall(r"""addEventListener\(\s*["']([a-z_]+)["']""", txt))
    # handleEvent 里处理的分支（chat.js）——订阅了但没人处理也是白搭
    handled = set(re.findall(r"""type === ["']([a-z_]+)["']""", CHAT_JS.read_text(encoding="utf-8")))
    return names, handled


def main() -> int:
    be = backend_kinds()
    fe, handled = frontend_kinds()
    # connected / snapshot_required 是前端自己约定/服务端零星发的，不算后端 emit 名单
    extra_ok = {"connected", "snapshot_required"}
    missing = sorted(be - fe)
    unhandled = sorted(be - handled)
    checks = []

    def add(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    add("后端 emit 的事件种类都拿到了", len(be) >= 8, sorted(be))
    add("前端订阅了后端 emit 的每一个种类（少一个就会静默丢事件）",
        not missing, "缺：" + json.dumps(missing, ensure_ascii=False) if missing else "一个不缺")
    add("订阅到的每一种都在 handleEvent 里有分支（订阅了没人处理 = 白订）",
        not unhandled, "没人处理：" + json.dumps(unhandled, ensure_ascii=False) if unhandled else "都有分支")
    add("前端没有订阅后端根本不发的种类（订阅空气 = 骗自己）",
        not (fe - be - extra_ok),
        "多余：" + json.dumps(sorted(fe - be - extra_ok), ensure_ascii=False) if (fe - be - extra_ok) else "没有多余的")
    add("曾经的坑：message_start 必须在名单里（多 Agent 角色徽章靠它）",
        "message_start" in fe, "在" if "message_start" in fe else "不在")
    add("曾经的坑：orchestra_* 四个必须在名单里（编排进度靠它）",
        {"orchestra_run_start", "orchestra_step_start", "orchestra_step_end", "orchestra_run_end"} <= fe,
        sorted(k for k in fe if k.startswith("orchestra_")))

    ok = sum(1 for c in checks if c["ok"])
    OUT.write_text(json.dumps({
        "at": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "backend_kinds": sorted(be), "frontend_subscribed": sorted(fe),
        "frontend_handled": sorted(handled),
        "total": len(checks), "passed": ok, "failed": len(checks) - ok,
        "items": checks,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in checks:
        print(("  ✓ " if c["ok"] else "  ✗ ") + c["name"] + ("" if c["ok"] else "   —— " + str(c["detail"])))
    print(f"\n=== SSE 契约：{ok}/{len(checks)} ===  报告：docs/SSE契约实测.json")
    return 0 if ok == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
