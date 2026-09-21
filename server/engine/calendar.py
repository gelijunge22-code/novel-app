# -*- coding: utf-8 -*-
"""自定义历法：纪元 / 月份长度 / 闰年规则 → **绝对序号**（第几天）。

为什么长篇写作需要它（不是为了炫技）：
* 架空世界的"开元 1024 年 3 月 15 日"和"第三纪 12 年"**没法互相比较**，时间线就只能靠
  作者手工排 order_no，一改就全乱；换成绝对序号，排序/回溯/冲突检测才有共同坐标。
* 公元前必须支持（负年份），否则前传、回忆、"三百年前"全落不了地。
* 用户自己的历法（一个月几个 30 天、几年一闰）必须能定义，不能只认公历。

数值约定（写死在这里，测试里逐条验）：
* 绝对序号是**整数天**，第 1 天 = 公历 0001-01-01（和 Python `date.toordinal()` 对齐，
  方便拿标准库当参照物来验）。
* 公元前用**负数年份**表示：`-221` = 公元前 221 年；`year_zero=False` 的历法按
  "没有 0 年"处理（天文年编号 = 负年份 + 1），这是 ISO 8601 的口径，也是 Hinnant 公式的口径。
* 闰年规则用"每隔 every 年闰一次，但跳过 skip_every 的整数倍，除非它是 keep_every 的整数倍"
  描述（公历 = 4 / 100 / 400）；架空历还可以直接给 `leap_years` 列表手工点。
"""
from __future__ import annotations

import re

