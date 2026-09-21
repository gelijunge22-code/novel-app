#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""截图自证：**名字写的是什么，图里就得是什么**（专治"四张截图其实都是启动页"）。

为什么要它：第 15 轮监督人把 `docs/前端截图/r15-0*.png` 逐像素量了一遍，
发现名字写着"登录后书架 / 书卡详情 / 设置"的那三张**其实是同一张启动页**
（墨迹范围一样、逐像素只差 406 个点）。肉眼扫一眼看不出来，所以必须机器判。

判 4 件事（每条都能报红）：
  1. **同一轮里不许有两张一模一样的图**（md5 相同 = 那一步根本没生效）；
  2. 每一张都得**有货**：墨迹（跟底色不同的像素）占比 ≥ 0.5%，
     且不许是"启动页那点货"（启动页只有 logo + 一根进度条，墨迹极窄）；
  3. **启动页签名**：整图的墨迹被挤在中间一小块（上下都空一大截）—— 那就是启动页，
     凡是名字里不含"冷启动/启动页"的，一律判错；
  4. 名字里点到的屏幕，图上得**认得出**（按该屏的特征色块/密度粗判，见 CHECKS）。

用法：server/venv/bin/python tools/shots_check.py [轮次前缀，默认 r15]
产出：docs/截图自证.json（fails 非空 = 没过）
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
# 反证那轮要量"自己造的空图/启动页图"，别把结果混进正跑数据：
#   SHOT_DIR=...（图从哪读，默认 docs/前端截图）  OUT=...（报告写到哪）
SHOT = Path(os.environ.get("SHOT_DIR") or (ROOT / "docs" / "前端截图"))
OUT = Path(os.environ.get("OUT") or (ROOT / "docs" / "截图自证.json"))
ROUND = sys.argv[1] if len(sys.argv) > 1 else "r15"
# 允许"跟上一屏本来就该一样"的名字（返回键回到同一屏之类）
SAME_OK = ("-back", "back-", "-same")

# 每一屏的"看起来应该是什么样"——用两个能测的量：
#   ink   : 墨迹占比（跟底色不同的像素比例）
#   band  : 墨迹的**纵向铺开程度** = 墨迹高度 / 图高（启动页只有中间一小块，很窄）
#   底部货  : 最下面 15% 里有没有东西（底部导航/输入框/Dock 在的屏才有）
CHECKS = {
    "01-冷启动":     {"max_ink": 0.30, "desc": "登录页：居中的标题+输入框+按钮"},
    "02-登录后书架": {"min_ink": 0.10, "min_band": 0.55, "min_bottom": 0.005, "desc": "书架：整屏书卡列表"},
    "02b-":          {"min_ink": 0.08, "min_band": 0.45, "desc": "书卡菜单：底部弹层盖在书架上"},
    "03-设置":       {"min_ink": 0.08, "min_band": 0.55, "desc": "设置：整屏一行行设置项"},
    "04-设定":       {"min_ink": 0.05, "min_band": 0.40, "desc": "设定：分组列表"},
    "05-对话":       {"min_ink": 0.05, "min_band": 0.30, "desc": "对话：会话记录"},
    "toolback":      {"min_ink": 0.05, "desc": "工具宫格"},
    # 第 30 轮起，截图按"屏"直呼其名（r30-书架.png / r30-对话.png …）。
    # 这些名字以前**一条规则都没匹配上** → 拍成空白也不会报红（第 30 轮就漏过两张空白图）。
    # 现在每一屏都有下限：墨迹太少的，直接点名。
    "书架":          {"min_ink": 0.03, "desc": "书架：顶栏 + 书卡 + 底栏"},
    "阅读器":        {"min_ink": 0.03, "desc": "阅读器：整屏正文"},
    "目录":          {"min_ink": 0.02, "desc": "目录：一整块章节列表"},
    "书里的设置":    {"min_ink": 0.02, "desc": "阅读器底部面板"},
    "大设置":        {"min_ink": 0.02, "desc": "全站设置页"},
    "对话":          {"min_ink": 0.02, "desc": "AI 对话页"},
    "工具宫格":      {"min_ink": 0.03, "desc": "工具宫格"},
    "预设":          {"min_ink": 0.02, "desc": "预设页"},
    "设定":          {"min_ink": 0.02, "desc": "设定（世界引擎）页"},
}


def md5(p: Path) -> str:
    h = hashlib.md5()
    with p.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def lum(q) -> float:
    return 0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2]


