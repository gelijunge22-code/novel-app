# -*- coding: utf-8 -*-
"""判据：AI 真能"用上"这本书的东西，而且**用户看得见它用了什么**。

用户原话（两条）：
  · 「**弄了那么多模块、那么多工具，AI 必须是写的时候能用到，并且好用、会用才可以**」
  · 「AI 必须真的会用那些模块和工具，并且用户看得见它用了什么」

这个脚本对三件事取证（每条都能报红）：

  甲 真实组装一次 system 提示词（用**真书**的真实数据走 `build_system`），
     断言里面确实带上了：这本书的现状（含**未兑现的伏笔**、已知实体、最近一章结尾）、
     相关记忆、工具协议 —— 这就是"AI 拿到的上下文里有没有这些"的直接证据（打印片段）。
  乙 **工具名全都有中文**：后端能调用的工具（`orchestra.KNOWN_TOOLS`）逐个到前端 `chat.js`
     的 `TOOL_LABEL` 里找人话名字。缺一个，界面上就会露出 `promise_list` 这种英文函数名
     —— 用户明确反感"不正经/看不懂"。这条以前是**真出过**的（编排那套工具漏登记）。
  丙 真跑一次「计划」模式：每一步在库里都要留下"它看得见什么 / 它能用什么工具"
     （`orchestra_step.sees_json` / `tools_json` 非空）—— 用户要的"看得见"就是这个账。

用法：server/venv/bin/python tools/check_ai_context.py
      AICHECK_DROP=promise_list ...   # 反证：假装"新加了工具但忘了给它中文名" → 乙 必须红
产出：docs/AI用工具实测.json（反证写 -反证-<名字>.json）
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import db as dbm                        # noqa: E402
from server.engine import orchestra                 # noqa: E402
from server.engine.agent_runtime import _memory_hits   # noqa: E402
from server.llm.prompts import build_system         # noqa: E402
from server.llm.prompts import preset_values       # noqa: E402  (真实预设值)
from server.store import P                          # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BOOK = os.environ.get("AICHECK_BOOK") or "example-book"


def main() -> int:
    dbm.init(P.db)
    d = dbm.db()
    problems, steps = [], []

    # ── 甲：上下文里真带着这本书的东西 ────────────────────────────────
    ask = "林诺在木牌一零八之后该往哪走？前面挖的坑还没填的还有哪些？"
    hits = _memory_hits(BOOK, ask)
    try:
        values = preset_values(BOOK) or {}
    except Exception:
        values = {}
    system = build_system("leader.default", BOOK, values, memory_hits=hits)
    pend = d.scalar("SELECT COUNT(*) FROM promise WHERE slug=? AND status!='paid'", (BOOK,)) or 0
    ents = d.scalar("SELECT COUNT(*) FROM entity WHERE slug=?", (BOOK,)) or 0
    mem = d.scalar("SELECT COUNT(*) FROM memory WHERE slug=?", (BOOK,)) or 0
    # ⚠ 判据要诚实：库里没有的东西（0 条伏笔 / 0 条记忆）不能靠"顺带出现在别处"就算过 ——
    # 那种 pass 是假绿。没有就记 N/A（不算通过也不算失败），有就**必须真带上**。
    want = {
        "这本书的现状": "【这本书的现状】" in system,
        "未兑现的伏笔": ("未兑现的伏笔：\n" in system) if pend else "N/A（库里 0 条）",
        "已知实体": ("已知实体：\n" in system) if ents else "N/A（库里 0 条）",
        "最近一章结尾": "最近一章" in system,
        "相关记忆": ("【相关记忆】" in system) if hits else "N/A（这次没命中）",
        "工具协议": ("工具" in system and "promise_list" in system),
    }
    seg = {}
    for k, marker in (("现状", "【这本书的现状】"), ("记忆", "【相关记忆】"), ("工具", "promise_list")):
        i = system.find(marker)
        seg[k] = system[i:i + 220].replace("\n", " ⏎ ") if i >= 0 else ""
    ok_a = all(v is True or (isinstance(v, str) and v.startswith("N/A")) for v in want.values())
    steps.append({"step": "甲 上下文里带着这本书的东西", "expect": "现状/伏笔/实体/记忆/工具都在",
                  "res": {"want": want, "库里": {"伏笔": pend, "实体": ents, "记忆": mem},
                          "记忆命中": len(hits), "system 字数": len(system), "片段": seg},
                  "ok": ok_a})
    if not ok_a:
        problems.append("甲 上下文缺东西：%s" % [k for k, v in want.items() if v is False])

    # ── 乙：后端工具 → 前端必须有中文名 ──────────────────────────────
    js = (ROOT / "frontend/js/chat.js").read_text(encoding="utf-8")
    blk = js[js.index("const TOOL_LABEL"):]
    blk = blk[:blk.index("};")]
    labels = set()
    for line in blk.splitlines()[1:]:
        for part in line.split(","):
            if ":" in part and "'" in part:
                labels.add(part.split(":")[0].strip().strip("'\""))
    drop = os.environ.get("AICHECK_DROP")
    if drop:
        labels.discard(drop)                     # 反证：假装忘了给这个工具起中文名
    tools = sorted(orchestra.KNOWN_TOOLS)
    missing = [t for t in tools if t not in labels]
    ok_b = not missing
    steps.append({"step": "乙 每个工具都有中文名", "expect": "后端工具全部在前端 TOOL_LABEL 里",
                  "res": {"tools": len(tools), "labelled": len([t for t in tools if t in labels]),
                          "missing": missing, "drop": drop or ""}, "ok": ok_b})
    if not ok_b:
        problems.append("乙 这些工具界面上会露出英文名：%s" % missing)

    # ── 丙：真跑一次「计划」，库里要留下"它看得见什么/能用什么" ─────────
    rows = d.query("SELECT * FROM orchestra_step ORDER BY id DESC LIMIT 6")
    live = []
    for r in rows:
        live.append({"run_id": r["run_id"], "seq": r["seq"], "role_name": r["role_name"],
                     "sees": d.jloads(r["sees_json"], []), "tools": d.jloads(r["tools_json"], []),
                     "handoff_from": r["handoff_from"] or ""})
    with_sees = [x for x in live if x["sees"] and x["tools"]]
    ok_c = len(with_sees) >= 1
    steps.append({"step": "丙 每一步都记了「看得见什么/用什么工具」",
                  "expect": "最近几步的 sees/tools 非空（可复查）",
                  "res": {"recent": len(live), "withSees": len(with_sees),
                          "sample": with_sees[0] if with_sees else (live[0] if live else {})}, "ok": ok_c})
    if not ok_c:
        problems.append("丙 编排步骤没有留下 sees/tools 记录（用户没法复查 AI 看见了什么）")

    rep = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "book": BOOK,
           "steps": steps, "problems": problems}
    name = "docs/AI用工具实测.json"
    if os.environ.get("AICHECK_DROP"):
        name = "docs/AI用工具实测-反证-工具没中文名.json"
    (ROOT / name).write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    for s in steps:
        print(("  ✓ " if s["ok"] else "  ✗ ") + s["step"] + " —— " + s["expect"])
        print("      " + json.dumps(s["res"], ensure_ascii=False)[:300])
    print(("\n全过 ✅" if not problems else "\n有红 ❌ " + "；".join(problems)) + "  → " + name)
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
