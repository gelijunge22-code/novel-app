#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""空间规范机器检查（间距标尺 / 视觉权重表）—— 治用户说的"观感不协调、内在不一致"。

用户原话（这一轮的口径，一字不改）：
  「UI 视觉元素、主色调、圆角方框组件样式都已经统一，但整体页面观感不协调、内在不一致……
   不是颜色、圆角、边框样式问题，是布局排布、留白、元素权重、间距层级、模块呼吸感出问题……
   ① 建立一套固定间距标尺，所有内边距、外边距严格复用这套数值，不要每个模块间距随便写
   ……⑤ 统一信息视觉权重：标题、正文、辅助文字、按钮的大小/占比关系保持全局一致」

这份脚本管的是**静态**能管住的那两条（另外四条靠 DOM 量，见 tools/e2e-layout.js）：

  ① 间距标尺  padding / margin / gap 只能写 `var(--sp-*)`；
               裸 px 一律报错（哪怕 12px 正好在标尺上 —— 裸值 = 这个模块自己决定间距，全站就散了）。
               例外只有：0、1px（hairline）、2px（分段控件内衬）。
               （`token-ok: 原因` 这类注释**不再豁免**：它原来整行跳过，会把同一行里的真裸值一起盖住，
                 第 25 轮实测漏掉了 2 条真裸值。现在它只是给人看的说明。）
  ⑤ 权重表    字号只能用 `var(--t-*)`（含字标 --t-mark-*）/ 阅读正文的 --fs；字重只能用 `var(--w-*)`。
               这样"标题 / 正文 / 辅助文字 / 按钮"四种角色的字号×字重才是全局一致的，不会某屏单独放大。

反证（判据必须先能报红）：LAYOUT_FORCE=bare   往内存里的 CSS 塞一条裸值 → 必须报红。
                        LAYOUT_FORCE=badurl 把装饰纹样的 url() 打回相对地址 → 必须报红。
                        LAYOUT_FORCE=noq    把 orchestra 的 `?` 去掉 → 必须报红。

用法：python3 tools/verify_layout.py [-v]
产出：docs/空间规范实测.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "空间规范实测.json"
VERBOSE = "-v" in sys.argv
NOEXEMPT = bool(os.environ.get("LAYOUT_NOEXEMPT"))   # 自查用：假装所有 token-ok 豁免都不存在，把"被豁免盖住的裸值"全列出来

SP_PROPS = re.compile(r"^(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?$")
DECL = re.compile(r"([-a-z]+)\s*:\s*([^;{}]+)")
NUM = re.compile(r"(-?\d+(?:\.\d+)?)px")
FREE = {"0", "1", "2"}          # 0 不是间距；1px hairline；2px 分段控件内衬
OK_VAR = re.compile(r"var\(--(sp-\d+|page-x|hair|safe-[tb]|tab-h|bar-h|hit|ctl-h|ctl-h-sm|icon-btn|icon-btn-sm|radius[a-z-]*|line[a-z-]*|hair)\)")


def mask_comments(line: str) -> str:
    out = list(line)
    for m in re.finditer(r"/\*.*?\*/", line):
        for i in range(m.start(), m.end()):
            out[i] = " "
    return "".join(out)


def strip_block_comments(text: str) -> str:
    """把**跨行**的块注释也挖空（保留换行，行号不变）。

    第 25 轮踩到的坑：`mask_comments` 是逐行做的，只认得"一行里闭合"的注释；
    `preset.css` 里那条讲"竖排变体内边距"的跨行注释，正文里写着 "16px / 24px"，
    于是被当成声明扫出来 → 静态判据**误报 1 条**（`preset.css:77`）。
    注释不是代码，判据要么全挖干净，要么就会一会儿漏报一会儿误报。
    """
    def repl(m):
        return "".join(ch if ch == "\n" else " " for ch in m.group(0))
    return re.sub(r"/\*.*?\*/", repl, text, flags=re.S)


def check_spacing(prop: str, val: str):
    """返回 (违规原因 或 None, 裸值列表)"""
    v = val.strip()
    if not NUM.search(v):
        return None, []
    # 先看这一条里每个 px 是不是裸的（var(--sp-2) 里没有 "px"，所以只抓裸值）
    bad = []
    for m in NUM.finditer(v):
        n = m.group(1)
        if n.lstrip("-") in FREE:
            continue
        # 只有在"不是 token 的一部分"时才算裸值：var(...) 里的 px 是 fallback，别管
        before = v[: m.start()]
        open_var = before.rfind("var(")
        close_var = before.rfind(")")
        if open_var > close_var:            # 落在 var(...) 里面
            continue
        bad.append(n)
    if not bad:
        return None, []
    return "间距写了裸 px（%s）—— 只能用 var(--sp-*)" % "/".join(b + "px" for b in bad), bad


