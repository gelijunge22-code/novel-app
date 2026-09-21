# -*- coding: utf-8 -*-
"""剧情工坊：承载树（卷→章→场景）、因果树（剧情线）、承诺账本（伏笔）、决策记录。

一句话：**「这章要发生什么、埋的线还没收、当初为什么这么写」都在这儿。**
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from ..security import current_user
from ..store import chapter_files, now_ms

router = APIRouter(tags=["plot"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _now() -> int:
    return now_ms()


def _j(v, default=None):
    return dbm.Database.jloads(v, default if default is not None else {})


def _jd(v) -> str:
    return dbm.Database.jdumps(v)


def _chapter_rows(slug: str) -> list[dict]:
    from .books import sync_book
    sync_book(slug)
    return dbm.db().query(
        "SELECT * FROM chapter WHERE slug=? ORDER BY order_no, path", (slug,))


def _synced(slug: str) -> dict:
    """磁盘上的章节是真相；这里保证 chapter 表最新。"""
    from .books import sync_book
    return sync_book(slug)


# ── 总览：一根给前端画的完整骨架 ────────────────────────────────────────────
@router.get("/plot/overview")
async def overview(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    data = _synced(s)
    d = dbm.db()
    chapters = _chapter_rows(s)
    scenes = d.query("SELECT * FROM scene WHERE slug=? ORDER BY chapter_path, order_no", (s,))
    outlines = d.query("SELECT * FROM outline WHERE slug=? ORDER BY id", (s,))
    threads = d.query("SELECT * FROM thread WHERE slug=? ORDER BY order_no, id", (s,))
    promises = d.query("SELECT * FROM promise WHERE slug=? ORDER BY id", (s,))
    decisions = d.query("SELECT * FROM decision WHERE slug=? ORDER BY at DESC LIMIT 100", (s,))
    acts = d.query("SELECT * FROM act WHERE slug=? ORDER BY number", (s,))
    by_ch_scenes: dict[str, list] = {}
    for sc in scenes:
        sc["cast"] = _j(sc["cast_json"], [])
        sc["labelIds"] = _j(sc["label_ids_json"], [])
        by_ch_scenes.setdefault(sc["chapter_path"], []).append(sc)
    by_ch_outline: dict[str, list] = {}
    for o in outlines:
        by_ch_outline.setdefault(o["chapter_path"] or "", []).append(o)
    ts = d.query("SELECT thread_id, scene_path, order_no FROM thread_scene WHERE slug=?"
                 " ORDER BY thread_id, order_no", (s,))
    by_thread: dict[int, list] = {}
    for t in ts:
        by_thread.setdefault(t["thread_id"], []).append(t["scene_path"])
    for t in threads:
        t["scenes"] = by_thread.get(t["id"], [])
    meta_rows = {r["path"]: r for r in d.query("SELECT * FROM chapter_meta WHERE slug=?", (s,))}
    for ch in chapters:
        ch["meta"] = _j(ch["info_control_json"], {})
        cm = meta_rows.get(ch["path"])
        ch["cast"] = _j(cm["cast_json"], []) if cm else []
        ch["events"] = _j(cm["events_json"], []) if cm else []
        ch["scenes"] = by_ch_scenes.get(ch["path"], [])
        ch["outline"] = by_ch_outline.get(ch["path"], [])
        ch["promises"] = [p for p in promises
                          if p["setup_scene"] == ch["path"] or p["payoff_scene"] == ch["path"]]
    return {
        "slug": s, "title": d.scalar("SELECT title FROM book WHERE slug=?", (s,)) or s,
        "totalWords": data["totalWords"],
        "acts": acts, "chapters": chapters, "threads": threads,
        "promises": promises, "decisions": decisions,
        "scenes": scenes,
        "counts": {
            "chapters": len(chapters), "scenes": len(scenes),
            "threads": len(threads),
            "promisesOpen": len([p for p in promises if p["status"] in ("open", "advanced")]),
            "promisesPaid": len([p for p in promises if p["status"] == "paid"]),
            "decisions": len(decisions),
        },
    }


# ── 卷 ──────────────────────────────────────────────────────────────────────
@router.post("/plot/act")
async def act_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    number = num(payload.get("number"), 0, name="幕号")
    if number <= 0:
        number = (dbm.db().scalar("SELECT MAX(number) FROM act WHERE slug=?", (s,)) or 0) + 1
    dbm.db().execute(
        "INSERT INTO act(slug,number,title,summary,label_ids_json) VALUES(?,?,?,?,?)"
        " ON CONFLICT(slug,number) DO UPDATE SET title=excluded.title, summary=excluded.summary,"
        " label_ids_json=excluded.label_ids_json",
        (s, number, str(payload.get("title") or f"第{number}卷"),
         str(payload.get("summary") or ""), _jd(payload.get("labelIds") or [])))
    return {"ok": True, "number": number}


@router.delete("/plot/act")
async def act_delete(request: Request, number: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    dbm.db().execute("DELETE FROM act WHERE slug=? AND number=?", (s, number))
    return {"ok": True}


# ── 章节元信息（状态机 / 目标字数 / 视角 / 信息控制）────────────────────────
@router.patch("/plot/chapter")
async def chapter_meta(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    path = str(payload.get("path") or "")
    if not dbm.db().one("SELECT id FROM chapter WHERE slug=? AND path=?", (s, path)):
        _synced(s)
    if not dbm.db().one("SELECT id FROM chapter WHERE slug=? AND path=?", (s, path)):
        raise HTTPException(404, "没有这一章")
    cur = dbm.db().one("SELECT * FROM chapter WHERE slug=? AND path=?", (s, path))
    fields = {
        "status": payload.get("status", cur["status"]),
        "target_words": num(payload.get("targetWords"), cur["target_words"] or 0, lo=0,
                            name="目标字数"),
        "pov": payload.get("pov", cur["pov"]),
        "summary": payload.get("summary", cur["summary"]),
        "title": payload.get("title", cur["title"]),
        "act_number": num(payload.get("actNumber"), cur["act_number"] or 1, name="所属幕"),
    }
    meta = payload.get("infoControl")
    info = _jd(meta) if isinstance(meta, dict) else cur["info_control_json"]
    d = dbm.db()
    d.execute(
        "UPDATE chapter SET status=?, target_words=?, pov=?, summary=?, title=?, act_number=?,"
        " info_control_json=?, updated_at=? WHERE slug=? AND path=?",
        (fields["status"], fields["target_words"], fields["pov"], fields["summary"],
         fields["title"], fields["act_number"], info, _now(), s, path))
    # 出场角色 / 关键事件（15.2）：存在侧表里，跟正文互不干扰
    if payload.get("cast") is not None or payload.get("events") is not None:
        old_meta = _chapter_meta_one(s, path) or {}
        cast = payload.get("cast")
        if cast is None:
            cast = old_meta.get("cast") or []
        if isinstance(cast, str):
            cast = [x for x in re.split(r"[，,、\s]+", cast) if x]
        cast = [str(x).strip() for x in (cast or []) if str(x).strip()]
        ev = payload.get("events")
        if ev is None:
            ev = old_meta.get("events") or []
        if isinstance(ev, str):
            ev = [x.strip() for x in ev.splitlines() if x.strip()]
        ev = [str(x).strip() for x in (ev or []) if str(x).strip()]
        d.execute(
            "INSERT INTO chapter_meta(slug,path,cast_json,events_json,updated_at)"
            " VALUES(?,?,?,?,?) ON CONFLICT(slug,path) DO UPDATE SET cast_json=excluded.cast_json,"
            " events_json=excluded.events_json, updated_at=excluded.updated_at",
            (s, path, d.jdumps(cast), d.jdumps(ev), _now()))
    out = d.one("SELECT * FROM chapter WHERE slug=? AND path=?", (s, path))
    out.update(_chapter_meta_one(s, path) or {"cast": [], "events": []})
    return {"ok": True, "chapter": out}


def _chapter_meta_one(slug: str, path: str) -> dict | None:
    """一章的出场角色 / 关键事件（15.2），表见 migrations/0004。"""
    r = dbm.db().one("SELECT * FROM chapter_meta WHERE slug=? AND path=?", (slug, path))
    if not r:
        return None
    return {"cast": _j(r["cast_json"], []), "events": _j(r["events_json"], []),
            "castCount": len(_j(r["cast_json"], [])), "eventCount": len(_j(r["events_json"], []))}


STATUSES = ("idea", "outline", "detail", "draft", "polished", "final")


# ── 细纲 ────────────────────────────────────────────────────────────────────
@router.get("/plot/outline")
async def outline_get(request: Request, slug: str, path: str = ""):
    current_user(request)
    s = _slug(slug)
    if path:
        rows = dbm.db().query(
            "SELECT * FROM outline WHERE slug=? AND chapter_path=? ORDER BY level, id", (s, path))
    else:
        rows = dbm.db().query("SELECT * FROM outline WHERE slug=? ORDER BY id", (s,))
    return {"items": rows}


@router.post("/plot/outline")
async def outline_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    oid = payload.get("id")
    body = str(payload.get("body") or "")
    if not body.strip():
        raise HTTPException(400, "细纲不能是空的")
    level = payload.get("level") or "detail"
    if level not in ("act", "chapter", "detail"):
        raise HTTPException(400, "level 只能是 act/chapter/detail")
    d = dbm.db()
    if oid:
        if not d.one("SELECT id FROM outline WHERE id=? AND slug=?", (oid, s)):
            raise HTTPException(404, "没有这条细纲")
        d.execute("UPDATE outline SET body=?, level=?, approved=?, updated_at=? WHERE id=?",
                  (body, level, 1 if payload.get("approved") else 0, _now(), oid))
        return {"ok": True, "id": oid}
    nid = d.execute(
        "INSERT INTO outline(slug,chapter_path,level,body,approved,updated_at) VALUES(?,?,?,?,?,?)",
        (s, str(payload.get("path") or ""), level, body,
         1 if payload.get("approved") else 0, _now()))
    return {"ok": True, "id": nid}


@router.post("/plot/outline/approve")
async def outline_approve(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    ids = payload.get("ids") or ([payload["id"]] if payload.get("id") else [])
    for i in ids:
        dbm.db().execute("UPDATE outline SET approved=1 WHERE id=? AND slug=?", (i, s))
    return {"ok": True, "count": len(ids)}


@router.delete("/plot/outline")
async def outline_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM outline WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这条细纲")
    dbm.db().execute("DELETE FROM outline WHERE id=?", (id,))
    return {"ok": True}


# ── 场景 ────────────────────────────────────────────────────────────────────
@router.post("/plot/scene")
async def scene_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    d = dbm.db()
    sid = payload.get("id")
    values = (str(payload.get("chapterPath") or ""), str(payload.get("title") or ""),
              str(payload.get("summary") or ""), payload.get("worldMomentId"),
              payload.get("locationId"), _jd(payload.get("cast") or []),
              str(payload.get("status") or "outline"), _jd(payload.get("labelIds") or []))
    if sid:
        if not d.one("SELECT id FROM scene WHERE id=? AND slug=?", (sid, s)):
            raise HTTPException(404, "没有这个场景")
        d.execute("UPDATE scene SET chapter_path=?, title=?, summary=?, world_moment_id=?,"
                  " location_id=?, cast_json=?, status=?, label_ids_json=?, updated_at=?"
                  " WHERE id=?",
                  (*values, _now(), sid))
        return {"ok": True, "id": sid}
    order = (d.scalar("SELECT MAX(order_no) FROM scene WHERE slug=? AND chapter_path=?",
                      (s, values[0])) or 0) + 1
    nid = d.execute(
        "INSERT INTO scene(slug,chapter_path,order_no,title,summary,world_moment_id,location_id,"
        "cast_json,status,label_ids_json,words,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)",
        (s, values[0], order, values[1], values[2], values[3], values[4], values[5],
         values[6], values[7], _now()))
    return {"ok": True, "id": nid, "order": order}


@router.delete("/plot/scene")
async def scene_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM scene WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这个场景")
    dbm.db().execute("DELETE FROM scene WHERE id=?", (id,))
    return {"ok": True}


# ── 剧情线（因果树）─────────────────────────────────────────────────────────
@router.post("/plot/thread")
async def thread_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    d = dbm.db()
    tid = payload.get("id")
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "剧情线得有名字")
    if tid:
        if not d.one("SELECT id FROM thread WHERE id=? AND slug=?", (tid, s)):
            raise HTTPException(404, "没有这条剧情线")
        # origin='user'：**这条路是用户在界面上改的**（AI 走 agent_runtime 的
        # outline_write 工具，那条路写 origin='ai'）。用户改过的大纲，AI 不许自行覆盖 ——
        # 所以每次用户存一次就重置成 user（哪怕之前是 AI 补的）。
        d.execute("UPDATE thread SET name=?, kind=?, status=?, summary=?, origin='user',"
                  " updated_at=? WHERE id=?",
                  (name, str(payload.get("kind") or "main"),
                   str(payload.get("status") or "open"),
                   str(payload.get("summary") or ""), _now(), tid))
    else:
        try:
            tid = d.execute(
                "INSERT INTO thread(slug,name,kind,status,summary,order_no,updated_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (s, name, str(payload.get("kind") or "main"),
                 str(payload.get("status") or "open"), str(payload.get("summary") or ""),
                 (d.scalar("SELECT MAX(order_no) FROM thread WHERE slug=?", (s,)) or 0) + 1,
                 _now()))
        except Exception:
            raise HTTPException(400, "已经有一条同名剧情线了")
    if payload.get("scenes") is not None:
        d.execute("DELETE FROM thread_scene WHERE slug=? AND thread_id=?", (s, tid))
        for i, p in enumerate(payload["scenes"]):
            d.execute("INSERT INTO thread_scene(slug,thread_id,scene_path,order_no)"
                      " VALUES(?,?,?,?)", (s, tid, str(p), i))
    return {"ok": True, "id": tid, "name": name}


@router.delete("/plot/thread")
async def thread_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    d = dbm.db()
    if not d.one("SELECT id FROM thread WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这条剧情线")
    d.execute("DELETE FROM thread_scene WHERE thread_id=?", (id,))
    d.execute("DELETE FROM thread WHERE id=?", (id,))
    return {"ok": True}


# ── 承诺账本（伏笔埋下 / 推进 / 兑现）───────────────────────────────────────
@router.post("/plot/promise")
async def promise_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    d = dbm.db()
    pid = payload.get("id")
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "伏笔得有名字")
    if pid:
        if not d.one("SELECT id FROM promise WHERE id=? AND slug=?", (pid, s)):
            raise HTTPException(404, "没有这条伏笔")
        d.execute("UPDATE promise SET name=?, kind=?, status=?, setup_scene=?, payoff_scene=?,"
                  " due_chapter=?, note=?, updated_at=? WHERE id=?",
                  (name, str(payload.get("kind") or "foreshadow"),
                   str(payload.get("status") or "open"),
                   str(payload.get("setupScene") or ""),
                   str(payload.get("payoffScene") or ""),
                   str(payload.get("dueChapter") or ""), str(payload.get("note") or ""),
                   _now(), pid))
        return {"ok": True, "id": pid}
    try:
        pid = d.execute(
            "INSERT INTO promise(slug,name,kind,status,setup_scene,payoff_scene,due_chapter,"
            "advance_json,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'[]',?,?,?)",
            (s, name, str(payload.get("kind") or "foreshadow"),
             str(payload.get("status") or "open"), str(payload.get("setupScene") or ""),
             str(payload.get("payoffScene") or ""), str(payload.get("dueChapter") or ""),
             str(payload.get("note") or ""), _now(), _now()))
    except Exception:
        raise HTTPException(400, "已经有一条同名伏笔了")
    return {"ok": True, "id": pid}


@router.post("/plot/promise/advance")
async def promise_advance(request: Request, payload: dict = Body(...)):
    """推进一步：记下「在哪一章做了什么」，还没兑现就继续挂着。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    d = dbm.db()
    row = d.one("SELECT * FROM promise WHERE id=? AND slug=?", (payload.get("id"), s))
    if not row:
        raise HTTPException(404, "没有这条伏笔")
    steps = _j(row["advance_json"], [])
    if isinstance(steps, dict):
        steps = [steps]
    steps.append({"at": payload.get("scene") or payload.get("chapter") or "",
                  "note": str(payload.get("note") or ""),
                  "when": _now()})
    status = payload.get("status") or ("paid" if payload.get("payoff") else "advanced")
    if status not in ("open", "advanced", "paid", "dropped"):
        raise HTTPException(400, "状态只能是 open/advanced/paid/dropped")
    d.execute("UPDATE promise SET advance_json=?, status=?, payoff_scene=COALESCE(NULLIF(?,''),"
              " payoff_scene), updated_at=? WHERE id=?",
              (_jd(steps), status, str(payload.get("payoffScene") or ""), _now(), row["id"]))
    return {"ok": True, "id": row["id"], "status": status, "steps": len(steps)}


