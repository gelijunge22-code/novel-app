#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""弹层四角 / 夜间白边 —— 逐像素判定（治"边边还是白的、不是弧形的"）。

为什么有这东西：
  用户实机看到的：「点开设置，应该是从底下弹出来、边角是弧形的，结果有些没适配，
  边边还是白的，不是弧形的，夜间最明显。」
  这种毛病不放大看不出来，改一处还容易漏另一处 —— 所以做成一跑就出结论的判据。

判什么（每个弹层 × 每套主题 × 左上/右上两个角，按 dpr=3 的物理像素逐点看）：
  A. 圆角**真的被裁圆了没有**：取角上最外面那个像素（弧的外侧）。
     圆角生效时它是"弹层外面的底色"；如果它还是弹层自己的底色 → 直角，失败。
  B. 顶边**露白**没有：沿平直段（跳过圆弧那一段）扫一条像素带，
     出现比底色亮 ≥40 的像素 → 露白/白色 hairline，失败。
     （比底色**暗**的像素是投影，属正常，只记录不判失败 —— 第一版把投影判成"露底"，是假红。）
  C. 弹层**背后露白底**没有：角外侧的像素在非浅色主题下不许是纯白（这个正是用户实机看到的）。
  D. 逐条打印实测颜色，方便肉眼复核（不靠"我觉得还行"）。

用法：python3 tools/corner_check.py            # 读 docs/弹层四角/meta.json
产出：docs/弹层四角/报告.json + 每个弹层一张「四角对照.png」（米黄/暖褐/纸白/夜间）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
import os
DIR = ROOT / os.environ.get("CORNERS_DIR", "docs/弹层四角")
META = DIR / "meta.json"
OUT = DIR / "报告.json"
BRIGHT_FAIL = 40       # 顶边比底色亮这么多 → 露白
BG_TOL = 14            # 两个颜色算"同色"的容差
WHITE_LUM = 240        # 算"纯白"的亮度线

# 每套主题的页面底（用来判断"这主题本来就很浅，露白不算问题"）
THEME_PAPER = {
    "paper": (243, 234, 217), "sepia": (233, 220, 195), "slate": (232, 235, 236),
    "white": (247, 246, 244), "green": (217, 230, 212), "night": (20, 18, 15),
}


def lum(c) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def close(a, b, tol=BG_TOL) -> bool:
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


def parse_rgb(s: str):
    s = (s or "").strip()
    if not s.startswith("rgb"):
        return None
    try:
        parts = [p.strip() for p in s[s.find("(") + 1:s.find(")")].split(",")]
        return tuple(int(round(float(p))) for p in parts[:3])
    except Exception:
        return None


def radius_px(box) -> float:
    """弹层的圆角（CSS px），999px 这种胶囊按高度折算。"""
    raw = (box.get("radius") or "0px").replace("px", "").strip()
    try:
        v = float(raw)
    except Exception:
        return 0.0
    return min(v, box["h"] / 2, box["w"] / 2)


SCRIM = (24, 17, 10, 0.44)     # 跟 base.css 的 --scrim 对齐：44% 的暖黑


def scrim_over(paper):
    """弹层背后那一层应该长什么样：主题底 + 蒙层。算得出来 → 就能逐像素判。"""
    return tuple(round(paper[i] * (1 - SCRIM[3]) + SCRIM[i] * SCRIM[3]) for i in range(3))