def stats(p: Path) -> dict:
    im = Image.open(p).convert("RGB")
    w, h = im.size
    px = im.load()
    c = Counter(im.resize((w // 4, h // 4)).getdata())
    bg = c.most_common(1)[0][0]
    # 墨迹阈值要**跟着主题走**：浅色主题底白、卡片也亮，差 30 就够；
    # 夜间主题底 (20,18,15)、卡片 (31,28,24)，两边都暗、只差 30 —— 用 30 会把卡片全算成"底"，
    # 于是同一屏日间 ink=21%、夜间 ink=4.8%，误报"空白屏"（第19轮实测，两屏结构逐像素一致）。
    thr = 12 if lum(bg) < 90 else 30
    n = minx = miny = 0
    maxx, maxy = -1, -1
    tot = 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            tot += 1
            q = px[x, y]
            if abs(q[0] - bg[0]) + abs(q[1] - bg[1]) + abs(q[2] - bg[2]) > thr:
                n += 1
                if minx == 0 and miny == 0 and maxx < 0:
                    minx, miny = x, y
                minx = min(minx, x); maxx = max(maxx, x); miny = min(miny, y); maxy = max(maxy, y)
    bottom = sum(1 for y in range(int(h * 0.85), h, 3) for x in range(0, w, 3)
                 if abs(px[x, y][0] - bg[0]) + abs(px[x, y][1] - bg[1]) + abs(px[x, y][2] - bg[2]) > thr)
    bottom_tot = len(range(int(h * 0.85), h, 3)) * len(range(0, w, 3))
    return {
        "w": w, "h": h, "bg": list(bg), "thr": thr,
        "ink": round(n / tot, 4),
        "band": round((maxy - miny) / h, 3) if maxy >= 0 else 0.0,
        "box": [minx, miny, maxx, maxy],
        "bottom": round(bottom / bottom_tot, 4),
        "splash_like": bool(maxy >= 0 and (maxy - miny) / h < 0.30 and n / tot < 0.02
                            and 0.45 < (miny + maxy) / 2 / h < 0.75),
    }


def kind(name: str) -> str:
    for k in CHECKS:
        if k in name:
            return k
    return ""


# 每轮"应该有多少张、都有谁"——**缺一张就要报红**。
# 为什么加：第 30 轮收口时我自己用 SHOTS30_ONLY=reader,immersive,quick,quicktts,toc 局部重拍了 5 张，
# 脚本把 `docs/每屏截图-第30轮.json` 从 12 条覆盖成 5 条（书架/大设置/对话/工具/预设/设定/夜间 全没了），
# 而 shots_check.py 只按"目录里的图"判，**少了一半证据它也照样绿**。谁都没看出来。
EXPECT = {
    "r30": ["书架", "阅读器-正文", "阅读器-沉浸态", "目录", "书里的设置", "书里的设置-听书",
            "大设置", "对话", "工具宫格", "预设", "设定", "夜间-书架"],
}
RECORD = {"r30": ROOT / "docs" / "每屏截图-第30轮.json"}


def coverage(round_: str, fails: list) -> None:
    """整轮截图得是"整套"的：名单齐 + 不是局部重拍。"""
    want = EXPECT.get(round_)
    rec = RECORD.get(round_)
    if not want or not rec or not rec.exists():
        return
    rep = json.loads(rec.read_text(encoding="utf-8"))
    got = [s.get("name") for s in rep.get("shots", [])]
    if rep.get("partial"):
        fails.append({"shot": "(整轮记录)", "why": "这轮记录是**局部重拍**（SHOTS30_ONLY=%s）"
                      "—— 只拍了 %d 张（%s），不能当整轮证据"
                      % (",".join(rep.get("only") or []), len(got), "/".join(got))})
    miss = [w for w in want if w not in got]
    if miss:
        fails.append({"shot": "(整轮记录)",
                      "why": "整轮应该拍 %d 张，记录里只有 %d 张，**缺**：%s"
                             % (len(want), len(got), "、".join(miss))})


def main() -> int:
    files = sorted(p for p in SHOT.glob(ROUND + "-*.png") if p.is_file())
    rep = {"round": ROUND, "total": len(files), "shots": {}, "fails": [], "dups": []}
    if not files:
        print("没有 %s-*.png" % ROUND)
        return 1
    seen: dict[str, str] = {}
    for p in files:
        st = stats(p)
        st["md5"] = md5(p)
        st["kind"] = kind(p.name)
        rep["shots"][p.name] = st
        if st["md5"] in seen and not any(k in p.name for k in SAME_OK) \
           and not any(k in seen[st["md5"]] for k in SAME_OK):
            rep["dups"].append([seen[st["md5"]], p.name])
        seen.setdefault(st["md5"], p.name)
    for name, st in rep["shots"].items():
        k = st["kind"]
        if st["splash_like"] and "冷启动" not in name and "启动" not in name:
            rep["fails"].append({"shot": name, "why": "这张是**启动页**（墨迹挤在中间一小块），"
                                 "名字写的却是别的屏", "st": st})
            continue
        if not k:
            continue
        rule = CHECKS[k]
        if "min_ink" in rule and st["ink"] < rule["min_ink"]:
            rep["fails"].append({"shot": name, "why": "墨迹太少（%.3f%% < %.3f%%）—— 像空白屏/没生效"
                                 % (st["ink"] * 100, rule["min_ink"] * 100), "st": st})
        if "max_ink" in rule and st["ink"] > rule["max_ink"]:
            rep["fails"].append({"shot": name, "why": "墨迹太多（%.1f%%）" % (st["ink"] * 100), "st": st})
        if "min_band" in rule and st["band"] < rule["min_band"]:
            rep["fails"].append({"shot": name, "why": "内容没铺开（纵向只占 %.0f%%）—— 不像整屏的屏"
                                 % (st["band"] * 100), "st": st})
        if "min_bottom" in rule and st["bottom"] < rule["min_bottom"]:
            rep["fails"].append({"shot": name, "why": "最下面 15% 是空的（底部栏/输入框不见了？）", "st": st})
    coverage(ROUND, rep["fails"])
    rep["ok"] = not rep["fails"] and not rep["dups"]
    OUT.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    print("截图自证 · 第 %s 轮 · %d 张" % (ROUND, len(files)))
    for name, st in rep["shots"].items():
        print("  %-30s md5=%s ink=%5.1f%% band=%3.0f%% bottom=%5.2f%% %s"
              % (name, st["md5"][:8], st["ink"] * 100, st["band"] * 100, st["bottom"] * 100,
                 "← 启动页签名" if st["splash_like"] else ""))
    for d in rep["dups"]:
        print("  ✗ 同图: %s == %s" % tuple(d))
    for f in rep["fails"]:
        print("  ✗ %s — %s" % (f["shot"], f["why"]))
    print(("全部通过" if rep["ok"] else "有 %d 条没过" % (len(rep["fails"]) + len(rep["dups"])))
          + " → " + str(OUT))
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
