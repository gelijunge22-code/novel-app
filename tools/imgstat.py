#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""量一张截图的"有没有货"：墨迹占比 / 纵向铺开 / 是不是空白。

为什么要有它：`tools/shots-30.js` 拍完图要**当场**知道这张是不是空白页。
DOM 探针查不出这件事 —— 第 30 轮实测：`#screen-settings` 明明 `display:flex; 390×844`、
`#settings-body` 里也有内容，可**截出来的像素是全空白**（无头 Chrome 的合成帧没跟上）。
所以判"拍漏了"只能靠像素，量出来是空白就重拍。

跟 `tools/shots_check.py` 的 `stats()` 同一套阈（那边是事后审计，这边是拍完当场用）：
  墨迹 = 跟底色差 > thr 的像素；浅底 thr=30、深底 thr=12（夜间主题底和卡片只差 30）。

用法：server/venv/bin/python tools/imgstat.py <png>      # 打印一行 JSON
"""
from __future__ import annotations

import json
import sys
import warnings
from collections import Counter
from pathlib import Path

from PIL import Image

# Pillow 15 会把 getdata 挪走，这条警告每拍一张图就刷两行，日志里全是噪音
warnings.filterwarnings("ignore", category=DeprecationWarning)


def stats(path: str) -> dict:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    bg = Counter(im.resize((max(1, w // 4), max(1, h // 4))).getdata()).most_common(1)[0][0]
    thr = 12 if (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 90 else 30
    n = tot = 0
    miny, maxy = h, -1
    for y in range(0, h, 3):
        row = 0
        for x in range(0, w, 3):
            tot += 1
            q = px[x, y]
            if abs(q[0] - bg[0]) + abs(q[1] - bg[1]) + abs(q[2] - bg[2]) > thr:
                n += 1
                row += 1
        if row > 0:
            miny = min(miny, y)
            maxy = max(maxy, y)
    ink = n / tot if tot else 0.0
    # **屏幕主体**的墨迹：去掉顶栏/底栏那两条（各占 ~6%，它们长在屏幕元素外面，
    # 换屏时一直都在）。判"这一屏自己有没有东西"要看这一块 —— 只量整幅的话，
    # 当前屏被藏了、只剩顶栏底栏，也会量出 5%~8% 的墨迹，把"空白屏"放过去。
    cy0, cy1 = int(h * 0.12), int(h * 0.88)
    cn = ct = 0
    for y in range(cy0, cy1, 3):
        for x in range(0, w, 3):
            ct += 1
            q = px[x, y]
            if abs(q[0] - bg[0]) + abs(q[1] - bg[1]) + abs(q[2] - bg[2]) > thr:
                cn += 1
    core = cn / ct if ct else 0.0
    return {
        "core": round(core, 4),
        "core_blank": bool(core < 0.01),
        "w": w, "h": h, "bg": list(bg), "thr": thr,
        "ink": round(ink, 4),
        "band": round((maxy - miny) / h, 3) if maxy >= 0 else 0.0,
        # 空白 = 几乎一个墨点都没有（纯色/渐变底）；真屏幕不会这样，连空态也有字
        "blank": bool(ink < 0.002),
        # 启动页签名：墨迹挤在中间一小坨（跟 shots_check.py 同一判据）
        "splash_like": bool(maxy >= 0 and (maxy - miny) / h < 0.30 and ink < 0.02
                            and 0.45 < (miny + maxy) / 2 / h < 0.75),
    }


if __name__ == "__main__":
    print(json.dumps(stats(sys.argv[1]), ensure_ascii=False))
