#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""间距/字号/字重 → 设计令牌 的机械替换（治"UI 观感不协调"的第 1 条：间距标尺）。

为什么有这东西：
  用户最新口径（原话）：「UI 视觉元素、主色调、圆角方框组件样式都已经统一，但整体页面观感不协调……
  请你不要修改颜色、圆角、方框样式，重点修正布局系统、间距规范、对齐规则、模块内留白、
  元素相对位置、信息层级权重」，第 1 条就是「建立一套固定间距标尺，所有内边距、外边距严格复用这套数值」。

  这件事**不能靠人眼**：全站 CSS 里有 300 多处 padding/margin/gap 是裸 px。
  裸值看不出来问题（值本身就在标尺上），但它意味着"每个模块自己决定间距" ——
  一旦有人写 14px、18px、36px，全站就散了。所以：
    ① 本脚本把**标尺上的裸值**机械换成 `var(--sp-*)`（不改外观，逐像素等价）；
    ② `tools/verify_layout.py` 之后**只认令牌**，出现标尺外裸值直接报错（可报红）。

用法：
  python3 tools/retokenize.py --dry     # 只看要改多少处
  python3 tools/retokenize.py           # 真改（会打印 leftover：标尺内不存在的值，需人工定夺）
产出：直接改 frontend/css/*.css（tokens.css 除外）与 frontend/js/*.js 里的 style="..."
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DRY = "--dry" in sys.argv

SP = {"4": "--sp-1", "8": "--sp-2", "12": "--sp-3", "16": "--sp-4", "20": "--sp-5",
      "24": "--sp-6", "32": "--sp-8", "40": "--sp-10", "48": "--sp-12", "64": "--sp-16"}
FS = {"11": "--t-xs", "12": "--t-sm", "13": "--t-md", "14.5": "--t-base", "16": "--t-lg",
      "18": "--t-xl", "22": "--t-2xl", "26": "--t-mark-1", "32": "--t-mark-2",
      "44": "--t-mark-3", "64": "--t-mark-4"}
FW = {"400": "--w-normal", "500": "--w-medium", "600": "--w-semi", "700": "--w-bold"}
SP_PROPS = re.compile(r"^(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?$")
DECL = re.compile(r"([-a-z]+)\s*:\s*([^;{}]+)")
NUM = re.compile(r"(-?\d+(?:\.\d+)?)px")
LEFT: dict[str, list[str]] = {}


def map_spacing(val: str, where: str) -> str:
    def one(m):
        n = m.group(1)
        key = n.lstrip("-")
        if key in ("0",):                      # 0 不是间距，别动
            return m.group(0)
        if key in SP:
            t = "var(%s)" % SP[key]
            return "calc(-1 * %s)" % t if n.startswith("-") else t
        if key not in ("1", "2"):
            LEFT.setdefault(key, [])
            if len(LEFT[key]) < 4:
                LEFT[key].append(where)
        return m.group(0)
    return NUM.sub(one, val)


def rewrite_decl(prop: str, val: str, where: str) -> str:
    if SP_PROPS.match(prop):
        return map_spacing(val, where)
    if prop == "font":                 # 简写：font:600 13px/1.2 var(--ui-font) —— 字号在里面
        return NUM.sub(lambda m: "var(%s)" % FS[m.group(1)] if m.group(1) in FS else m.group(0), val)
    if prop == "font-size":
        return NUM.sub(lambda m: "var(%s)" % FS[m.group(1)] if m.group(1) in FS else m.group(0), val)
    if prop == "font-weight" and val.strip() in FW:
        return "var(%s)" % FW[val.strip()]
    return val


def mask_comments(line: str) -> str:
    """把注释换成等长空格：只在外面匹配声明，注释里的数字不动。"""
    out = list(line)
    for m in re.finditer(r"/\*.*?\*/", line):
        for i in range(m.start(), m.end()):
            out[i] = " "
    return "".join(out)


def do_css(path: Path) -> int:
    raw = path.read_text(encoding="utf-8")
    lines = raw.split("\n")
    n = 0
    for i, line in enumerate(lines):
        if "token-ok" in line:
            continue
        masked = mask_comments(line)
        pieces = []
        last = 0
        for m in DECL.finditer(masked):
            prop, val = m.group(1), m.group(2).strip()
            new = rewrite_decl(prop, val, "%s:%d" % (path.name, i + 1))
            if new != val:
                sv = m.start(2) + (len(m.group(2)) - len(m.group(2).lstrip()))
                pieces.append((sv, m.end(2), new))
        if pieces:
            for sv, ev, new in reversed(pieces):
                line = line[:sv] + new + line[ev:]
            lines[i] = line
            n += len(pieces)
    if n and not DRY:
        path.write_text("\n".join(lines), encoding="utf-8")
    return n


def do_js(path: Path) -> int:
    raw = path.read_text(encoding="utf-8")
    lines = raw.split("\n")
    n = 0
    for i, line in enumerate(lines):
        if "token-ok" in line:
            continue
        segs = []
        for m in re.finditer(r"style\s*=\s*[\"'`]([^\"'`]*)", line):
            inner = m.group(1)
            new = inner
            for d in DECL.finditer(inner):
                prop, val = d.group(1), d.group(2).strip()
                nv = rewrite_decl(prop, val, "%s:%d" % (path.name, i + 1))
                if nv != val:
                    sv = m.start(1) + d.start(2)
                    segs.append((sv, m.start(1) + d.end(2), nv))
            if not segs:
                continue
        if segs:
            for sv, ev, nv in reversed(segs):
                line = line[:sv] + nv + line[ev:]
            lines[i] = line
            n += len(segs)
    if n and not DRY:
        path.write_text("\n".join(lines), encoding="utf-8")
    return n


def main() -> int:
    tot = 0
    for f in sorted((ROOT / "frontend" / "css").glob("*.css")):
        if f.name == "tokens.css":         # 令牌自己的定义，不能动
            continue
        c = do_css(f)
        if c:
            print("  %-18s %d 处" % (f.name, c))
        tot += c
    for f in sorted((ROOT / "frontend" / "js").glob("*.js")):
        c = do_js(f)
        if c:
            print("  %-18s %d 处" % ("js/" + f.name, c))
        tot += c
    print(("=== 干跑：会改 %d 处（未落盘）===" if DRY else "=== 已改 %d 处 ===") % tot)
    if LEFT:
        print("标尺上**没有**的值（脚本不动，需人工定夺）：")
        for k in sorted(LEFT, key=lambda x: float(x)):
            print("  · %-6s 在 %s" % (k + "px", "、".join(LEFT[k])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