def analyze(item: dict) -> dict:
    dpr = 3
    M = item.get("margin", 8)
    box = item["box"]
    # 拍的时候主题**真的**切过去了吗？没切过去这一组就不算数（是脚本的问题，不是界面的问题）。
    # 这条是被一次假红逼出来的：`reader-menu-set @ white` 量到的 themeApplied 是 `paper`，
    # 于是"弹层背后不是主题色"报了两条红 —— 看着像界面的毛病，其实脚本根本没切主题。
    applied = box.get("themeApplied")
    if applied and applied != item["theme"]:
        return {"overlay": item["overlay"], "overlayTitle": item.get("overlayTitle", ""),
                "theme": item["theme"], "themeName": item.get("themeName", ""),
                "themeApplied": applied, "panelBgCss": box.get("bg"), "corners": {}, "fails": [],
                "skipped": True,
                "skipWhy": "拍的时候主题没切过去（实测 %s）—— 这一组不算数，重跑" % applied}
    panel_bg = parse_rgb(box.get("bg")) or (0, 0, 0)
    r_css = radius_px(box)
    paper = THEME_PAPER.get(item["theme"], (255, 255, 255))
    res = {"overlay": item["overlay"], "overlayTitle": item.get("overlayTitle", ""),
           "theme": item["theme"], "themeName": item.get("themeName", ""),
           "panelBg": panel_bg, "panelBgCss": box.get("bg"), "radiusCss": box.get("radius"),
           "radiusEff": round(r_css, 1), "overflow": box.get("overflow"), "clip": box.get("clip"),
           "themePaper": list(paper),
           "panel": {k: round(box[k]) for k in ("x", "y", "w", "h")},
           "corners": {}, "fails": []}
    for tag, name in (("tl", "左上"), ("tr", "右上"), ("bl", "左下"), ("br", "右下")):
        f = item.get(tag)
        if not f:
            continue
        p = DIR / f
        if not p.exists():
            res["fails"].append(f"{name}角：裁剪图缺失 {f}")
            continue
        im = Image.open(p).convert("RGB")
        px = im.load()
        # 裁剪起点 = 弹层那个角 - margin（换算成物理像素）
        e = M * dpr                                   # 弹层边到裁剪边的距离
        gap = int(round(r_css * dpr)) + 2              # 圆弧占掉的像素
        top = tag in ("tl", "tr")
        left = tag in ("tl", "bl")
        cy = e if top else im.height - e - 1           # 弹层那条边在裁剪图里的 y
        cx = e if left else im.width - e - 1           # 弹层那条边在裁剪图里的 x
        outer = px[e, e] if left and top else \
            px[im.width - e - 1, e] if (not left and top) else \
            px[e, im.height - e - 1] if (left and not top) else px[im.width - e - 1, im.height - e - 1]
        outside = px[im.width // 2, 1] if top else px[im.width // 2, im.height - 2]
        if top:
            y_band = cy + 1
            xs = range(gap + e, im.width - 3) if left else range(2, max(3, im.width - gap - e))
        else:
            y_band = cy - 1
            xs = range(gap + e, im.width - 3) if left else range(2, max(3, im.width - gap - e))
        band = [px[x, y_band] for x in xs if 0 <= y_band < im.height]
        bright = max((lum(q) - lum(panel_bg) for q in band), default=0.0)
        dark = min((lum(q) - lum(panel_bg) for q in band), default=0.0)
        rounded = (not close(outer, panel_bg)) or close(outer, outside, 19)
        white_outside = lum(outside) >= WHITE_LUM and lum(paper) < 235
        expect_scrim = scrim_over(paper)
        # 只认"主题底 + 蒙层"这一个值：蒙层没铺上（露出的就是页面底/WebView 白底）→ 判红。
        # （上一版额外放行"等于主题底"，结果反证实验里蒙层被关掉也照样判绿 —— 空判据，已去掉。）
        outside_ok = (not item.get("scrim")) or close(outside, expect_scrim, 20)
        res["corners"][tag] = {
            "cornerSince": "top" if top else "bottom",
            "bandPx": len(band),
            "outerPixel": list(outer), "outerLum": round(lum(outer), 1),
            "outsidePixel": list(outside), "outsideLum": round(lum(outside), 1),
            "cornerRounded": rounded,
            "edgeBrightDelta": round(bright, 1), "edgeShadowDelta": round(dark, 1),
            "outsideIsWhite": white_outside,
            "outsideExpect": list(expect_scrim), "outsideMatchesTheme": outside_ok,
        }
        if not rounded:
            res["fails"].append(f"{name}角：角上仍是弹层自己的底色 {list(outer)} → 直角，圆角没生效")
        if bright >= BRIGHT_FAIL:
            res["fails"].append(f"{name}角顶边：比底色亮 {round(bright,1)} → 露白")
        if white_outside:
            res["fails"].append(f"{name}角外侧：{list(outside)} 是纯白，而本主题底色是 {list(paper)} → 弹层背后露白底")
        if not outside_ok:
            res["fails"].append(f"{name}角外侧：实测 {list(outside)}，既不是主题底 {list(paper)} 也不是"
                                f"「主题底+蒙层」{list(expect_scrim)} → 弹层背后不是主题色")
    return res


def montage(rows_items: list[tuple[dict, dict]]):
    """每个弹层拼一张对照图：米黄(tl,tr) | 暖褐(tl,tr) | 纸白(tl,tr) | 夜间(tl,tr)。"""
    groups: dict[str, dict[str, dict]] = {}
    for it, _ in rows_items:
        groups.setdefault(it["overlay"], {})[it["theme"]] = it
    made = []
    for ov, themes in groups.items():
        tiles = []
        for th in ("paper", "sepia", "white", "night"):
            it = themes.get(th)
            if not it:
                continue
            for tag in ("tl", "tr"):
                f = it.get(tag)
                if f and (DIR / f).exists():
                    tiles.append(Image.open(DIR / f).convert("RGB"))
        if not tiles:
            continue
        h = max(t.height for t in tiles)
        gap = 6
        canvas = Image.new("RGB", (sum(t.width for t in tiles) + gap * (len(tiles) - 1), h), (120, 120, 120))
        x = 0
        for t in tiles:
            canvas.paste(t, (x, 0))
            x += t.width + gap
        p1 = DIR / f"{ov}-四角对照.png"
        canvas.save(p1)
        big = canvas.resize((canvas.width * 3, canvas.height * 3), Image.NEAREST)
        big.save(DIR / f"{ov}-四角对照-x3.png")
        made.append(p1.name)
    return made


def main() -> int:
    if not META.exists():
        print("没有 docs/弹层四角/meta.json —— 先跑 node tools/e2e-corners.js")
        return 2
    meta = json.loads(META.read_text(encoding="utf-8"))
    rows = [analyze(it) for it in meta["items"]]
    made = montage(list(zip(meta["items"], rows)))
    fails = [f for r in rows for f in r["fails"]]
    skipped = [r for r in rows if r.get("skipped")]
    OUT.write_text(json.dumps({"at": meta["at"], "total": len(rows), "fails": len(fails),
                               "skipped": [{"overlay": r["overlay"], "theme": r["theme"],
                                            "why": r["skipWhy"]} for r in skipped],
                               "items": rows, "problems": fails, "montages": made},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 弹层四角体检 {len(rows)} 组：失败 {len(fails)} 条；不算数 {len(skipped)} 组 ===")
    for r in skipped:
        print(f"  ~ 不算数 {r['overlay']} @ {r['theme']} — {r['skipWhy']}")
    for r in rows:
        tl, tr = r["corners"].get("tl", {}), r["corners"].get("tr", {})
        flag = "OK " if not r["fails"] else "✗  "
        nb = len(r["corners"])
        worst = max([c.get("edgeBrightDelta", 0) for c in r["corners"].values()] or [0])
        print(f"  {flag}{r['overlay']:<16} {r['themeName']:<3} 底{r['panelBgCss']:<17}"
              f" 圆角{r['radiusEff']:<5} {nb}角 角外色 {str(tl.get('outerPixel')):<16}"
              f" 最亮边差{worst}")
    for f in fails:
        print("  ✗ " + f)
    print(f"报告：{DIR}/报告.json；对照图：" + "、".join(made))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