@router.delete("/plot/promise")
async def promise_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM promise WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这条伏笔")
    dbm.db().execute("DELETE FROM promise WHERE id=?", (id,))
    return {"ok": True}


@router.get("/plot/promises/due")
async def promises_due(request: Request, slug: str, before: str = ""):
    """到期 / 快要到期的伏笔（按章节顺序排，写到这一章该想起来还欠着读者什么）。"""
    current_user(request)
    s = _slug(slug)
    order = {c["path"]: i for i, c in enumerate(_chapter_rows(s))}
    rows = dbm.db().query("SELECT * FROM promise WHERE slug=? AND status IN ('open','advanced')"
                          " ORDER BY id", (s,))
    for r in rows:
        r["steps"] = _j(r["advance_json"], [])
        r["dueIndex"] = order.get(r["due_chapter"])
    rows.sort(key=lambda r: (r["dueIndex"] is None, r["dueIndex"] or 0))
    return {"items": rows, "chapters": list(order.keys())}


# ── 决策记录 ────────────────────────────────────────────────────────────────
@router.post("/plot/decision")
async def decision_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "决策得有个标题")
    did = dbm.db().execute(
        "INSERT INTO decision(slug,at,chapter_path,title,reason,risks,status) VALUES(?,?,?,?,?,?,?)",
        (s, _now(), str(payload.get("chapterPath") or ""), title,
         str(payload.get("reason") or ""), str(payload.get("risks") or ""), "active"))
    return {"ok": True, "id": did}


