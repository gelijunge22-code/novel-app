#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主题对比度体检（WCAG 2.1）——治"浅色小字看不清"。

为什么有这东西：
  第 9 遍打磨发现**三套主题**的次要小字（`--ink-3`）不达标（sepia 3.72 / slate 3.34 / green 4.31），
  夜间主题的**白字压主色按钮**只有 2.41:1。这些都是"看得见但看不清"的毛病，
  以前靠肉眼 + 临时脚本，现在做成常驻判据：**动了 CSS 就跑它**。

判什么（两种）：
  A. 主题变量矩阵：`--ink` / `--ink-2` / `--ink-3` × `--card` / `--paper`，以及
     `--on-accent`（压在主色块上的文字）× 各主题 `--accent`。
     门槛：正文 7.0（AAA）、小字 4.5（AA）。
  B. CSS 里的**硬编码颜色**：把每个声明块当成"前景色 + 底色"的一对来算，
     底色能静态解析（var/hex/rgba/渐变）就判，判不了就如实列成"待人工看"，不硬凑结论。
     字号 ≥24px（或粗体 ≥18.7px）按"大字"放宽到 3.0:1 —— WCAG 就是这么规定的。

用法：
    server/venv/bin/python tools/verify_contrast.py        # 打印 + 断言
    server/venv/bin/python tools/verify_contrast.py -v     # 连通过项也逐条打印
产出：docs/主题对比度实测.json
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS_DIR = ROOT / "frontend" / "css"
BASE = CSS_DIR / "base.css"
OUT = ROOT / "docs" / "主题对比度实测.json"
VERBOSE = "-v" in sys.argv

# 主题变量矩阵： (前景变量, 底色变量, 门槛, 说明)
VAR_PAIRS = [
    ("--ink", "--card", 7.0, "正文 / 卡片"),
    ("--ink", "--paper", 7.0, "正文 / 页面底"),
    ("--ink-2", "--card", 4.5, "次要文字 / 卡片"),
    ("--ink-2", "--paper", 4.5, "次要文字 / 页面底"),
    ("--ink-3", "--card", 4.5, "最淡小字 / 卡片"),
    ("--ink-3", "--paper", 4.5, "最淡小字 / 页面底"),
    ("--on-accent", "--accent", 4.5, "主色块上的字 / 主色底"),
    ("--danger", "--card", 4.5, "告警红 / 卡片"),
    ("--ok", "--card", 4.5, "达标绿 / 卡片"),
    ("--warn", "--card", 4.5, "琥珀黄 / 卡片"),
]

# 语义色的"浅底胶囊"（评分三段 / 状态标记）：前景压在**半透明底 compositing 到卡片上**之后
# 再算 —— 这是最容易漏的一处，也是本轮真抓到的（11px 小字，底还是同色系浅色，越浅越糊）。
TINT_PAIRS = [
    ("--ok", "--ok-soft", 4.5, "评分绿字 / 绿浅底"),
    ("--warn", "--warn-soft", 4.5, "评分黄字 / 黄浅底"),
    ("--danger", "--danger-soft", 4.5, "评分红字 / 红浅底"),
]


# ────────────────────────── 颜色基础 ──────────────────────────
def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _lin(c: float) -> float:
    s = c / 255.0
    return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4


def luminance(hexcolor: str) -> float:
    r, g, b = (_lin(x) for x in hex_to_rgb(hexcolor))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def hsl_to_hex(h: float, s: float, l: float) -> str:
    s, l = s / 100.0, l / 100.0
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = l - c / 2
    rgb = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][int(h // 60) % 6]
    return "#%02x%02x%02x" % tuple(round((v + m) * 255) for v in rgb)


def over(fg_rgba: str, backdrop: str) -> str:
    """把 rgba(...) 压在某个底色上，算出合成后的实色（判断半透明遮罩用）。"""
    m = re.match(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)", fg_rgba)
    if not m:
        return backdrop
    r, g, b = (float(m.group(i)) for i in (1, 2, 3))
    a = float(m.group(4)) if m.group(4) is not None else 1.0
    br, bg, bb = hex_to_rgb(backdrop)
    mix = lambda f, k: round(f * a + k * (1 - a))
    return "#%02x%02x%02x" % (mix(r, br), mix(g, bg), mix(b, bb))


# ────────────────────────── CSS 解析 ──────────────────────────
def theme_blocks(css: str) -> dict[str, dict[str, str]]:
    """`:root{}` 打底，各 `html[data-theme="x"]{}` 叠加。"""
    out: dict[str, dict[str, str]] = {}
    head = css.split("html[data-theme=")[0]
    out["paper"] = {k: v.strip() for k, v in re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;}]+)", head)}
    for m in re.finditer(r'html\[data-theme="([a-z]+)"\]\s*\{(.*?)\n\}', css, re.S):
        vals = {k: v.strip() for k, v in re.findall(r"(--[a-z0-9-]+)\s*:\s*([^;}]+)", m.group(2))}
        merged = dict(out["paper"])
        merged.update(vals)
        out[m.group(1)] = merged
    return out


