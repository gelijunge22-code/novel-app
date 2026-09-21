#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""判据脚手架自检：**长得慢的探针必须自己声明超时**。

为什么要有这条（第 30 轮的真事）：
  `tools/cdp.js` 第 29 轮给所有探针加了 20 秒默认超时 —— 那是为了治"探针永远不 settle、
  脚本一声不吭僵死 4 分钟"。可这一刀也砍到了**本来就要等很久**的探针：
  `e2e-chatstream.js` 里那条"在界面里发一句话、最多等 90 秒出字"的探针，
  默认 20 秒就被掐断 → **明明功能是好的，判据报红**（假红），而且脚本当场崩掉、
  连报告都写不出来。第一次跑就被它骗了一回。

规矩（这份脚本按它判红）：
  1. 探针体里只要出现 `for (... i < N ...)` 且 N ≥ 40（≈ 各脚本里 200ms/500ms 的步进，
     也就是"可能要等 8 秒以上"），就**必须**在调用处显式给超时：
        s.js(「探针」, 150000) 或 jsSafe(「探针」, 150000)
  2. 显式超时必须 ≥ 探针自己声明的等待上限（这里只做粗判：≥ 30000）。
  3. `catch` 掉探针超时的脚本才算安全 —— 超时应当**进报告判红**，不是把脚本带崩。

跑法：server/venv/bin/python tools/check_probe_timeouts.py
反证：PROBE_TF_FORCE=bad 会在内存里塞一段"慢探针没给超时"的样本，必须报红。
产出：docs/探针超时自检.json
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/探针超时自检.json"
CALL = re.compile(r"\b(?:s\.js|jsSafe)\s*\(\s*`")          # 只认模板串形式的探针
LOOP = re.compile(r"\bi\s*<\s*(\d+)")
MIN_LOOP = 40            # 循环次数 ≥ 40 视为"可能等很久"
MIN_TIMEOUT = 30000      # 显式超时至少要 30 秒


def probe_spans(text: str):
    """切出每一段 `js(`...`)` 模板串（模板串里不会再嵌模板串，按反引号切就够）。"""
    out = []
    for m in CALL.finditer(text):
        start = m.end()
        end = text.find("`", start)
        if end < 0:
            continue
        out.append((start, end, text[start:end], text[end + 1:end + 60]))
    return out


def scan(name: str, text: str) -> list[dict]:
    bad = []
    for start, end, body, tail in probe_spans(text):
        loops = [int(x) for x in LOOP.findall(body)]
        slow = max(loops) if loops else 0
        if slow < MIN_LOOP:
            continue
        to = re.match(r"\s*,\s*(\d+)", tail)                   # `, 150000)`
        if not to and "jsSafe" not in text[max(0, start - 12):start]:
            bad.append({"file": name, "line": text[:start].count("\n") + 1, "loop": slow,
                        "why": "探针里有 %d 次循环（可能等 10 秒以上），但调用处没写显式超时" % slow})
            continue
        if to and int(to.group(1)) < MIN_TIMEOUT:
            bad.append({"file": name, "line": text[:start].count("\n") + 1, "loop": slow,
                        "why": "显式超时 %s ms 太短（< %d）" % (to.group(1), MIN_TIMEOUT)})
    return bad


def main() -> int:
    files = sorted((ROOT / "tools").glob("e2e-*.js"))
    bad: list[dict] = []
    checked = 0
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        checked += len(probe_spans(text))
        bad += scan(f.name, text)
    if os.environ.get("PROBE_TF_FORCE") == "bad":
        bad += scan("（反证样本）", "const r = await s.js(`(async () => {\n"
                                    "  for (let i = 0; i < 180; i++) { await new Promise((r) => setTimeout(r, 500)); }\n"
                                    "  return 1; })()`);\n")
    rep = {"files": len(files), "probes": checked, "minLoop": MIN_LOOP,
           "minTimeout": MIN_TIMEOUT, "violations": bad}
    OUT.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    for b in bad:
        print("  ✗ %s:%s  %s（循环 %s 次）" % (b["file"], b["line"], b["why"], b["loop"]))
    print("=== 探针超时自检：%d 个文件 / %d 个探针 → %d 条违规 ===" % (len(files), checked, len(bad)))
    print("报告：%s" % OUT.relative_to(ROOT))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
