#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""阅读器沉浸态「上下空带」的**像素**判据（e2e-rdshell.js 的另一半）。

为什么必须量像素：旧实现里顶栏/底栏的底色**就是 --paper**，
所以"看颜色"永远看不出问题 —— 那条空带和正文底色一模一样。
真正能报红的是**墨迹到不到边**：
  沉浸态（chrome-off）下，正文的墨迹必须几乎顶到屏幕上下边
 （分页模式 cols 的 padding 是 22px 上 / 10px 下，所以墨迹首行 ≤ 40、末行 ≥ H-40）；
  修之前墨迹从 y≈50 才开始、y≈730 就没了 → 直接报红。

配套：tools/e2e-rdshell.js 量矩形 + 拍图 → docs/阅读器沉浸态实测.json
跑法：
  node tools/e2e-rdshell.js && server/venv/bin/python tools/check_rdshell.py
反证：
  RDCH_FORCE=keep node tools/e2e-rdshell.js && server/venv/bin/python tools/check_rdshell.py
  （必须报红、exit 1）
产出：docs/阅读器沉浸态自证.json
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
J = ROOT / "docs/阅读器沉浸态实测.json"
SHOTS = ROOT / "docs/前端截图"
ON = SHOTS / "r25-沉浸态-01-有栏.png"
OFF = SHOTS / "r25-沉浸态-02-沉浸.png"
OUT = ROOT / "docs/阅读器沉浸态自证.json"

INK_DIFF = 26          # 与底色差多少算"墨"
INK_ROW = 0.004        # 一行里 0.4% 的像素是墨 → 这行有字


def hexrgb(s: str):
    s = s.strip().lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def rows_with_ink(im: Image.Image, bg):
    """返回 (首个有墨的行, 最后一个有墨的行, 行墨迹占比列表)"""
    px = im.convert("RGB").load()
    w, h = im.size
    ink = []
    for y in range(h):
        n = 0
        for x in range(0, w, 2):                       # 隔列采样，够用且快
            r, g, b = px[x, y]
            if max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])) > INK_DIFF:
                n += 1
        ink.append(n / (w / 2))
    rows = [y for y, v in enumerate(ink) if v >= INK_ROW]
    return (rows[0] if rows else -1), (rows[-1] if rows else -1), ink


def row_has_ink(im: Image.Image, y: int, bg):
    px = im.convert("RGB").load()
    w, _ = im.size
    n = 0
    for x in range(0, w, 2):
        r, g, b = px[x, y]
        if max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])) > INK_DIFF:
            n += 1
    return (n / (w / 2)) >= INK_ROW


def row_uniform(im: Image.Image, y: int, bg, tol=10):
    px = im.convert("RGB").load()
    w, _ = im.size
    bad = 0
    for x in range(0, w, 2):
        r, g, b = px[x, y]
        if max(abs(r - bg[0]), abs(g - bg[1]), abs(b - bg[2])) > tol:
            bad += 1
    return bad / (w / 2)


def main() -> int:
    if not J.exists():
        print("✗ 没有 %s —— 先跑 node tools/e2e-rdshell.js" % J.name)
        return 1
    rep = json.loads(J.read_text(encoding="utf-8"))
    paper = hexrgb(rep["off"]["paper"])
    fails, checks = [], []

    def chk(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            fails.append(name + " → " + detail)

    md5on = hashlib.md5(ON.read_bytes()).hexdigest()
    md5off = hashlib.md5(OFF.read_bytes()).hexdigest()
    chk("两张图不是同一张（有栏/沉浸真的不一样）", md5on != md5off, "on=%s off=%s" % (md5on[:8], md5off[:8]))

    on_im, off_im = Image.open(ON), Image.open(OFF)
    W, H = off_im.size
    scale = W / float(rep["off"]["vw"])                     # 截图是 2 倍图：像素 = CSS px × scale
    t, b, _ = rows_with_ink(off_im, paper)
    head_b = rep["on"]["head"]["b"]                         # 有栏时顶栏的下边缘（CSS px）
    foot_t = rep["on"]["foot"]["t"]                         # 有栏时底栏的上边缘
    t_css, b_css = t / scale, b / scale

    # 关键的两条：沉浸态里，正文必须占到**原先被顶栏/底栏占住的那两块地方**去。
    # （只比对"墨迹到不到屏幕边"不牢：这一页的字本来就可能排不满 —— 比栏的位置才准。）
    chk("沉浸态：正文顶进原来被顶栏占住的地方（首行 %.0f < %.0f）" % (t_css, head_b),
        t_css < head_b - 4, "首个有墨行=%.0f CSS px，顶栏下边缘=%.0f" % (t_css, head_b))
    chk("沉浸态：正文落进原来被底栏占住的地方（末行 %.0f > %.0f）" % (b_css, foot_t),
        b_css > foot_t + 4, "末个有墨行=%.0f CSS px，底栏上边缘=%.0f" % (b_css, foot_t))
    chk("沉浸态：最上一行是干净的纸色（没有灰/白条）", row_uniform(off_im, 1, paper) <= 0.02,
        "非纸色像素占比=%.3f" % row_uniform(off_im, 1, paper))
    chk("沉浸态：最下一行是干净的纸色", row_uniform(off_im, H - 2, paper) <= 0.02,
        "非纸色像素占比=%.3f" % row_uniform(off_im, H - 2, paper))
    # 有栏那一张：正文得**从顶栏下面**开始（顶栏里那行书名不算"正文"）。
    # 不能直接拿整图的首个有墨行 —— 顶栏自己的书名就在 y≈17，会把它算进去。
    ot, _ob, _ = rows_with_ink(on_im, paper)
    first_after_head = next((y for y in range(int(head_b * scale), H)
                             if row_has_ink(on_im, y, paper)), -1)
    chk("有栏时：正文从顶栏下面开始（不钻到栏底下）",
        first_after_head > head_b * scale,
        "顶栏下边缘=%.0f CSS px，正文首个有墨行=%.1f CSS px" % (head_b, first_after_head / scale))

    rep_out = {"force": rep.get("force"), "paper": rep["off"]["paper"], "img": {"w": W, "h": H},
               "ink": {"off": [t, b], "on": [ot, first_after_head]}, "checks": checks, "fails": fails}
    OUT.write_text(json.dumps(rep_out, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in checks:
        print("  %s %s  %s" % ("✓" if c["ok"] else "✗", c["name"], c["detail"]))
    print("  → " + str(OUT.relative_to(ROOT)) + ("  全过 ✅" if not fails else "  %d 条红 ❌" % len(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
