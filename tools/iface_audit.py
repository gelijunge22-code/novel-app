#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""有没有"后端做了、用户却点不到"的接口？（第 19 轮）

上一版 `iface_account.py` 只会拿"路径最后两段"在前端源码里找字符串，报出 53 条"候选"，
但里面混着一堆**前端拼地址**的（`API.abs('/write/' + kind)` 这种）和**本来就该只有 App 壳才用**的
（`/health`）。候选名单不逐条核，等于没做 —— 所以这个脚本把"核"这一步也做成可复现的：

  对每个路由（`/api` 前缀 + 装饰器路径）：
    ① 前端 JS/HTML 里**直接出现**过（整条路径、去参后的尾巴、最后一段带引号、'/最后一段'）→ used；
    ② 只在安卓壳（apk/src 的 java）里出现 → shell（App 启动/健康检查这类，本来就不该有网页入口）；
    ③ 两边都没有 → missing（**这才是真候选**，要逐条给结论）。

用法：server/venv/bin/python tools/iface_audit.py [-v]
产出：docs/接口未露面核查.json
"""
from __future__ import annotations
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERBOSE = "-v" in sys.argv


def routes():
    out = []
    for f in sorted((ROOT / "server/routers").glob("*.py")):
        src = f.read_text(encoding="utf-8")
        for m in re.finditer(r'@router\.(get|post|put|delete|patch)\("([^"]+)"', src):
            out.append((m.group(1).upper(), m.group(2), f.name))
    return sorted(set(out), key=lambda x: x[1])


def segs(p):
    return [s for s in p.strip("/").split("/") if s and not s.startswith("{")]


def main() -> int:
    fe = " ".join(p.read_text(encoding="utf-8") for p in (ROOT / "frontend/js").glob("*.js"))
    fe += " " + (ROOT / "frontend/index.html").read_text(encoding="utf-8")
    shell = ""
    for p in (ROOT / "apk/src").rglob("*.java"):
        shell += p.read_text(encoding="utf-8", errors="ignore")
    used, shell_only, missing = [], [], []
    for meth, path, f in routes():
        s = segs(path)
        tail = "/".join(s[-2:]) if len(s) >= 2 else (s[-1] if s else "")
        last = s[-1] if s else ""
        def hit(src):
            if tail and tail in src:
                return True
            if last and (("'" + last + "'") in src or ('"' + last + '"') in src):
                return True
            if last and ("/" + last) in src:
                return True
            return False
        rec = {"method": meth, "path": "/api" + path, "router": f}
        if hit(fe):
            used.append(rec)
        elif hit(shell):
            rec["why"] = "只有安卓壳在用（App 启动/健康检查这类），本来就不该有网页入口"
            shell_only.append(rec)
        else:
            missing.append(rec)
    rep = {"接口总数": len(routes()), "前端在用": len(used),
           "只有壳在用（不需要网页入口）": len(shell_only), "真候选（两边都没有）": len(missing),
           "missing": missing, "shellOnly": shell_only}
    (ROOT / "docs/接口未露面核查.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1),
                                                    encoding="utf-8")
    print("路由 %d 条：前端在用 %d / 只有壳在用 %d / 真候选 %d"
          % (rep["接口总数"], rep["前端在用"], rep["只有壳在用（不需要网页入口）"], rep["真候选（两边都没有）"]))
    for r in (missing if VERBOSE else missing):
        print("  ? %-6s %-42s %s" % (r["method"], r["path"], r["router"]))
    print("报告：docs/接口未露面核查.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