@router.post("/plot/decision/supersede")
async def decision_supersede(request: Request, payload: dict = Body(...)):
    """推翻一条旧决策 —— 旧的不删，留痕。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    old = dbm.db().one("SELECT * FROM decision WHERE id=? AND slug=?", (payload.get("id"), s))
    if not old:
        raise HTTPException(404, "没有这条决策")
    title = str(payload.get("title") or f"改掉：{old['title']}")
    d = dbm.db()
    nid = d.execute(
        "INSERT INTO decision(slug,at,chapter_path,title,reason,risks,status) VALUES(?,?,?,?,?,?,?)",
        (s, _now(), str(payload.get("chapterPath") or old["chapter_path"]), title,
         str(payload.get("reason") or ""), str(payload.get("risks") or ""), "active"))
    d.execute("UPDATE decision SET status='superseded', superseded_by=? WHERE id=?", (nid, old["id"]))
    return {"ok": True, "id": nid, "superseded": old["id"]}


@router.delete("/plot/decision")
async def decision_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM decision WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这条决策")
    dbm.db().execute("DELETE FROM decision WHERE id=?", (id,))
    return {"ok": True}


# ── 角色出场统计 + 消失的角色 ───────────────────────────────────────────────
@router.get("/plot/cast")
async def cast_stats(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    from .books import sync_book
    sync_book(s)
    names = dbm.db().query(
        "SELECT e.id, e.name, e.kind, (SELECT GROUP_CONCAT(a.alias, char(1)) FROM entity_alias a"
        " WHERE a.entity_id=e.id) AS aliases FROM entity e WHERE e.slug=?", (s,))
    chapters = _chapter_rows(s)
    texts = []
    from ..store import read_text
    for c in chapters:
        try:
            texts.append((c, read_text(s, c["path"])))
        except Exception:
            texts.append((c, ""))
    out = []
    for n in names:
        alts = [n["name"]] + [x for x in (n["aliases"] or "").split(chr(1)) if x]
        hits = [c["title"] or c["path"] for c, t in texts if any(a and a in t for a in alts)]
        last = len(texts) - 1 - max((i for i, (c, t) in enumerate(texts)
                                     if any(a and a in t for a in alts)), default=-1)
        out.append({"id": n["id"], "name": n["name"], "kind": n["kind"],
                    "chapters": hits, "count": len(hits), "silentFor": last})
    out.sort(key=lambda x: -x["count"])
    gone = [x for x in out if x["count"] and x["silentFor"] >= 5]
    return {"items": out, "vanished": gone,
            "unit": {c["path"]: (c["title"] or c["path"]) for c in chapters}}
