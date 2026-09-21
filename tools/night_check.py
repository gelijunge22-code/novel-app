#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""夜间/日间全站体检 —— 判定（第 19 轮）。

为什么有这东西：
  用户报过两次"夜间环境下最明显"的毛病。`tools/verify_contrast.py` 只静态扫 CSS 变量，
  看不到"真画到屏上的每个面板/弹层/状态"。`tools/e2e-night.js` 负责真打开真截图真探针，
  这个脚本负责**判定**，而且要**从截图像素里再量一遍**：
  只信 getComputedStyle 会骗自己 —— 渐变底/封面图/半透明蒙层都会让"算出来的底色"跟真画的不一样。

判两条（两条都要过）：
  A. 页面侧（getComputedStyle）：每个可见文字叶节点的前景色 × 它真正压着的底色 → WCAG 2.1 对比度。
  B. 像素侧（截图裁剪该节点矩形）：最常见色 = 真底、最偏离底的色 = 真字 → 真对比度。
  **以 B 为准**（B 才是用户眼睛看到的）；A 跟 B 差得远时记一笔"渐变/图底"，
  但 A 说"看不清楚"而 B 量不出来（图太小）时按 A 判 —— 两边都不放过。

门槛（WCAG 2.1 AA，跟 docs/设计规范.md 一致）：
  正文（>13px 且非大字）    4.5:1
  大字（≥24px，或 ≥18.7px 粗体）  3.0:1
  次要小字（≤13px：角标/徽标/说明行）  3.0:1
  —— 这三档是"用户点名的夜间看不清"最常见的落点，别偷偷放宽。

另外还判（防"假绿"）：
  · 每张截图必须存在；同一组日间/夜间不许逐字节相同（= 主题根本没生效）；
  · 每屏必须量到 ≥minText 个文字节点（0 个 = 探针没生效或这一屏是空的，绿了也不算）；
  · 探针记录的 theme 必须等于本组要求的 theme（不然量的是另一套主题，判红）。

用法：server/venv/bin/python tools/night_check.py [-v]
产出：docs/夜间体检报告.json
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SHOT = ROOT / (os.environ.get("NIGHT_SHOTDIR") or "docs/前端截图")
# ⚠ 反证跑的截图存在**另一个目录**（见 tools/e2e-night.js 的 NIGHT_SHOTS）：
#   不分开的话，反证会把正跑的图整批盖掉，复查时量到的是被弄坏的图（第 19 轮踩过）。
SRC = ROOT / (os.environ.get("NIGHT_SRC") or "docs/夜间体检实测.json")
OUT = ROOT / (os.environ.get("NIGHT_REPORT") or "docs/夜间体检报告.json")
VERBOSE = "-v" in sys.argv
DPR = 2                      # e2e-night.js 里 deviceScaleFactor=2
MIN_PX_AREA = 12 * 6         # 裁剪太小就量不出字 → 退回 A
MIN_FG_PIXELS = 3            # 真字的像素少于这个数 → 认为是抗锯齿噪声，不算数


def lum(rgb) -> float:
    def lin(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(x) for x in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b) -> float:
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def parse_rgb(s: str):
    if not s or not s.startswith("rgb"):
        return None
    try:
        parts = [p.strip() for p in s[s.find("(") + 1:s.find(")")].split(",")]
        return tuple(int(round(float(p))) for p in parts[:3])
    except Exception:
        return None


def threshold(fs: float, fw) -> tuple[float, str]:
    try:
        w = int(str(fw))
    except Exception:
        w = 700 if str(fw) in ("bold", "bolder") else 400
    if fs >= 24:
        return 3.0, "大字"
    if fs >= 18.66 and w >= 700:
        return 3.0, "大字粗"
    if fs <= 13:
        return 3.0, "次要小字"
    return 4.5, "正文"


