#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设计规范机器检查（圆角 / 间距 / 字号）—— 治"UI 不统一"。

为什么有这东西：
  用户原话：「UI 不统一就会很丑」「别的地方都是四角微微弧形的正方形，但这四个选项全是圆的」。
  规范写在文档里没用，必须**能被机器查**：超规范的值一律报错，改到 0 才放行。

规范（写在 frontend/css/base.css 顶部，这里同步一份）：
  圆角  只认 5 个 token + 正圆：
        var(--radius) 容器/卡片 · var(--radius-sm) 按钮/选项/输入 · var(--radius-xs) 小徽标
        var(--radius-sheet) 底部弹层顶角 · var(--radius-pill) 真胶囊语义（标签/开关/进度条/toast）
        50% 只给图标按钮/头像/圆点/转圈
  间距  padding / margin / gap 必须是 4 的倍数（0,4,8,12,16,20,24,…）；
        1px / 2px 只允许做 hairline 与"半个格子"的微调（要写注释说明）
  字号  阶梯：11 / 12 / 13 / 14 / 15 / 17 / 20（界面）+ 24 / 30 / 40 / 56（字标，如启动页）

例外：该行写 `/* token-ok: 原因 */` 就跳过（原因不能为空）—— 例外必须留下理由，不能默默放行。

用法：python3 tools/verify_tokens.py [-v]
产出：docs/设计规范实测.json
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS_DIR = ROOT / "frontend" / "css"
OUT = ROOT / "docs" / "设计规范实测.json"
VERBOSE = "-v" in sys.argv

RADII = {"var(--radius)", "var(--radius-sm)", "var(--radius-xs)", "var(--radius-sheet)",
         "var(--radius-pill)", "50%", "0", "inherit"}
# 第 42 轮整体收一档：14.5/16/18/22 → 14/15/17/20，字标 26/32/44/64 → 24/30/40/56
# （底部三档 11/12/13 不动 —— 再小就低于可读下限）
FONTS = {11.0, 12.0, 13.0, 14.0, 15.0, 17.0, 20.0, 24.0, 30.0, 40.0, 56.0}
SPACING_ALLOW = {1.0, 2.0}          # hairline / 半格微调（必须写注释）
SKIP_FILES = set()

DECL = re.compile(r"([-a-z]+)\s*:\s*([^;{}]+)")


def nums(v: str):
    return [float(x) for x in re.findall(r"(-?\d+(?:\.\d+)?)px", v)]


def check_radius(v: str):
    v = v.strip()
    if v in RADII:
        return None
    parts = v.split()
    if 1 < len(parts) <= 4 and all(p in RADII for p in parts):
        return None                       # 多值：每一角都得是规范值（如 "var(--radius) var(--radius) 0 0"）
    return f"圆角 {v!r} 不在规范里（用 var(--radius*)/50%）"


def check_spacing(prop: str, v: str):
    if not re.match(r"^(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?$", prop):
        return None
    if "var(" in v or "calc(" in v or "%" in v or "auto" in v or "em" in v:
        return None
    bad = []
    for n in nums(v):
        if n == 0 or n in SPACING_ALLOW:
            continue
        if n % 4 != 0:
            bad.append(n)
    if bad:
        return f"间距 {v!r} 不是 4 的倍数（{bad}）"
    return None


def check_font(v: str):
    if "var(" in v or "calc(" in v or "em" in v or "%" in v:
        return None
    ns = nums(v)
    if not ns:
        return None
    n = ns[0]
    if n not in FONTS:
        return f"字号 {v!r} 不在阶梯里（{sorted(FONTS)}）"
    return None


def check_swatches(raw: str):
    """主题色卡（tokens.css 的 .sw-*）必须跟主题块里的 --paper 同值。

    为什么单独查这一条：用户说「调整体颜色那种也不是很好看，有点乱」，
    所以"选主题"那一排要带**色块**。色块的颜色只有跟主题真正的纸色一致才有意义 ——
    同值写两份正是本项目最恨的"两套值打架"。这里把两份对起来，不一致就报红。
    """
    probs = []
    themes = {}
    # 文件头上那个 :root{...} 就是**默认那一套**（= 米黄 / paper）——
    # 它的 --paper 不写在 html[data-theme="paper"] 里，要单独收一份，
    # 否则色卡对账时会以为「paper 这一套没有纸色」。
    rm = re.search(r":root\{([^}]*)\}", raw)
    if rm:
        pm = re.search(r"--paper:\s*(#[0-9a-fA-F]{3,6})", rm.group(1))
        if pm:
            themes["paper"] = pm.group(1).lower()
    for m in re.finditer(r'html\[data-theme="([a-z]+)"\]\{([^}]*)\}', raw):
        pm = re.search(r"--paper:\s*(#[0-9a-fA-F]{3,6})", m.group(2))
        if pm:
            themes[m.group(1)] = pm.group(1).lower()
    sw = {}
    for m in re.finditer(r"\.sw-([a-z]+)\{background:(#[0-9a-fA-F]{3,6})\}", raw):
        sw[m.group(1)] = m.group(2).lower()
    for k, v in sw.items():
        if k in themes and themes[k] != v:
            probs.append({"file": "tokens.css", "line": 1,
                          "why": f"色卡 .sw-{k} 是 {v}，可主题 {k} 的 --paper 是 {themes[k]}（两套值打架）",
                          "text": f".sw-{k}{{background:{v}}}"})
    # 「系统」那一格：斜切的两半必须是 paper / night 的纸色
    am = re.search(r"\.sw-auto\{background:linear-gradient\(135deg,(#[0-9a-fA-F]{3,6}) 0 50%,(#[0-9a-fA-F]{3,6}) 50% 100%\)\}", raw)
    if not am:
        probs.append({"file": "tokens.css", "line": 1, "why": "少了「系统」那格的色卡（.sw-auto）", "text": ""})
    else:
        a, b = am.group(1).lower(), am.group(2).lower()
        if a != themes.get("paper") or b != themes.get("night"):
            probs.append({"file": "tokens.css", "line": 1,
                          "why": f".sw-auto 的斜切是 {a}/{b}，应当等于 paper/night 的纸色"
                                 f"（{themes.get('paper')}/{themes.get('night')}）", "text": ""})
    return probs, sorted(themes), sorted(sw)


