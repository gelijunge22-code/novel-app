#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""两张截图差多少 —— 给"装饰看得见 / 又不过分"这类**差分判据**用。

为什么需要差分：一张截图没法回答"这层装饰到底有没有起作用"，
  因为背景装饰跟正文、卡片糊在同一个像素里。能一眼说清的是**同一屏、同一主题、
  只差"装饰开 / 关"两张图**：平均差太小 = 装饰白做了（看不见）；太大 = 刺眼（发白/抢内容）。

口径：逐像素三通道绝对差的**平均**（0~255），另外给 p99 与"差 > 6 的像素占比"。
用法：server/venv/bin/python tools/imgdiff.py a.png b.png   # 打印一行 JSON
"""
from __future__ import annotations

import json
import sys
import warnings

from PIL import Image

warnings.filterwarnings("ignore", category=DeprecationWarning)


def diff(pa: str, pb: str, rect=None) -> dict:
    a = Image.open(pa).convert("RGB")
    b = Image.open(pb).convert("RGB")
    if a.size != b.size:
        return {"ok": False, "why": "尺寸不同：" + str(a.size) + " vs " + str(b.size)}
    x, y = a.size
    x0 = y0 = 0
    if rect:                                   # rect = (左, 上, 右, 下) 比例 0~1，只看这一块
        x0, y0 = int(x * rect[0]), int(y * rect[1])
        x = max(x0 + 1, int(x * rect[2]))
        y = max(y0 + 1, int(y * rect[3]))
    step = 2 if x > 400 else 1                 # 隔列采样：够用且快（3.6G 那台机器要省）
    pa_, pb_ = a.load(), b.load()
    n = 0
    tot = 0
    hist = [0] * 256
    for j in range(y0, y, step):
        for i in range(x0, x, step):
            q, r = pa_[i, j], pb_[i, j]
            d = max(abs(q[0] - r[0]), abs(q[1] - r[1]), abs(q[2] - r[2]))
            tot += d
            n += 1
            hist[min(255, d)] += 1
    mean = tot / n if n else 0.0
    acc = 0
    p99 = 255
    for d in range(256):
        acc += hist[d]
        if acc >= n * 0.99:
            p99 = d
            break
    over = sum(hist[7:]) / n if n else 0.0
    return {"ok": True, "mean": round(mean, 3), "p99": p99, "over6": round(over, 4),
            "size": [x, y], "n": n, "rect": rect}


if __name__ == "__main__":
    rest = [a for a in sys.argv[1:] if not a.startswith("--")]
    rect = None
    for a in sys.argv[1:]:
        if a.startswith("--rect="):
            rect = tuple(float(v) for v in a.split("=", 1)[1].split(","))
    if len(rest) < 2:
        print("用法：imgdiff.py a.png b.png [--rect=左,上,右,下]", file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(diff(rest[0], rest[1], rect), ensure_ascii=False))
