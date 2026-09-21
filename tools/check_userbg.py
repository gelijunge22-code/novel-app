#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自定义背景图 · **按像素**判对比度（第 43 轮）。

为什么要单独一步判定（跟 tools/e2e-night.js + tools/night_check.py 同一个套路）：
  探针负责"真打开、真上传、真截图、真记下每个文字节点的位置与颜色"，
  这一步负责**从截图像素里再量一遍**。只信 getComputedStyle 会骗自己 ——
  用户传的是一张**全黑图**时，CSS 说"文字色是 #3a332b、底是 --paper"，可屏幕上
  压着的是"纸色纱 + 黑图"合成出来的深底，算出来的对比度跟眼睛看到的完全是两回事。

判据（两件都要过，且都要能报红）：
  甲 **每一屏**都量到了 ≥N 个文字节点、且**每个节点**的像素对比度都过 WCAG AA
     （正文 4.5:1 / 大意 3.0:1 / 次要小字 3.0:1 —— 门槛跟 night_check.py 一套）
  乙 这一批截图**确实铺上了用户那张测试图**（底色跟"没铺图的基线"不一样）——
     不然"对比度当然好"是假绿：图没生效时当然字字清楚。

★ 第 45 轮改法（原来这两条在"用户自己的浅色图 / 纯蓝图"上**必然误报**，见 docs/进度.md）：
  原来的口径是"绝对阈值"：底色不够深就红、某节点低于 WCAG 就红。
  可实测**默认纸色那一版截图同一个节点也照样过不了**（shelf 3.21、settings 1.21）——
  那是这套像素取色（want_fg=节点颜色）对"强调色底 + 白字"这类按钮取错色导致的，
  **跟用户传没传背景图没关系**。所以现在改成**差分口径**：
    ① 同一批节点，在**没有自定义背景的基线截图**上量一遍；
    ② 只有"基线能过、铺了图却过不了"才判红（= 真的是这张图/这层纱弄坏的）；
    ③ "基线本来就过不了 / 基线也没量到字" → 记 warn（口径问题，不算这条的背景图锅）；
    ④ "底色和基线一样" → 判红（图根本没铺上，这才是假绿）。
  基线截图：docs/前端截图/*-base-<面>.png（tools/e2e-userbg.js 每一屏都会顺手拍一张无图版）；
  没有基线图时退回老的绝对口径（并在报告里写明）。

用法：server/venv/bin/python tools/check_userbg.py [-v]
      （反证的报告/图各走另一份：UBG_SRC / UBG_REPORT / UBG_SHOTDIR）
产出：docs/背景图对比度报告.json
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import night_check as nc            # noqa: E402   （对比度 / 取像素那套算法全站只此一份）

from PIL import Image               # noqa: E402

SRC = ROOT / (os.environ.get("UBG_SRC") or "docs/背景图实测.json")
OUT = ROOT / (os.environ.get("UBG_REPORT") or "docs/背景图对比度报告.json")
SHOTDIR = os.environ.get("UBG_SHOTDIR") or ""      # 反证跑的图在另一个目录（别互相盖）
VERBOSE = "-v" in sys.argv
MIN_TEXT = 6            # 一屏至少量到这么多文字节点，否则"这一屏没量到东西"，绿了也不算
BASE_GLOB = "docs/前端截图"          # 基线截图（无自定义背景）放这儿，名字里带 -base-<面>
DIFF_MIN = 2.0          # 铺图后跟基线至少要有这么多**百分比**的像素真的变了，才算"图生效了"



def bg_of(im: "Image.Image"):
    """这张图里最常出现的颜色（≈ 大片底色）。"""
    small = im.resize((40, 80))
    cnt: dict = {}
    for p in small.getdata():
        k = (p[0] // 16, p[1] // 16, p[2] // 16)
        cnt[k] = cnt.get(k, 0) + 1
    return [c * 16 + 8 for c in max(cnt.items(), key=lambda kv: kv[1])[0]]


def diff_pct(a: "Image.Image", b: "Image.Image", thr: int = 24) -> float:
    """两张同尺寸截图里"真的变了"的像素占多少 %（判"背景图铺上了没有"用）。
    单通道差 > thr 才算变 —— 抗锯齿/字体渲染的一点点抖动不该算。"""
    if a.size != b.size:
        return 100.0
    pa, pb = list(a.getdata()), list(b.getdata())
    n = len(pa)
    far = 0
    for i in range(n):
        x, y = pa[i], pb[i]
        if abs(x[0] - y[0]) > thr or abs(x[1] - y[1]) > thr or abs(x[2] - y[2]) > thr:
            far += 1
    return round(100.0 * far / max(1, n), 2)


def scan(im: "Image.Image", nodes: list) -> list:
    """把一批文字节点在**这一张图**上逐个量一遍。返回跟 nodes 等长的列表，
    量不了的记 None（位置越界 / 那块是纯色没字）。"""
    res = []
    for nd in nodes:
        try:
            r = nc.px_measure(im, nd["x"], nd["y"], nd["w"], nd["h"], want_fg=nc.parse_rgb(nd["c"]))
        except Exception:
            r = None
        if r is None:
            res.append(None)
            continue
        _, _, ratio, found = r
        lim, kind = nc.threshold(nd["fs"], nd["fw"])
        res.append({"ratio": ratio, "lim": lim, "kind": kind, "found": found})
    return res


def baseline_for(shot: Path):
    """找这一屏的**无自定义背景**基线截图（tools/e2e-userbg.js 每屏都会拍一张）。
    命名规则：<前缀>-base-<面>.png，取跟当前截图同一个前缀目录里的那一张。"""
    d = ROOT / BASE_GLOB
    if not d.is_dir():
        return None
    name = shot.name
    mid = name.replace("-ok-black-", "-ok-base-").replace("-stale-black-", "-stale-base-")
    cand = d / mid
    return cand if cand.exists() and cand != shot else None


def main() -> int:
    rep = json.loads(SRC.read_text("utf-8"))
    surfaces = rep.get("surfaces") or []
    out = {"at": rep.get("at"), "force": rep.get("force"), "surfaces": [], "fails": [], "warns": []}
    for s in surfaces:
        shot = (ROOT / s["file"]) if not SHOTDIR else (ROOT / SHOTDIR / Path(s["file"]).name)
        nodes = s.get("nodes") or []
        item = {"id": s["id"], "file": s["file"], "nText": len(nodes), "minPx": None, "minText": "",
                "worst": None, "bgSample": None, "fails": [], "warns": [], "unmeasurable": 0,
                "baseFile": None, "basePx": None, "baseBgSample": None, "diffPct": None}
        out["surfaces"].append(item)
        if not shot.exists():
            out["fails"].append("%s：截图不在（%s）" % (s["id"], shot))
            item["fails"].append("截图不在")
            continue
        im = Image.open(shot).convert("RGB")
        item["bgSample"] = bg_of(im)
        base = baseline_for(shot)
        base_nodes = None
        bim = None
        if base is not None:
            bim = Image.open(base).convert("RGB")
            item["baseFile"] = str(base.relative_to(ROOT))
            item["baseBgSample"] = bg_of(bim)
            base_nodes = scan(bim, nodes)
        cur = scan(im, nodes)

        # ── 甲：逐节点像素对比度（**差分**：基线也过不了的记 warn，不记红）
        worst = None
        for i, nd in enumerate(nodes):
            r = cur[i]
            if r is None:
                item["unmeasurable"] += 1
                continue
            if worst is None or r["ratio"] < worst:
                worst = r["ratio"]
                item["minPx"] = round(r["ratio"], 2)
                item["minText"] = str(nd.get("t"))[:18]
                item["worst"] = {"限": r["lim"], "类型": r["kind"], "字号": nd["fs"],
                                 "找到了字色": r["found"]}
            if base_nodes is not None and base_nodes[i] is not None:
                item["basePx"] = round(min(base_nodes[i]["ratio"],
                                           item["basePx"] if item["basePx"] is not None else 99), 2)
            if r["ratio"] >= r["lim"]:
                continue
            b = base_nodes[i] if base_nodes is not None else None
            msg = "%s（%s %spx，限 %.1f:1）—— 压在图上的字看不清" % (
                str(nd.get("t"))[:14], r["kind"], nd["fs"], r["lim"])
            if base_nodes is not None and b is not None and b["ratio"] < b["lim"]:
                item["warns"].append(msg + "；但**基线（没铺图）也过不了**（基线 %.2f:1）"
                                     "→ 是取色口径的问题，不是这张背景图的锅" % b["ratio"])
            else:
                item["fails"].append(msg)

        # ── 乙：图到底铺上了没有。**按像素差分**判（跟基线比有多少像素真的变了）。
        #     别用"最常出现的颜色"当底色 —— 第 45 轮实测：设定页大半被白卡片盖住，
        #     最常色恒为卡片色，于是 7 屏里 5 屏被误报成"图没生效"（而同一批图跟基线的
        #     差异像素是 13%~72%，图明明铺上了）。差分才是"图生效没有"的直接证据。
        if bim is not None:
            item["diffPct"] = diff_pct(im, bim)
            if item["diffPct"] < DIFF_MIN:
                item["fails"].append("跟没铺图的基线只差 %.2f%% 的像素（< %.1f%%）"
                                     "—— 图根本没生效（这样的绿是假绿）"
                                     % (item["diffPct"], DIFF_MIN))
        else:
            item["warns"].append("没有基线截图（%s），乙条（图铺上了没有）这一屏跳过" % BASE_GLOB)

        # ── 节点数够不够量
        if item["nText"] < MIN_TEXT:
            msg = "只量到 %d 个文字节点（< %d）—— 这一屏没量到东西，绿了也不算" % (item["nText"], MIN_TEXT)
            if base_nodes is not None:
                item["warns"].append(msg + "；基线这一屏同样只量到 %d 个 → 是这一屏本来就没几个字" % item["nText"])
            else:
                item["fails"].append(msg)

        if item["fails"]:
            out["fails"].append(s["id"] + "：" + "；".join(item["fails"][:3]))
        if item["warns"]:
            out["warns"].append(s["id"] + "：" + "；".join(item["warns"][:2]))

    out["summary"] = {"surfaces": len(out["surfaces"]),
                      "bad": len([x for x in out["surfaces"] if x["fails"]]),
                      "warned": len([x for x in out["surfaces"] if x["warns"]]),
                      "textNodes": sum(x["nText"] for x in out["surfaces"]),
                      "worst": min([x["minPx"] for x in out["surfaces"] if x["minPx"]] or [0]),
                      "基线也没过（口径问题）": len([w for w in out["warns"] if "基线" in w])}
    out["ok"] = not out["fails"]
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("自定义背景图 · 按像素判对比度（差分口径：基线能过才算真红）：%d 屏 / %d 个文字节点"
          % (out["summary"]["surfaces"], out["summary"]["textNodes"]))
    for x in out["surfaces"]:
        print("  %s %-14s 文字%3d 最差=%-6s（基线 %-6s）底色 %s→%s 差 %s%%"
              % ("✗" if x["fails"] else ("·" if x["warns"] else "✓"), x["id"], x["nText"],
                 x["minPx"], x["basePx"], x["bgSample"], x["baseBgSample"],
                 x.get("diffPct")))
        for f in x["fails"]:
            print("      ✗ " + f)
        for w in x["warns"]:
            print("      ⚠ " + w)
    print("\n" + ("全部通过" if out["ok"] else "有 %d 条没过" % len(out["fails"]))
          + "（%d 屏有 warn）→ %s" % (out["summary"]["warned"], OUT))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