def px_measure(im: Image.Image, x: float, y: float, w: float, h: float, want_fg=None):
    """从屏幕像素里量"真底 + 真字"。返回 (底, 字, 对比度, 找到没有) 或 None。

    ⚠ **不许夹取**：矩形必须整块落在图里，越界就直接说"量不了"（返回 None）。
    上一版是 `max(0, …)` 夹一下再裁 —— 结果半截在屏幕外的元素裁出来是屏幕边缘的别的东西，
    报出一堆"1.1:1 看不清"的假红（真查下去那几个字是 11.55:1）。宁可说"量不了"，也不许瞎量。
    """
    W, H = im.size
    x0, y0 = int(round(x * DPR)), int(round(y * DPR))
    x1, y1 = int(round((x + w) * DPR)), int(round((y + h) * DPR))
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H or x1 <= x0 or y1 <= y0:
        return None
    if (x1 - x0) * (y1 - y0) < MIN_PX_AREA:
        return None
    crop = im.crop((x0, y0, x1, y1))
    # 量化成 24 一档（抗锯齿的过渡像素会散开，量化后再数才数得清）
    buckets: dict[tuple, list] = {}
    for p in crop.getdata():
        k = (p[0] // 24, p[1] // 24, p[2] // 24)
        s = buckets.setdefault(k, [0, 0, 0, 0])
        s[0] += 1; s[1] += p[0]; s[2] += p[1]; s[3] += p[2]
    if len(buckets) < 2:
        return None                      # 一整块纯色：这格没有字
    cols = [(v[0], (v[1] / v[0], v[2] / v[0], v[3] / v[0])) for v in buckets.values()]
    cols.sort(key=lambda t: -t[0])
    n_bg, bg = cols[0]
    bg = tuple(round(c) for c in bg)
    lb = lum(bg)
    best, best_d = None, -1.0
    for n, col in cols[1:]:
        if n < MIN_FG_PIXELS:
            continue
        d = abs(lum(col) - lb)
        if d > best_d:
            best, best_d = col, d
    if best is None:
        return None                      # 没有够格的"字"像素 → 量不出来
    fg = tuple(round(c) for c in best)
    # CSS 说的前景色，在**像素里到底有没有**？（没有 = 那行字压根没画出来 / 被盖住了）
    found = False
    if want_fg is not None:
        for n, col in cols:
            if n < MIN_FG_PIXELS:
                continue
            if all(abs(col[i] - want_fg[i]) <= 26 for i in range(3)):
                found = True
                break
    return bg, fg, contrast(fg, bg), found


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def main() -> int:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    rep = {"at": data.get("at"), "force": data.get("force", ""), "themes": data.get("themes"),
           "surfaces": [], "fails": [], "notes": list(data.get("notes") or [])}
    surf_fail = defaultdict(list)
    md5s = defaultdict(list)
    for sf in data["surfaces"]:
        shot = sf.get("shot") or ""
        p = SHOT / shot if shot else None
        rec = {"id": sf["id"], "theme": sf["theme"], "shot": shot,
               "themeApplied": sf.get("themeApplied"), "notes": list(sf.get("notes") or []),
               "nText": 0, "items": [], "fails": []}

        def bad(why):
            rec["fails"].append(why); surf_fail[sf["id"] + "/" + sf["theme"]].append(why)

        if not p or not p.exists():
            bad("截图不存在：" + shot); rep["surfaces"].append(rec); continue
        md5s[shot].append(p)
        if sf.get("themeApplied") and sf["themeApplied"] != sf["theme"]:
            bad("这一组要的是 %s，实测主题是 %s（量的是另一套主题，判红）"
                % (sf["theme"], sf["themeApplied"]))
        if any("没稳住" in str(x) for x in (sf.get("notes") or [])):
            bad("这张照片跟量取的位置对不上（三次都没稳住）—— 数据不可信，判红重跑")
        pr = sf.get("probe") or {}
        if pr.get("err"):
            bad("探针：%s" % pr["err"])
        items = pr.get("items") or []
        rec["nText"] = len(items)
        # 反证模式（故意灌水/故意不切主题）时，屏本来就可能是空的 —— 空态判据仍然按 0 判红
        # 整屏的屏要求 ≥3 个文字节点（少了就是没渲染出来）；
        # 弹层/工具面板本来就可能是稀疏的一两行（比如"改动"就两行），只要求 ≥1；
        # 但 **0 个一律判红** —— 0 就是"什么都没画出来 / 探针没生效"，绿了也不算。
        need = 3 if sf["id"] in ("shelf", "preset", "lore", "chat", "tools", "settings", "reader") else 1
        if len(items) < need:
            bad("只量到 %d 个文字节点（要 ≥%d）—— 这一屏没渲染出来，或者探针没生效"
                % (len(items), need))
        im = Image.open(p).convert("RGB")
        for it in items:
            fs = float(it.get("fs") or 14)
            thr, kind = threshold(fs, it.get("fw"))
            fg = parse_rgb(it.get("fg"))
            bg = parse_rgb(it.get("bg"))
            c_css = contrast(fg, bg) if (fg and bg) else None
            px = px_measure(im, it.get("x", 0), it.get("y", 0), it.get("w", 0), it.get("h", 0), want_fg=fg)
            c_px = px[2] if px else None
            fg_found = px[3] if px else None
            use = c_px if c_px is not None else c_css
            row = {"t": it.get("t"), "cls": it.get("cls"), "fs": fs, "fw": it.get("fw"),
                   "thr": thr, "kind": kind, "fg": it.get("fg"), "bg": it.get("bg"),
                   "bgFrom": it.get("bgFrom"), "grad": it.get("grad"),
                   "css": round(c_css, 2) if c_css else None,
                   "px": round(c_px, 2) if c_px else None,
                   "pxFg": list(px[1]) if px else None, "pxBg": list(px[0]) if px else None,
                   "fgFound": fg_found, "disabled": bool(it.get("disabled")),
                   "cover": it.get("cover") or "",
                   "used": "px" if c_px is not None else "css", "ok": True}
            # ── 量不准的两类：**不许拿它们当判据**，但也**不许静默放过** ─────────────
            #   ① 这行字被别的东西压在下面（探针的命中测试量到了 cover）——
            #      这时候按矩形裁出来的"字色像素"其实是压在上面那层的字，
            #      第 19 轮那 3 条假红（报 1.97:1）就是这么来的：真值是 11.55:1，清清楚楚。
            #   ② 这行字的底是渐变/图片（grad）：算出来的"底色"跟真画在屏上的不是一回事，
            #      裁出来可能正好裁到图标/缩略图（tool-listen 那条报 4.03:1 就是）。
            #   —— 两条都记进 unmeasurable（"这一条量不准，不算通过也不算失败"），
            #      并且**逐个列在报告里**，让人能去核对；"被压住"这件事本身由
            #      tools/e2e-cover.js 那条判据管（它专门判"滚到底最后一行还被压住"）。
            if it.get("cover") or it.get("grad"):
                row["ok"] = None
                row["unmeasurable"] = ("被 %s 压住（探针命中测试量到）" % it["cover"]) if it.get("cover") \
                    else "底色是渐变/图片，算出来的底色不作数"
                rec.setdefault("unmeasurable", []).append(row)
                rec["items"].append(row)
                continue
            # CSS 说的前景色在像素里对不上 —— **不直接判红**，但要如实记一笔（dimmed）：
            #   · 抗锯齿：14.5px 的衬线字，最深的像素也到不了纯 --ink（不是毛病）；
            #   · 真的被压暗了：禁用态 / 盖了一层半透明（真毛病，但**看不看得清由像素说了算**，
            #     所以下面按像素对比度判，不按 CSS 判）。
            if fg_found is False:
                row["dimmed"] = True
            # 禁用态（disabled / aria-disabled / .off）：WCAG 2.1 明确豁免对比度要求，
            # 但**要记账**（"这有个灰按钮"），不然哪天按钮忘了解禁也看不出来。
            if it.get("disabled") and use is not None and use < thr:
                row["ok"] = True
                row["why"] = "禁用态，WCAG 豁免（实测 %.2f:1）" % use
                rec["exempt"] = (rec.get("exempt") or 0) + 1
            elif use is not None and use < thr:
                row["ok"] = False
                row["why"] = ("像素量出来 %.2f:1 < %.1f（%s，%.1fpx）—— 屏上就是看不清"
                              % (c_px, thr, kind, fs)) if c_px is not None else \
                             ("CSS 算出来 %.2f:1 < %.1f（%s，%.1fpx）" % (c_css, thr, kind, fs))
                rec["fails"].append(row["why"] + " · " + str(it.get("t"))[:20])
                surf_fail[sf["id"] + "/" + sf["theme"]].append(row["why"])
            # CSS 跟像素差得远 → 记一笔（多半是渐变/图底），不是失败但要留痕
            if c_css is not None and c_px is not None and abs(c_css - c_px) > 2.0:
                row["gap"] = round(abs(c_css - c_px), 2)
            rec["items"].append(row)
        if rec.get("unmeasurable") and len(rec["unmeasurable"]) == len(rec["items"]):
            bad("这一屏 %d 条文字全部量不准（被压住 / 渐变底）—— 等于没验过，不许算绿"
                % len(rec["items"]))
        rec["minPx"] = round(min([r["px"] for r in rec["items"] if r["px"]], default=0), 2)
        rec["minCss"] = round(min([r["css"] for r in rec["items"] if r["css"]], default=0), 2)
        if VERBOSE:
            for r in rec["items"]:
                print("    %-24s %-8s %.1fpx %-8s css=%-6s px=%-6s %s%s"
                      % (str(r["t"])[:22], r["kind"], r["fs"], str(r["cls"])[:8],
                         r["css"], r["px"], "OK" if r["ok"] else "✗ " + r.get("why", ""),
                         (" (差 %.1f)" % r["gap"]) if r.get("gap") else ""))
        rep["surfaces"].append(rec)

    # 同一轮里日间/夜间两张逐字节相同 = 主题根本没生效（第 15 轮那种假绿）
    for name, paths in md5s.items():
        pass
    by_id = defaultdict(dict)
    for sf in data["surfaces"]:
        if sf.get("shot"):
            by_id[sf["id"]][sf["theme"]] = SHOT / sf["shot"]
    for sid, m in by_id.items():
        if "paper" in m and "night" in m and m["paper"].exists() and m["night"].exists():
            if md5(m["paper"]) == md5(m["night"]):
                rep["fails"].append("日间和夜间两张图逐字节相同（%s）—— 主题没生效，这两组都是假绿" % sid)

    for sid, why in surf_fail.items():
        rep["fails"].append("%s：%d 条不达标 —— %s" % (sid, len(why), why[0]))
    rep["ok"] = not rep["fails"]
    dimmed = [(r["id"], r["theme"], it["t"], it.get("css"), it.get("px"))
              for r in rep["surfaces"] for it in r["items"] if it.get("dimmed")]
    rep["dimmed"] = [{"surface": a, "theme": b, "text": c, "css": d, "px": e} for a, b, c, d, e in dimmed]
    unm = [{"surface": r["id"], "theme": r["theme"], "text": it["t"], "cls": it.get("cls"),
            "why": it.get("unmeasurable"), "css": it.get("css"), "px": it.get("px")}
           for r in rep["surfaces"] for it in (r.get("unmeasurable") or [])]
    rep["unmeasurable"] = unm
    rep["summary"] = {
        "unmeasurableItems": len(unm),
        "surfaces": len(rep["surfaces"]),
        "textNodes": sum(r["nText"] for r in rep["surfaces"]),
        "badSurfaces": len(surf_fail),
        "badItems": sum(len(r["fails"]) for r in rep["surfaces"]),
        "dimmedItems": len(dimmed),
    }
    OUT.write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print("夜间体检 · %d 组（%d 个文字节点）" % (rep["summary"]["surfaces"], rep["summary"]["textNodes"]))
    for r in rep["surfaces"]:
        flag = "✗" if r["fails"] else "·"
        print("  %s %-30s %-6s 文字%3d  最小 css=%-6s px=%-6s %s"
              % (flag, r["id"], r["theme"], r["nText"], r.get("minCss"), r.get("minPx"),
                 ("；".join(r["fails"])[:70]) if r["fails"] else ""))
    if unm:
        print("  · 量不准（被压住 / 渐变底）%d 条 —— 不算通过也不算失败，逐条列在报告里：" % len(unm))
        for u in unm[:12]:
            print("      %-22s %-6s %-18s %s" % (u["surface"], u["theme"], str(u["text"])[:18], u["why"]))
    for f in rep["fails"]:
        print("  ✗ " + f)
    print(("全部通过" if rep["ok"] else "有 %d 条没过" % len(rep["fails"])) + " → " + str(OUT))
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
