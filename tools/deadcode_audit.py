#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""偷懒自查 · 死代码 / TODO / 占位（第 19 轮）。

为什么有这东西：用户点名"他很多地方是有些偷懒的"。这类偷懒肉眼查不完，所以做成一份**清单**：
  1. 代码里留下的 TODO / FIXME / XXX / 占位 / 临时 / 还没做(db) —— 逐条列出来，看是"该补"还是"该删"；
  2. **定义了但没人用的函数** —— 死代码的典型（写了没人调 = 白写）；
  3. **写了样式但没人用的 class** —— 上一版留下的皮；
  4. 空实现（`{}` 或 `pass`）—— 空壳。

**它不是判官，是账本**：一次跑出来，人（我）逐条看，该删的删、该补的补，
结论写进 docs/偷懒自查.json 的 `verdict` 字段（人工填），别让它自己给自己发合格证。

用法：server/venv/bin/python tools/deadcode_audit.py [-v]
产出：docs/偷懒自查.json
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = sorted((ROOT / "frontend/js").glob("*.js"))
CSS = sorted((ROOT / "frontend/css").glob("*.css"))
# 只查**我们自己写的**后端：venv / site-packages 里的第三方不算（上一版把 PIL 的 FIXME 也抄进来了）
PY = sorted(q for q in (ROOT / "server").rglob("*.py")
            if "venv" not in q.parts and "site-packages" not in q.parts)
# "谁在用"要算上**安卓壳**和**核查脚本**：
#   `bridge` / `media_token`（apk/src/main/python/main.py 在用）、
#   `book_scoped_tables` / `year_len`（tools/ 里那批核查脚本在用）
#   —— 只扫 frontend+server 会把这四个冤枉成"死代码"（上一版就冤枉了）。
OTHER = sorted(list((ROOT / "tools").glob("*.py")) + list((ROOT / "tools").glob("*.js"))
               + list((ROOT / "apk/src").rglob("*.java"))
               + list((ROOT / "apk/src/main/python").rglob("*.py")))
OUT = ROOT / "docs" / "偷懒自查.json"
VERBOSE = "-v" in sys.argv