def check_font(prop: str, val: str):
    v = val.strip()
    if prop == "font":
        # 简写：font:600 13px/1.2 var(--ui-font)。这一条以前是**漏的** ——
        # 于是 tools.css 里塞了 12.5px / 11.5px / 13.5px / 19px 四个阶梯外的字号，
        # 静态查不出来（DOM 判据 tools/e2e-layout.js 抓到了，第 25 轮补上）。
        for m in NUM.finditer(v):
            before = v[: m.start()]
            if before.rfind("var(") > before.rfind(")"):
                continue
            return ("font 简写里的字号是裸值（%spx）—— 只能用 var(--t-*)" % m.group(1)), [m.group(1)]
        return None, []
    if prop == "font-size":
        if "px" not in v:
            return None, []
        for m in NUM.finditer(v):
            before = v[: m.start()]
            if before.rfind("var(") > before.rfind(")"):
                continue
            return "字号写了裸 px（%s）—— 只能用 var(--t-*)（界面阶梯 / 字标）" % m.group(1), [m.group(1)]
        return None, []
    if prop == "font-weight":
        if v in ("bold", "normal", "bolder", "lighter", "inherit"):
            return None, []
        if v.startswith("var(--w-"):
            return None, []
        return "字重写了裸值（%s）—— 只能用 var(--w-*)" % v, [v]
    return None, []


URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)", re.I)


def check_url(code: str):
    """css 里的 url() 只许是 **data: URI**（或片段 #id / var(...)）。
    ✅ 第 41 轮实测抓到的一条真 bug：`decor.css` 里那 6 个装饰纹样的 `url("%3Csvg…")`
       **少了 `data:image/svg+xml,` 前缀** → 浏览器把它当成相对地址，一直在请求
       `/css/%3Csvg…` → **404**。后果是「大背景质感」那一版加的颗粒 / 竹子 / 波纹
       **从来没显示过**（CSS 变量解析成 404 的 URL，背景就是空的），而截图看不出毛病。
    所以这条要机器盯着：以后任何人再写相对 url()，这里就报红。"""
    bad = []
    for m in URL_RE.finditer(code):
        v = m.group(1).strip()
        if v.startswith("data:") or v.startswith("#") or v.startswith("var("):
            continue
        bad.append(v[:40])
    return bad


# ── 「拼 URL 忘了 `?`」这条规则（第 41 轮真踩到）────────────────────────────
QS_LIT = re.compile(r"(['\"])([^'\"]*)\1\s*\+\s*qs\(")


def check_qs(text: str, fname: str, out: list):
    """`'api/xxx' + qs({...})` 里的那一段字面量**必须以 `?` 或 `&` 结尾**。

    ✅ 第 41 轮实测抓到的一条真 bug：`api.js` 的 `orchestra` 写成了
       `nb('api/agent/orchestra' + qs({slug}))` —— **漏了那个 `?`**，
       拼出来是 `/api/agent/orchestra**slug=**xxx` → 后端 404。
       后果：对话页那三个模式（讨论/计划/执行）的名称与说明、以及预设里「干活方式」
       的默认值**从来没取到过**（全被 catch 吞掉、静默回落）——
       这正是用户说的「三档切换像没用」「预设里的东西像儿戏」的根之一。
       全站别处都是 `'?' + qs(...)`，就这一处漏了；所以立这条静态规则盯死它。
    """
    text = strip_block_comments(text)      # 跨行块注释也要挖掉（注释里会写反例）
    for i, line in enumerate(text.split("\n"), 1):
        if line.lstrip().startswith("//") or line.lstrip().startswith("*"):
            continue
        for m in QS_LIT.finditer(line):
            lit = m.group(2)
            if lit.endswith("?") or lit.endswith("&"):
                continue
            out.append({"file": fname, "line": i,
                        "why": "拼 URL 时 `%s` 后面漏了 `?` —— 会拼出 xxxslug=… 这种 404 地址" % lit,
                        "text": line.strip()[:140]})