def main() -> int:
    bad: list[dict] = []
    ok_n = 0
    files = sorted(p for p in CSS_DIR.glob("*.css") if p.name not in SKIP_FILES)
    for f in files:
        raw = f.read_text(encoding="utf-8")
        # 注释必须成对：注释里再写 `/*`/`*/` 会把外面那层提前闭合，
        # 后面整段（可能包含 :root 变量）会被浏览器当垃圾丢掉 —— 第 12 轮真踩过这个坑：
        # 我在文件头注释里写了 token-ok 的写法，结果整个 :root 被吞掉，--tab-h 变空，
        # 全站 padding-bottom 掉成 0（e2e-layout 立刻报红）。
        if raw.count("/*") != raw.count("*/"):
            bad.append({"file": f.name, "line": 1,
                        "why": f"注释不成对（/* {raw.count('/*')} 个 vs */ {raw.count('*/')} 个）——注释里不许再写注释符号",
                        "text": ""})
        txt = raw.splitlines()
        for i, line in enumerate(txt, 1):
            if "token-ok" in line:
                if not re.search(r"token-ok:\s*\S", line):
                    bad.append({"file": f.name, "line": i, "why": "token-ok 没写原因", "text": line.strip()})
                continue
            code = line.split("/*")[0]
            for m in DECL.finditer(code):
                prop, val = m.group(1), m.group(2).strip()
                why = None
                if prop == "border-radius":
                    why = check_radius(val)
                elif prop.startswith("font-size") or prop == "font":
                    why = check_font(val)
                else:
                    why = check_spacing(prop, val)
                if why:
                    bad.append({"file": f.name, "line": i, "why": why, "text": line.strip()})
                else:
                    ok_n += 1
    # 主题色卡跟主题块对账（色块颜色必须就是那套主题的纸色）
    tokens_raw = (CSS_DIR / "tokens.css").read_text(encoding="utf-8")
    # 反证：SWATCH_FORCE=mismatch 把色卡改成一个错的值 —— 这一条**必须报红**，
    # 不然"色卡跟主题对账"就是一句空话（判据不能自己永远绿）。
    if os.environ.get("SWATCH_FORCE") == "mismatch":
        tokens_raw = re.sub(r"\.sw-slate\{background:#[0-9a-fA-F]{6}\}", ".sw-slate{background:#123456}", tokens_raw)
        tokens_raw = re.sub(r"\.sw-auto\{background:linear-gradient\(135deg,#[0-9a-fA-F]{6}",
                            ".sw-auto{background:linear-gradient(135deg,#abcdef", tokens_raw)
        print("  ⚠ 反证模式 SWATCH_FORCE=mismatch：已把 .sw-slate / .sw-auto 改成错的值（必须报红）")
    sw_probs, themes_seen, sw_seen = check_swatches(tokens_raw)
    bad.extend(sw_probs)
    # JS 里内联写的也要查（不然规范只管得住一半）
    js_bad = []
    for f in sorted((ROOT / "frontend" / "js").glob("*.js")):
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if "token-ok" in line:
                continue
            for m in re.finditer(r"style\s*=\s*[\"'`]([^\"'`]*)", line):
                for d in DECL.finditer(m.group(1)):
                    prop, val = d.group(1), d.group(2).strip()
                    if prop == "border-radius":
                        why = check_radius(val)
                    elif prop.startswith("font-size"):
                        why = check_font(val)
                    else:
                        why = check_spacing(prop, val)
                    if why:
                        js_bad.append({"file": "js/" + f.name, "line": i, "why": why, "text": line.strip()[:120]})
    report = {"at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
              "cssFiles": [f.name for f in files], "checkedDecls": ok_n,
              "themeSwatches": {"themes": themes_seen, "swatches": sw_seen, "checked": len(sw_seen)},
              "violations": bad + js_bad, "violationCount": len(bad) + len(js_bad)}
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"=== 设计规范检查：查了 {ok_n} 条声明 + {len(sw_seen)} 张主题色卡，超规范 {report['violationCount']} 条 ===")
    by_why = {}
    for v in report["violations"]:
        key = v["why"].split("（")[0]
        by_why[key] = by_why.get(key, 0) + 1
    if VERBOSE:
        for v in report["violations"]:
            print(f"  ✗ {v['file']}:{v['line']} {v['why']}\n      {v['text']}")
    else:
        for k, n in sorted(by_why.items(), key=lambda x: -x[1]):
            print(f"  · {k} × {n}")
        for v in report["violations"][:25]:
            print(f"  ✗ {v['file']}:{v['line']} {v['why']}")
    print("报告：docs/设计规范实测.json")
    return 0 if not report["violations"] else 1


if __name__ == "__main__":
    sys.exit(main())