DECL_BLOCKS = re.compile(r"(?P<sel>[^{}\n]*?)\{(?P<body>[^{}]*)\}", re.S)


def decls_of(body: str) -> dict[str, str]:
    out = {}
    for piece in body.split(";"):
        if ":" not in piece:
            continue
        k, v = piece.split(":", 1)
        out[k.strip().lower()] = v.strip()
    return out


def backdrop_options(value: str, theme: dict[str, str]) -> list[str]:
    """把一个 background 值解析成"可能的底色集合"（渐变就每个色标都算一个 → 取最差那个）。"""
    value = value.strip()
    if not value:
        return []
    # var(--x)
    m = re.fullmatch(r"var\((--[a-z0-9-]+)\)", value)
    if m:
        hexv = theme.get(m.group(1), "")
        return [hexv] if re.fullmatch(r"#[0-9a-fA-F]{3,6}", hexv) else []
    if "gradient(" in value:
        # 多层渐变：CSS 是"先写的画在上面"，所以真正决定亮度的是**最后一层**
        layers = re.split(r",(?![^()]*\))", value)
        value = layers[-1].strip()
    value = re.sub(r"var\(--h\s*,\s*([\d.]+)\)", r"\1", value)     # 书脊的色相变量给个默认值
    colors = re.findall(r"#[0-9a-fA-F]{3,6}|rgba?\([^)]*\)|hsla?\([^)]*\)", value)
    out = []
    for c in colors:
        if c.startswith("#"):
            out.append(c)
        elif c.startswith("rgb"):
            a = re.search(r",\s*([\d.]+)\s*\)", c)
            if a and float(a.group(1)) < 1:      # 半透明底：压在卡片和页面底上各算一次（取更差）
                out.append(over(c, theme.get("--card", "#ffffff")))
                out.append(over(c, theme.get("--paper", "#ffffff")))
            else:
                out.append(over(c, theme.get("--paper", "#ffffff")))
        else:
            hm = re.match(r"hsl\(([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%\)", c)
            if hm:
                out.append(hsl_to_hex(float(hm.group(1)), float(hm.group(2)), float(hm.group(3))))
    return out


def text_size(decls: dict[str, str]) -> float:
    m = re.search(r"([\d.]+)px", decls.get("font-size", ""))
    return float(m.group(1)) if m else 14.0


def need_for(decls: dict[str, str]) -> float:
    size = text_size(decls)
    bold = decls.get("font-weight", "").strip() in ("600", "700", "800", "900", "bold")
    if size >= 24 or (bold and size >= 18.7):
        return 3.0            # WCAG「大字」放宽档
    return 4.5


