# -*- coding: utf-8 -*-
"""用户传进来的东西 → 数字（不合法就 400，别让它冒成 500）。

第 8 遍打磨新加的：`tools/verify_badinput.py` 一跑就抓出一串 ——
`percent='abc'`、`entityId='abc'`、`version='abc'` 全把服务打成 **HTTP 500**
（`float("abc")` 的 ValueError 直接冒到框架）。用户看到的是"服务出错了"，
其实只是他填错了一个数；正经做法是 400 加一句人话。

`month='abc'` 那种更坏：不报错，**默默按 1 月存下去** —— 世界引擎里的时间从此是错的，
而且没人知道。所以这里一律"要么给对，要么明说"。

用法：
    num(payload.get("percent"), 0.0, kind=float, name="进度百分比")
    num(payload.get("month"), 1, lo=1, hi=12, name="月份")
"""
from __future__ import annotations

import json

from fastapi import HTTPException

MAX_INT = 2 ** 53 - 1            # JS 能精确表示的上限（也是 SQLite 64 位整数之前的安全线）


def num(value, default=0, *, kind=int, lo=None, hi=None, name="参数"):
    """把 value 变成 kind 类型的数字；None/空串 → default（保持老行为）。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        if default is None:
            raise HTTPException(400, f"{name}不能为空")
        return default
    if isinstance(value, bool):                  # True/False 当 1/0，别当成字符串处理
        value = int(value)
    try:
        out = int(value) if kind is int else float(value)
    except (TypeError, ValueError, OverflowError):
        what = "整数" if kind is int else "数字"
        raise HTTPException(400, f"{name}要是{what}（收到 {str(value)[:20]!r}）")
    if out != out or out in (float("inf"), float("-inf")):
        raise HTTPException(400, f"{name}超出范围（收到 {str(value)[:20]!r}）")
    if abs(out) > MAX_INT:
        raise HTTPException(400, f"{name}超出范围（最大 {MAX_INT}，收到 {str(value)[:20]!r}）")
    if lo is not None and out < lo:
        raise HTTPException(400, f"{name}最小是 {lo}（收到 {out}）")
    if hi is not None and out > hi:
        raise HTTPException(400, f"{name}最大是 {hi}（收到 {out}）")
    return out


def clamp(value, default, *, lo, hi, kind=int):
    """给"只是个上限/条数"这种参数用：脏值不报错，退回默认值再夹到区间里。

    为什么跟 num() 不一样：`limit` 填错没必要让整页打不开 —— 用户要的是"看到内容"，
    不是"被教育"。而 `percent` / `month` 这种**会写进数据的**必须报错（见 num 的说明）。
    """
    try:
        out = int(value) if kind is int else float(value)
    except (TypeError, ValueError, OverflowError):
        out = default
    return max(lo, min(hi, out))


def s(value, default: str = "", *, name: str = "字段") -> str:
    """把用户传的标量变成文字；**容器（数组/对象）一律 400**。

    第 9 遍打磨补的：`tools/verify_edges.py` 的错类型模糊测试一跑就抓出
    **58 处 HTTP 500** —— `title=["数组"]`、`path={"对象":1}`、`name=12345` 全会撞上
    `'list' object has no attribute 'strip'`。用户看到的是"服务器内部错误"，
    其实只是他把一个字段填成了数组。

    规矩：
      - None / 空串 → default（保持老行为，别把"没填"变成报错）
      - 数字 / 布尔 → 当文字（`title=12345` → "12345"，这是无害的）
      - 数组 / 对象 / 二进制 → 400 说人话（这种几乎必然是前端传错了）
    """
    if value is None:
        return default
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        raise HTTPException(400, f"{name}要是文字（收到二进制）")
    raise HTTPException(400, f"{name}要是文字，不该是{'数组' if isinstance(value, list) else '对象'}"
                             f"（收到 {json.dumps(value, ensure_ascii=False)[:60]}）")


def obj(value, default=None, *, name: str = "字段"):
    """给"本来就要一个对象"的字段用（比如 voice 档案、settings）。不是对象 → 400。"""
    if value is None:
        return default
    if isinstance(value, dict):
        return value
    raise HTTPException(400, f"{name}要是对象（收到 {type(value).__name__}）")