def scan(text: str, fname: str, out: list):
    ok = 0
    for i, line in enumerate(text.split("\n"), 1):
        if "token-ok" in line:
            if not re.search(r"token-ok:\s*\S", line):
                out.append({"file": fname, "line": i, "why": "token-ok 没写原因", "text": line.strip()})
            if not NOEXEMPT:
                # 第 25 轮改：token-ok 原来会**整行跳过**，于是把同一行里的真裸值一起盖住了 ——
                # 实测 `base.css:195 margin-top:8px` 和 `tools.css:159 gap:4px` 就是这么漏掉的。
                # 现在 token-ok 只当注释（说明"这个 34px 是尺寸不是间距"），**不再豁免任何声明**。
                pass
        code = mask_comments(line)
        for v in check_url(code):
            out.append({"file": fname, "line": i,
                        "why": "url() 是相对地址（%s）—— 只能用 data: URI，否则浏览器会去请求 /css/<…> → 404" % v,
                        "text": line.strip()[:140]})
        for m in DECL.finditer(code):
            prop, val = m.group(1), m.group(2).strip()
            if SP_PROPS.match(prop):
                why, _ = check_spacing(prop, val)
            elif prop in ("font-size", "font-weight", "font"):
                why, _ = check_font(prop, val)
            else:
                continue
            if why:
                out.append({"file": fname, "line": i, "why": why, "text": line.strip()[:140]})
            else:
                ok += 1
    return ok


def main() -> int:
    bad: list[dict] = []
    ok_total = 0
    files = sorted((ROOT / "frontend" / "css").glob("*.css"))
    force = os.environ.get("LAYOUT_FORCE")
    for f in files:
        raw = f.read_text(encoding="utf-8")
        if force == "bare" and f.name == "panels.css":
            raw = raw.replace(".chat-empty{padding:var(--sp-12) var(--sp-5);",
                              ".chat-empty{padding:52px var(--sp-5);", 1)
            raw = raw.replace(".chat-empty{padding:52px 20px;",
                              ".chat-empty{padding:52px 20px;", 1)
            if "52px" not in raw:            # 兜底：无论现在写成什么样，都塞一条裸值进去
                raw = raw.replace("}", "{padding:13px}", 1)
            print("  ⚠ 反证模式 LAYOUT_FORCE=bare：已往 panels.css 塞了一条裸值（必须报红）")
        if force == "badurl" and f.name == "decor.css":
            raw = raw.replace("url(\"data:image/svg+xml,%3Csvg", "url(\"%3Csvg", 1)
            print("  ⚠ 反证模式 LAYOUT_FORCE=badurl：已把装饰纹样的 url() 打回相对地址（必须报红）")
        if raw.count("/*") != raw.count("*/"):
            bad.append({"file": f.name, "line": 1, "why": "注释不成对（注释里不许再写注释符号）", "text": ""})
        ok_total += scan(strip_block_comments(raw), f.name, bad)
    # JS 里内联写的也要查（不然规范只管得住一半）
    if force == "bare":
        (ROOT / "frontend" / "js").joinpath("__force.js").write_text(
            "const x = '<div style=\"padding:13px\"></div>';", encoding="utf-8")
    for f in sorted((ROOT / "frontend" / "js").glob("*.js")):
        raw = f.read_text(encoding="utf-8")
        if f.name == "__force.js":
            pass
        if force == "noq" and f.name == "api.js":
            raw = raw.replace("'api/agent/orchestra?' + qs(", "'api/agent/orchestra' + qs(", 1)
            print("  ⚠ 反证模式 LAYOUT_FORCE=noq：已把 orchestra 的 `?` 去掉（必须报红）")
        check_qs(raw, "js/" + f.name, bad)
        lines = raw.split("\n")
        keep = []
        for i, line in enumerate(lines, 1):
            for m in re.finditer(r"style\s*=\s*[\"'`]([^\"'`]*)", line):
                inner = m.group(1)
                for d in DECL.finditer(inner):
                    prop, val = d.group(1), d.group(2).strip()
                    if SP_PROPS.match(prop):
                        why, _ = check_spacing(prop, val)
                    elif prop in ("font-size", "font-weight", "font"):
                        why, _ = check_font(prop, val)
                    else:
                        continue
                    if why:
                        keep.append({"file": "js/" + f.name, "line": i, "why": why, "text": line.strip()[:140]})
        bad.extend(keep)
        ok_total += 1
    if force == "bare":
        (ROOT / "frontend" / "js" / "__force.js").unlink(missing_ok=True)
    report = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "force": force,
              "checked": ok_total, "violations": bad, "violationCount": len(bad)}
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("=== 空间规范：查了 %d 条声明，超规范 %d 条 ===" % (ok_total, len(bad)))
    by = {}
    for v in bad:
        by[v["why"].split("（")[0]] = by.get(v["why"].split("（")[0], 0) + 1
    for k, n in sorted(by.items(), key=lambda x: -x[1]):
        print("  · %s × %d" % (k, n))
    for v in (bad if VERBOSE else bad[:30]):
        print("  ✗ %s:%d %s\n      %s" % (v["file"], v["line"], v["why"], v["text"]))
    print("报告：docs/空间规范实测.json")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