# ────────────────────────── 主流程 ──────────────────────────
def main() -> int:
    themes = theme_blocks(BASE.read_text(encoding="utf-8"))
    rows, fails = [], []

    print("=" * 78)
    print("A. 主题变量矩阵（正文要 7.0，小字/彩色标记要 4.5）")
    print("=" * 78)
    for name, vs in themes.items():
        print(f"\n【{name}】 card={vs.get('--card')}  paper={vs.get('--paper')}  accent={vs.get('--accent')}")
        for fg, bg, need, label in VAR_PAIRS:
            if fg not in vs or bg not in vs or not vs[fg].startswith("#"):
                continue
            ratio = contrast(vs[fg], vs[bg])
            ok = ratio >= need
            rows.append({"组": "变量", "主题": name, "说明": label, "前景": vs[fg],
                         "底色": vs[bg], "对比度": round(ratio, 2), "门槛": need, "通过": ok})
            if not ok:
                fails.append({"组": "变量", "主题": name, "说明": label, "前景": vs[fg],
                              "底色": vs[bg], "对比度": round(ratio, 2), "门槛": need})
            if ok and not VERBOSE:
                continue
            print(f"   {'OK  ' if ok else 'FAIL'} {vs[fg]} on {vs[bg]}  {ratio:5.2f}:1 (要 {need}) {label}")

    print("\n" + "=" * 78)
    print("A2. 语义色胶囊（浅底是半透明的，先合成到卡片上再算）")
    print("=" * 78)
    for name, vs in themes.items():
        for fg, bg, need, label in TINT_PAIRS:
            if fg not in vs or bg not in vs:
                continue
            base = over(vs[bg], vs["--card"])
            ratio = contrast(vs[fg], base)
            ok = ratio >= need
            rows.append({"组": "胶囊", "主题": name, "说明": label, "前景": vs[fg],
                         "底色": f"{base}（{vs[bg]} 合成到 {vs['--card']}）",
                         "对比度": round(ratio, 2), "门槛": need, "通过": ok})
            if not ok:
                fails.append({"组": "胶囊", "主题": name, "说明": label, "前景": vs[fg],
                              "底色": base, "对比度": round(ratio, 2), "门槛": need})
            if ok and not VERBOSE:
                continue
            print(f"   {'OK  ' if ok else 'FAIL'} [{name}] {vs[fg]} on {base}  {ratio:5.2f}:1 (要 {need}) {label}")

    print("\n" + "=" * 78)
    print("B. CSS 里硬编码的颜色（不跟主题走的那种）")
    print("=" * 78)
    judged = skipped = 0
    for p in sorted(CSS_DIR.glob("*.css")):
        txt = p.read_text(encoding="utf-8")
        txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.S)          # 注释先去掉，免得把注释里的色号当样式
        for m in DECL_BLOCKS.finditer(txt):
            decls = decls_of(m.group("body"))
            fg = decls.get("color", "")
            if not re.fullmatch(r"#[0-9a-fA-F]{3,6}", fg):
                continue                    # 走变量的交给 A 部分
            bgdecl = decls.get("background") or decls.get("background-color") or ""
            if not bgdecl:
                skipped += 1
                continue                    # 底色是继承来的，静态判不了，不硬凑
            need = need_for(decls)
            worst = None
            for tname, vs in themes.items():
                for bghex in backdrop_options(bgdecl, vs):
                    r = contrast(fg, bghex)
                    if worst is None or r < worst["对比度"]:
                        worst = {"组": "硬编码", "主题": tname, "说明": f"{p.name} · {m.group('sel').strip()[:52]}",
                                 "前景": fg, "底色": bghex, "对比度": round(r, 2), "门槛": need}
            if worst is None:
                skipped += 1
                rows.append({"组": "硬编码", "主题": "-", "说明": f"{p.name} · {m.group('sel').strip()[:52]}",
                             "前景": fg, "底色": bgdecl[:40], "对比度": None, "门槛": need, "通过": None})
                print(f"   ?    {p.name:<12} {m.group('sel').strip()[:44]:<44} 底色是渐变/图片，判不了（人工看）")
                continue
            judged += 1
            ok = worst["对比度"] >= need
            worst["通过"] = ok
            rows.append(worst)
            if not ok:
                fails.append(worst)
            if not ok or VERBOSE:
                print(f"   {'OK  ' if ok else 'FAIL'} {worst['前景']} on {worst['底色']} ({worst['主题']}) "
                      f"{worst['对比度']}:1 (要 {need})  {p.name} · {m.group('sel').strip()[:40]}")
    print(f"   判了 {judged} 条；{skipped} 条底色靠继承/渐变，没法定论（上面列出，人工看）")

    print("\n" + "=" * 78)
    if fails:
        print(f"不达标 {len(fails)} 项：")
        for f in fails:
            print(f"   ✗ {f['主题']} · {f['说明']}  {f['对比度']}:1 < {f['门槛']}")
    else:
        print("全部达标（正文 ≥7.0、小字 ≥4.5、大字 ≥3.0）")
    print("=" * 78)

    OUT.write_text(json.dumps({
        "生成时间": time.strftime("%Y-%m-%d %H:%M:%S"),
        "主题数": len(themes), "判定项": len(rows), "不达标": fails, "明细": rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("报告：", OUT.relative_to(ROOT))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