MARK = re.compile(r"\b(TODO|FIXME|XXX|HACK|占位|临时方案|还没做|待补|先这样|以后再说)\b")
JSFUNC = re.compile(r"^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
JSARROW = re.compile(r"^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>", re.M)
PYFUNC = re.compile(r"^def\s+(_?[A-Za-z][\w]*)\s*\(", re.M)
CLS = re.compile(r"\.([a-zA-Z][\w-]*)")
# 一次把所有标识符数出来，别对每个名字再扫一遍全文 ——
#   上一版是"每个函数名 / 每个 class 名都 re.findall 一遍 1MB 的全站源码"，
#   实测 **200 秒还没跑完**（被 timeout 杀掉，一份报告都出不来）。
#   改成数一遍词频、后面全查表：O(n) 而不是 O(名字数 × n)。
TOKEN = re.compile(r"[A-Za-z_$][\w$-]*")


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def main() -> int:
    rep = {"todos": [], "dead_funcs": [], "dead_css": [], "empty_bodies": []}
    js_all = "\n".join(read(p) for p in JS)
    html = read(ROOT / "frontend/index.html")
    py_all = "\n".join(read(p) for p in PY)
    front_all = js_all + "\n" + html + "\n" + "\n".join(read(p) for p in CSS)
    # 词频表（见 TOKEN 那段的注释：上一版在这里卡了两百秒）
    other_all = "\n".join(read(p) for p in OTHER)
    cnt_front = Counter(TOKEN.findall(front_all))
    cnt_jshtml = Counter(TOKEN.findall(js_all + "\n" + html))
    cnt_py = Counter(TOKEN.findall(py_all + "\n" + other_all))

    # ① TODO / 占位
    for p in JS + CSS + PY:
        for i, line in enumerate(read(p).splitlines(), 1):
            if MARK.search(line):
                rep["todos"].append({"file": str(p.relative_to(ROOT)), "line": i, "text": line.strip()[:140]})

    # ② 定义了没人用的函数（同名出现过 ≥2 次才算"有人用"：定义 1 次 + 调用 ≥1 次）
    for p in JS:
        src = read(p)
        for m in list(JSFUNC.finditer(src)) + list(JSARROW.finditer(src)):
            name = m.group(1)
            if name in ("main", "init", "render"):        # 通用名，可能是别处调
                continue
            if cnt_front[name] <= 1:
                rep["dead_funcs"].append({"file": str(p.relative_to(ROOT)), "name": name})
    for p in PY:
        src = read(p)
        for m in PYFUNC.finditer(src):
            name = m.group(1)
            if cnt_py[name] <= 1:
                rep["dead_funcs"].append({"file": str(p.relative_to(ROOT)), "name": name})

    # ③ 定义了但全站没人用的 class（在 js/html 里搜不到这个名字）
    skip = {"hidden", "on", "active", "cur", "open", "show", "gone", "sm", "lg", "pri", "dan", "add", "del",
            "grow", "more", "auto", "wide", "grid", "stack", "static", "big", "small", "fill", "txt", "pc",
            "meta", "title", "k", "v", "tx", "nm", "tr-ico", "row", "col", "left", "right", "top", "bottom"}
    for p in CSS:
        src = read(p)
        for name in set(CLS.findall(src)):
            if name in skip or name.startswith("webkit") or len(name) < 3:
                continue
            # 名字可能是**拼出来**的（`'lv' + n` → lv1/lv2/lv3）：把末尾数字去掉再看词根。
            stem = re.sub(r'\d+$', '', name)
            if cnt_jshtml[name] == 0 and cnt_jshtml[stem] == 0:
                rep["dead_css"].append({"file": str(p.relative_to(ROOT)), "cls": name})

    # ④ 空实现（函数体是空的 / 只有 pass）
    #    必须带**行号 + 那一行原文**：只给"某文件有个空箭头函数"等于没给，
    #    40 条空壳没法逐条判"是占位该删 / 是"什么都不做"的正当语义"（如 `()=>{}` 当默认回调）。
    for p in JS:
        src = read(p)
        lines = src.splitlines()
        def _at(off, name):
            ln = src.count("\n", 0, off) + 1
            return {"file": str(p.relative_to(ROOT)), "line": ln, "name": name,
                    "snip": (lines[ln - 1].strip()[:110] if 0 < ln <= len(lines) else "")}
        for m in re.finditer(r"function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*\}", src):
            rep["empty_bodies"].append(_at(m.start(), m.group(1)))
        for m in re.finditer(r"=>\s*\{\s*\}", src):
            rep["empty_bodies"].append(_at(m.start(), "空箭头函数"))
    for p in PY:
        for i, line in enumerate(read(p).splitlines(), 1):
            if re.match(r"^\s+pass\s*$", line):
                rep["empty_bodies"].append({"file": str(p.relative_to(ROOT)), "line": i, "name": "pass"})

    for k in ("todos", "dead_funcs", "dead_css", "empty_bodies"):
        rep[k] = rep[k][:400]
    rep["summary"] = {k: len(v) for k, v in rep.items() if isinstance(v, list)}
    OUT.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print("偷懒自查：" + json.dumps(rep["summary"], ensure_ascii=False))
    if VERBOSE:
        for k in ("todos", "dead_funcs", "dead_css", "empty_bodies"):
            print("── " + k)
            for it in rep[k][:60]:
                print("   " + json.dumps(it, ensure_ascii=False))
    else:
        for it in rep["todos"][:20]:
            print("   TODO " + it["file"] + ":" + str(it["line"]) + "  " + it["text"][:80])
    print("→ " + str(OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