# ── 内置：公历（proleptic Gregorian，跨公元前可用） ──────────────────────────
GREGORIAN: dict = {
    "name": "公历",
    "epoch": "公元 1 年 1 月 1 日（绝对序号 1）",
    "anchor": {"year": 1, "month": 1, "day": 1, "abs": 1},
    "months": [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    "leap_month": 2,
    "leap_days": 1,
    "leap_rule": {"every": 4, "skip_every": 100, "keep_every": 400},
    "year_zero": False,
    "week": 7,
    "eras": [{"name": "公元", "sign": 1}, {"name": "公元前", "sign": -1}],
}

DEFAULT_NAME = "公历"


def normalize(cal: dict | None) -> dict:
    """把外部传进来的历法补全成可用定义（缺什么补什么，不覆盖用户给的）。"""
    c = dict(GREGORIAN if not cal else cal)
    base = dict(GREGORIAN)
    base.update(c or {})
    if not base.get("months"):
        base["months"] = [30] * 12
    base["months"] = [int(x) for x in base["months"]]
    base.setdefault("leap_days", 1)
    base.setdefault("leap_month", len(base["months"]))
    base.setdefault("year_zero", True)
    base.setdefault("leap_rule", {})
    base.setdefault("anchor", {"year": 1, "month": 1, "day": 1, "abs": 0})
    return base


# ── 基础换算 ────────────────────────────────────────────────────────────────
def _count_div(a: int, b: int, k: int) -> int:
    """[a,b] 里能被 k 整除的整数个数（负数区间也对：Python 的 // 是向下取整）。"""
    if k <= 0 or b < a:
        return 0
    return b // k - (a - 1) // k


def is_leap(cal: dict, year: int) -> bool:
    r = cal.get("leap_rule") or {}
    years = r.get("leap_years")
    if years:
        return int(year) in {int(y) for y in years}
    every = int(r.get("every") or 0)
    if not every:
        return False
    if year % every:
        return False
    skip = int(r.get("skip_every") or 0)
    if skip and year % skip == 0:
        keep = int(r.get("keep_every") or 0)
        if not (keep and year % keep == 0):
            return False
    return True


def year_len(cal: dict, year: int) -> int:
    n = sum(cal["months"])
    if is_leap(cal, year):
        n += int(cal.get("leap_days") or 0)
    return n


def _count_leaps(cal: dict, a: int, b: int) -> int:
    """[a,b] 区间里的闰年数。"""
    if b < a:
        return 0
    r = cal.get("leap_rule") or {}
    years = r.get("leap_years")
    if years:
        ys = sorted(int(y) for y in years)
        return sum(1 for y in ys if a <= y <= b)
    every = int(r.get("every") or 0)
    if not every:
        return 0
    skip = int(r.get("skip_every") or 0)
    keep = int(r.get("keep_every") or 0)
    if not skip and not keep:
        return _count_div(a, b, every)
    if skip and keep:
        return (_count_div(a, b, every) - _count_div(a, b, skip)
                + _count_div(a, b, keep))
    n = 0
    for y in range(a, b + 1):
        if is_leap(cal, y):
            n += 1
    return n


def civil_year(cal: dict, year: int) -> int:
    """外部年份 → 天文年编号（`year_zero=False` 时，公元前 1 年 = 天文年 0）。"""
    if cal.get("year_zero", True):
        return int(year)
    y = int(year)
    return y + 1 if y < 0 else y


def _days_before_year(cal: dict, cy: int) -> int:
    """天文年 cy 的 1 月 1 日之前，一共过了几天（以"公历 1 年 1 月 1 日"为原点）。"""
    Y = sum(cal["months"])
    leap_days = int(cal.get("leap_days") or 0)
    if cy >= 1:
        return (cy - 1) * Y + leap_days * _count_leaps(cal, 1, cy - 1)
    return -((1 - cy) * Y + leap_days * _count_leaps(cal, cy, 0))


def _days_before_month(cal: dict, cy: int, month: int) -> int:
    days = sum(cal["months"][: month - 1])
    if is_leap(cal, cy) and int(cal.get("leap_month") or 0) <= month - 1:
        days += int(cal.get("leap_days") or 0)
    return days


def month_len(cal: dict, cy: int, m: int) -> int:
    """天文年 cy 的第 m 个月有几天（含闰月多加的天数）。"""
    n = cal["months"][m - 1]
    if is_leap(cal, cy) and int(cal.get("leap_month") or 0) == m:
        n += int(cal.get("leap_days") or 0)
    return n


def to_abs(cal: dict, year: int, month: int = 1, day: int = 1) -> int:
    """(年,月,日) → 绝对序号。公元前传负年份。

    日期越界（"2 月 30 日"这种笔误）不抛错，夹到该月最后一天 —— 写作时写错一天，
    不该让整条时间线算不出来。
    """
    cal = normalize(cal)
    cy = civil_year(cal, year)
    a = cal["anchor"]
    acy = civil_year(cal, a["year"])
    m = int(month)
    if not 1 <= m <= len(cal["months"]):
        raise ValueError(f"月份 {month} 不在这套历法里（只有 1~{len(cal['months'])} 月）")
    d = max(1, min(int(day), month_len(cal, cy, m)))
    return (int(a["abs"]) + _days_before_year(cal, cy) - _days_before_year(cal, acy)
            + _days_before_month(cal, cy, m) + (d - 1))


def from_abs(cal: dict, abs_day: int) -> dict:
    """绝对序号 → {era, year, month, day}。"""
    cal = normalize(cal)
    a = cal["anchor"]
    acy = civil_year(cal, a["year"])
    target = int(abs_day) - int(a["abs"]) + _days_before_year(cal, acy)
    # 先粗估年份，再往回收/放（历法长度一年一年可能不同，粗估用平均年长）
    Y = sum(cal["months"])
    cy = int(target // Y) + 1
    guard = 0
    while _days_before_year(cal, cy) > target and guard < 10000:
        cy -= 1; guard += 1
    while _days_before_year(cal, cy + 1) <= target and guard < 10000:
        cy += 1; guard += 1
    rest = target - _days_before_year(cal, cy)
    m, ml = 1, month_len(cal, cy, 1)
    while rest >= ml and m < len(cal["months"]):
        rest -= ml
        m += 1
        ml = month_len(cal, cy, m)
    year = cy if cal.get("year_zero", True) else (cy - 1 if cy <= 0 else cy)
    era = era_of(cal, year)
    return {"era": era, "year": year, "month": m, "day": int(rest) + 1, "abs": int(abs_day)}


def era_of(cal: dict, year: int) -> str:
    for e in (cal.get("eras") or []):
        sign = int(e.get("sign") or 1)
        if sign < 0 and year < 0:
            return str(e.get("name") or "")
        if sign > 0 and year >= (0 if cal.get("year_zero", True) else 1):
            return str(e.get("name") or "")
    return ""


def format_abs(cal: dict, abs_day: int) -> str:
    d = from_abs(cal, abs_day)
    era = d.get("era") or ""
    year = abs(d["year"]) if era else d["year"]
    return f"{era}{year}年{d['month']}月{d['day']}日"


# ── 中文时间文本 → 绝对序号 ────────────────────────────────────────────────
_CN_NUM = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _cn_int(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if "十" in s:
        a, _, b = s.partition("十")
        tens = _CN_NUM.get(a, 1) if a else 1
        ones = _CN_NUM.get(b, 0) if b else 0
        return tens * 10 + ones
    if len(s) == 1 and s in _CN_NUM:
        return _CN_NUM[s]
    return None


_TIME_RE = re.compile(
    r"^\s*(?:(?P<era>[^\d\s]{1,6}?)\s*)?(?P<bc>公元前|西元前)?\s*"
    r"(?P<year>-?\d{1,6}|[零一二三四五六七八九十]{1,4})\s*年"
    r"(?:\s*(?P<month>\d{1,2}|[零一二三四五六七八九十]{1,3})\s*月)?"
    r"(?:\s*(?P<day>\d{1,2}|[零一二三四五六七八九十]{1,3})\s*日?)?\s*$")


def parse(text: str, cal: dict) -> dict | None:
    """「开元 1024 年 3 月 15 日」「公元前 221 年」「第三纪 12 年」→ 绝对序号。"""
    m = _TIME_RE.match(text or "")
    if not m:
        return None
    cal = normalize(cal)
    y = _cn_int(m.group("year"))
    if y is None:
        return None
    if y > 0 and (m.group("bc") or "").strip():
        y = -y
    if y > 0:
        era_name = (m.group("era") or "").strip()
        for e in (cal.get("eras") or []):
            if era_name and era_name == str(e.get("name")):
                if int(e.get("sign") or 1) < 0:
                    y = -y
                break
    mo = _cn_int(m.group("month")) if m.group("month") else 1
    d = _cn_int(m.group("day")) if m.group("day") else 1
    abs_day = to_abs(cal, y, mo or 1, d or 1)
    return {"abs": abs_day, "year": y, "month": mo or 1, "day": d or 1, "text": text.strip()}


def describe(cal: dict) -> dict:
    """给界面看的说明：一个月几天、几年一闰、纪元叫什么。"""
    cal = normalize(cal)
    r = cal.get("leap_rule") or {}
    if r.get("leap_years"):
        leap = "手写闰年：" + "、".join(str(y) for y in r["leap_years"][:2]) + "…"
    elif r.get("every"):
        leap = f"每 {r['every']} 年闰一次"
        if r.get("skip_every"):
            leap += f"，但跳过 {r['skip_every']} 的整数倍"
        if r.get("keep_every"):
            leap += f"（{r['keep_every']} 的整数倍除外）"
        leap += f"，闰月第 {cal.get('leap_month')} 月多加 {cal.get('leap_days')} 天"
    else:
        leap = "不设闰年"
    return {"name": cal.get("name") or "", "months": cal["months"],
            "yearDays": sum(cal["months"]), "leapText": leap,
            "eras": [e.get("name") for e in (cal.get("eras") or [])],
            "yearZero": bool(cal.get("year_zero")), "anchor": cal.get("anchor")}
