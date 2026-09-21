#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""前端体量统计（第 20 轮 · 前端大改的硬指标：新前端 ≥ 基线 × 2）。

为什么单独一个脚本：用户要的是「**用上**双倍的代码量」（好看、华丽、但简约优雅），
不是"把文件写大"。所以这里只做**客观计量**，凑数由另外两条判据拦：
  · 死代码 / 没人用的 CSS  → tools/deadcode_audit.py（必须为 0）
  · 每个新组件/新文件的"在哪个界面被用到" → docs/自审清单.md 的表格

用法：
  python3 tools/size_report.py                 # 报当前体量 + 跟基线比
  python3 tools/size_report.py --save-baseline # 把"改之前"的体量存成基线（只做一次）
  python3 tools/size_report.py --require-double# 没到基线 ×2 就 exit 1（大改收口时用）
产出：docs/前端体量.json（含逐文件明细）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONT = ROOT / "frontend"
BASE = ROOT / "docs" / "前端体量基线.json"
OUT = ROOT / "docs" / "前端体量.json"
KINDS = {".js": "js", ".css": "css", ".html": "html"}


def measure() -> dict:
    files = {}
    for p in sorted(FRONT.rglob("*")):
        if p.is_dir() or p.suffix not in KINDS:
            continue
        b = p.read_bytes()
        files[str(p.relative_to(ROOT))] = {
            "kind": KINDS[p.suffix], "bytes": len(b),
            "lines": b.decode("utf-8", "replace").count("\n") + 1,
        }
    tot = {"js": {"bytes": 0, "lines": 0}, "css": {"bytes": 0, "lines": 0},
           "html": {"bytes": 0, "lines": 0}}
    for v in files.values():
        tot[v["kind"]]["bytes"] += v["bytes"]
        tot[v["kind"]]["lines"] += v["lines"]
    allb = sum(v["bytes"] for v in tot.values())
    alll = sum(v["lines"] for v in tot.values())
    return {"files": files, "by_kind": tot, "total": {"bytes": allb, "lines": alll}}


def main() -> int:
    cur = measure()
    save = "--save-baseline" in sys.argv
    need = "--require-double" in sys.argv
    base = None
    if BASE.exists():
        base = json.loads(BASE.read_text(encoding="utf-8"))

    if save:
        BASE.write_text(json.dumps(cur, ensure_ascii=False, indent=1), encoding="utf-8")
        print("基线已存 → " + str(BASE.relative_to(ROOT)))
        base = cur

    print("当前前端：%d 个文件 / %s 字节（%.1f KB）/ %s 行"
          % (len(cur["files"]), f"{cur['total']['bytes']:,}",
             cur["total"]["bytes"] / 1024, f"{cur['total']['lines']:,}"))
    for k in ("js", "css", "html"):
        v = cur["by_kind"][k]
        print("  %-4s %10s 字节  %7s 行" % (k, f"{v['bytes']:,}", f"{v['lines']:,}"))

    rc = 0
    if base:
        bb, bl = base["total"]["bytes"], base["total"]["lines"]
        print("\n基线   ：%s 字节 / %s 行" % (f"{bb:,}", f"{bl:,}"))
        print("目标 ×2：%s 字节 / %s 行" % (f"{bb * 2:,}", f"{bl * 2:,}"))
        pb = cur["total"]["bytes"] / bb * 100
        pl = cur["total"]["lines"] / bl * 100
        print("当前   ：%.1f%% 字节 / %.1f%% 行" % (pb, pl))
        for k in ("js", "css", "html"):
            print("  %-4s %.1f%% 字节 / %.1f%% 行" % (
                k, cur["by_kind"][k]["bytes"] / base["by_kind"][k]["bytes"] * 100,
                cur["by_kind"][k]["lines"] / base["by_kind"][k]["lines"] * 100))
        if need and (cur["total"]["bytes"] < bb * 2 or cur["total"]["lines"] < bl * 2):
            print("\n✗ 还没到基线的两倍（大改收口时这条必须绿）")
            rc = 1
        elif need:
            print("\n✓ 已到基线的两倍以上")
    if not BASE.exists() and not save:
        print("\n（还没有基线：先跑 --save-baseline 存一份「改之前」的）")
    OUT.write_text(json.dumps({"at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
                               "baseline": base["total"] if base else None, **cur},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n报告：%s" % OUT.relative_to(ROOT))
    return rc


if __name__ == "__main__":
    sys.exit(main())
