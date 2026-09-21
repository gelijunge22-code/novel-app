# -*- coding: utf-8 -*-
"""统计与激励：写作日历、进度曲线、码字速度、成本、成就、日报周报。

数字**全部从真实数据算**（章节文件 + writing_day + trace），不做假曲线。
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..security import current_user
from ..store import chapter_files, now_ms

router = APIRouter(tags=["stats"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _days(slug: str, days: int = 30) -> list[dict]:
    d = dbm.db()
    rows = d.query("SELECT * FROM writing_day WHERE slug=? ORDER BY date_key DESC LIMIT ?",
                   (slug, days))
    return list(reversed(rows))


@router.get("/stats/book")
async def book_stats(request: Request, slug: str, days: int = 30):
    current_user(request)
    s = _slug(slug)
    from .books import sync_book
    data = sync_book(s)
    d = dbm.db()
    files = data["chapters"]
    total = data["totalWords"]
    row = d.one("SELECT * FROM book WHERE slug=?", (s,)) or {}
    hist = _days(s, days)
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    today_row = next((h for h in hist if h["date_key"] == today), None)
    streak, cursor = 0, datetime.date.today()
    keys = {h["date_key"] for h in d.query("SELECT date_key FROM writing_day WHERE slug=?", (s,))}
    while cursor.isoformat() in keys:
        streak += 1
        cursor -= datetime.timedelta(days=1)
    days_written = len(keys)
    target = int(row.get("target_words") or 0)
    per_day = [{"date": h["date_key"], "words": h["net_words"],
                "ending": h["ending_words"], "seconds": h["seconds"]} for h in hist]
    avg = round(sum(x["words"] for x in per_day) / len([x for x in per_day if x["words"]])) \
        if any(x["words"] for x in per_day) else 0
    hours = [0] * 24
    for h in d.query("SELECT seconds, updated_at FROM writing_day WHERE slug=?", (s,)):
        if h["seconds"]:
            hours[datetime.datetime.fromtimestamp(h["updated_at"] / 1000).hour] += h["seconds"]
    return {
        "slug": s, "title": row.get("title") or s,
        "totalWords": total, "chapters": len(files),
        "avgPerChapter": round(total / len(files)) if files else 0,
        "todayWords": (today_row or {}).get("net_words", 0) or 0,
        "daysWritten": days_written, "streak": streak,
        "avgPerDay": avg,
        "target": target, "progress": (round(total / target * 100, 1) if target else None),
        "perDay": per_day,
        "perChapter": [{"path": c["path"], "name": c["name"], "words": c["words"]}
                       for c in files],
        "hourSeconds": hours,
        "updatedAt": row.get("updated_at"),
    }


@router.get("/stats/calendar")
async def calendar(request: Request, slug: str, days: int = 120):
    """写作日历（热力图用）：每天写了多少字。"""
    current_user(request)
    s = _slug(slug)
    hist = _days(s, days)
    return {"days": [{"date": h["date_key"], "words": h["net_words"],
                      "ending": h["ending_words"]} for h in hist]}


@router.get("/stats/cost")
async def cost(request: Request, slug: str = "", days: int = 30):
    """token 与金额：按模型、按天。金额按模型库里配的单价算（没配就只给 token）。"""
    current_user(request)
    d = dbm.db()
    since = now_ms() - days * 86400_000
    where, params = "WHERE created_at>=?", [since]
    if slug:
        where += " AND slug=?"
        params.append(_slug(slug))
    rows = d.query("SELECT model, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,"
                   " SUM(cache_read) AS cr, SUM(cache_write) AS cw, COUNT(*) AS calls,"
                   " SUM(duration_ms) AS ms FROM trace " + where + " GROUP BY model", params)
    prices: dict[str, dict] = {}
    for m in d.query("SELECT provider_id, model_id, cost_json FROM provider_model"):
        prices[m["model_id"]] = d.jloads(m["cost_json"], {})
    items, total_cost = [], 0.0
    for r in rows:
        p = prices.get(r["model"] or "", {})
        inp_price = float(p.get("input") or p.get("inputPerM") or 0)
        out_price = float(p.get("output") or p.get("outputPerM") or 0)
        c = (r["inp"] or 0) / 1e6 * inp_price + (r["outp"] or 0) / 1e6 * out_price
        total_cost += c
        items.append({"model": r["model"] or "(未知)", "input": r["inp"] or 0,
                      "output": r["outp"] or 0, "cacheRead": r["cr"] or 0,
                      "cacheWrite": r["cw"] or 0, "calls": r["calls"],
                      "ms": r["ms"] or 0, "cost": round(c, 4),
                      "priced": bool(inp_price or out_price)})
    items.sort(key=lambda x: -(x["input"] + x["output"]))
    daily = d.query("SELECT date(created_at/1000,'unixepoch','localtime') AS day,"
                    " SUM(input_tokens) AS inp, SUM(output_tokens) AS outp FROM trace "
                    + where + " GROUP BY day ORDER BY day DESC LIMIT ?", params + [days])
    return {"items": items, "totalCost": round(total_cost, 4), "days": days,
            "daily": list(reversed(daily)), "currency": "元"}


# ── 成就 ────────────────────────────────────────────────────────────────────
ACHIEVEMENTS = [
    {"key": "first_chapter", "title": "第一章", "hint": "写下一章", "kind": "chapters", "at": 1},
    {"key": "ten_chapters", "title": "十章", "hint": "写到十章", "kind": "chapters", "at": 10},
    {"key": "fifty_chapters", "title": "五十章", "hint": "写到五十章", "kind": "chapters", "at": 50},
    {"key": "hundred_chapters", "title": "百章", "hint": "写到一百章", "kind": "chapters", "at": 100},
    {"key": "words_10k", "title": "一万字", "hint": "全书一万字", "kind": "words", "at": 10000},
    {"key": "words_50k", "title": "五万字", "hint": "全书五万字", "kind": "words", "at": 50000},
    {"key": "words_100k", "title": "十万字", "hint": "全书十万字", "kind": "words", "at": 100000},
    {"key": "words_500k", "title": "五十万字", "hint": "全书五十万字", "kind": "words", "at": 500000},
    {"key": "words_1m", "title": "百万字", "hint": "全书一百万字", "kind": "words", "at": 1000000},
    {"key": "streak_3", "title": "连写三天", "hint": "连续三天动笔", "kind": "streak", "at": 3},
    {"key": "streak_7", "title": "连写一周", "hint": "连续七天动笔", "kind": "streak", "at": 7},
    {"key": "streak_30", "title": "连写一月", "hint": "连续三十天动笔", "kind": "streak", "at": 30},
    {"key": "day_3000", "title": "一天三千", "hint": "单日写满三千字", "kind": "dayWords", "at": 3000},
    {"key": "world_10", "title": "世界成形", "hint": "世界引擎里攒够 10 个实体", "kind": "entities", "at": 10},
    {"key": "promise_keeper", "title": "伏笔不欠", "hint": "至少兑现一条伏笔，且没有欠着的", "kind": "promises", "at": 1},
    {"key": "clean_hand", "title": "干净的手", "hint": "有一章质检 90 分以上", "kind": "lint", "at": 90},
]


def _measure(slug: str) -> dict:
    from .books import sync_book
    from ..store import read_text
    from ..engine import lint as L
    data = sync_book(slug)
    d = dbm.db()
    words = data["totalWords"]
    chapters = len(data["chapters"])
    keys = {r["date_key"] for r in d.query(
        "SELECT date_key FROM writing_day WHERE slug=?", (slug,))}
    streak, cursor = 0, datetime.date.today()
    while cursor.isoformat() in keys:
        streak += 1
        cursor -= datetime.timedelta(days=1)
    best_day = d.scalar("SELECT MAX(net_words) FROM writing_day WHERE slug=?", (slug,)) or 0
    entities = d.scalar("SELECT COUNT(*) FROM entity WHERE slug=?", (slug,)) or 0
    paid = d.scalar("SELECT COUNT(*) FROM promise WHERE slug=? AND status='paid'", (slug,)) or 0
    openp = d.scalar("SELECT COUNT(*) FROM promise WHERE slug=? AND status IN ('open','advanced')",
                     (slug,)) or 0
    best_lint = 0
    for c in data["chapters"][:40]:
        try:
            best_lint = max(best_lint, L.scan(read_text(slug, c["path"])).get("stats", {})
                            .get("score", 0))
        except Exception:
            # 某章质检失败 = 它不参与「最佳分」，统计页其余数字照给。
            pass
    return {"chapters": chapters, "words": words, "streak": streak, "dayWords": best_day,
            "entities": entities,
            "promises": (paid if (paid and not openp) else 0), "lint": best_lint}


@router.get("/stats/achievements")
async def achievements(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    m = _measure(s)
    now = now_ms()
    out = []
    for a in ACHIEVEMENTS:
        cur = int(m.get(a["kind"], 0) or 0)
        got = cur >= a["at"]
        row = dbm.db().one("SELECT * FROM achievement WHERE slug=? AND key=?", (s, a["key"]))
        if got and (not row or not row["unlocked_at"]):
            dbm.db().execute(
                "INSERT INTO achievement(slug,key,title,unlocked_at,progress,detail_json)"
                " VALUES(?,?,?,?,?,?) ON CONFLICT(slug,key) DO UPDATE SET"
                " unlocked_at=excluded.unlocked_at, progress=excluded.progress",
                (s, a["key"], a["title"], now, cur,
                 dbm.Database.jdumps({"at": a["at"], "cur": cur})))
            dbm.db().execute("INSERT INTO notification(kind,title,body,slug,created_at)"
                             " VALUES('achievement',?,?,?,?)",
                             ("解锁成就：" + a["title"], a["hint"], s, now))
        elif row and not got:
            dbm.db().execute("UPDATE achievement SET progress=? WHERE id=?", (cur, row["id"]))
        out.append({"key": a["key"], "title": a["title"], "hint": a["hint"],
                    "at": a["at"], "progress": cur, "done": got,
                    "unlockedAt": (row["unlocked_at"] if row else (now if got else None))})
    done = len([x for x in out if x["done"]])
    return {"items": out, "done": done, "total": len(out),
            "percent": round(done / len(out) * 100)}


@router.get("/stats/report")
async def report(request: Request, slug: str, kind: str = "week"):
    """日报 / 周报：直接给一段能读的中文，前端贴出来就行。"""
    current_user(request)
    s = _slug(slug)
    days = 7 if kind == "week" else 1 if kind == "day" else 30
    m = _measure(s)
    hist = _days(s, days)
    written = [h for h in hist if (h["net_words"] or 0) > 0]
    total = sum(h["net_words"] or 0 for h in hist)
    label = {"day": "今天", "week": "这一周", "month": "这个月"}.get(kind, f"最近 {days} 天")
    head = (f"《{dbm.db().scalar('SELECT title FROM book WHERE slug=?', (s,)) or s}》"
            f"{label}")
    if not written:
        body = f"{label}还没有动笔。全书现在 {m['words']} 字、{m['chapters']} 章。"
    else:
        best = max(written, key=lambda h: h["net_words"] or 0)
        body = (f"{len(written)} 天有写，共 {total} 字，平均每天 "
                f"{round(total / len(written))} 字；最多的一天是 {best['date_key']}"
                f"（{best['net_words']} 字）。全书现在 {m['words']} 字、{m['chapters']} 章，"
                f"连续写作 {m['streak']} 天。")
    d = dbm.db()
    at = d.one("SELECT * FROM promise WHERE slug=? AND status IN ('open','advanced')"
               " ORDER BY id LIMIT 5", (s,))
    if at:
        body += f"\n还欠着读者：{at['name']}。"
    return {"kind": kind, "markdown": f"## {head}\n\n{body}", "text": body,
            "days": [{"date": h["date_key"], "words": h["net_words"] or 0} for h in hist],
            "measured": m}
