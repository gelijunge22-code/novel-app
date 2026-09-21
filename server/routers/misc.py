# -*- coding: utf-8 -*-
"""零碎但离不了的东西：书签、阅读进度、术语表、素材库、审计日志、
全文替换、增量同步（离线用）。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from ..security import current_user
from ..store import chapter_files, now_ms, read_text

router = APIRouter(tags=["misc"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _audit(action: str, slug: str, path: str = "", **detail) -> None:
    dbm.db().execute(
        "INSERT INTO audit(at,actor,action,slug,path,detail_json) VALUES(?,?,?,?,?,?)",
        (now_ms(), "user", action, slug, path, dbm.Database.jdumps(detail)))


# ── 书签 ────────────────────────────────────────────────────────────────────
@router.get("/bookmarks")
async def bookmarks(request: Request, slug: str, path: str = ""):
    current_user(request)
    s = _slug(slug)
    if path:
        rows = dbm.db().query("SELECT * FROM bookmark WHERE slug=? AND path=?"
                              " ORDER BY percent", (s, path))
    else:
        rows = dbm.db().query("SELECT * FROM bookmark WHERE slug=?"
                              " ORDER BY created_at DESC LIMIT 200", (s,))
    return {"items": rows}


@router.post("/bookmarks")
async def bookmark_add(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    path = str(payload.get("path") or "")
    if not path:
        raise HTTPException(400, "得说清是哪一章")
    bid = dbm.db().execute(
        "INSERT INTO bookmark(slug,path,percent,text,created_at) VALUES(?,?,?,?,?)",
        (s, path, num(payload.get("percent"), 0.0, kind=float, lo=0, hi=100, name="书签位置"),
         str(payload.get("text") or "")[:200],
         now_ms()))
    return {"ok": True, "id": bid}


@router.delete("/bookmarks")
async def bookmark_delete(request: Request, id: int = 0, slug: str = "", path: str = "",
                          percent: float = -1):
    current_user(request)
    s = _slug(slug)
    d = dbm.db()
    if id:
        d.execute("DELETE FROM bookmark WHERE id=? AND slug=?", (id, s))
    elif path:
        d.execute("DELETE FROM bookmark WHERE slug=? AND path=? AND percent BETWEEN ? AND ?",
                  (s, path, max(0.0, percent - 0.005), percent + 0.005))
    else:
        raise HTTPException(400, "要删哪个书签？")
    return {"ok": True}


# ── 阅读进度 ────────────────────────────────────────────────────────────────
@router.get("/progress")
async def progress_get(request: Request, slug: str = ""):
    current_user(request)
    d = dbm.db()
    if slug:
        s = _slug(slug)
        row = d.one("SELECT * FROM reading_progress WHERE slug=?", (s,))
        if row:
            row["extra"] = d.jloads(row["extra_json"], {})
        return {"progress": row}
    rows = d.query("SELECT * FROM reading_progress ORDER BY updated_at DESC LIMIT 100")
    return {"items": rows}


@router.post("/progress")
async def progress_set(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    dbm.db().execute(
        "INSERT INTO reading_progress(slug,path,percent,extra_json,updated_at)"
        " VALUES(?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET path=excluded.path,"
        " percent=excluded.percent, extra_json=excluded.extra_json,"
        " updated_at=excluded.updated_at",
        (s, str(payload.get("path") or ""),
         num(payload.get("percent"), 0.0, kind=float, lo=0, hi=100, name="阅读进度"),
         dbm.Database.jdumps(payload.get("extra") or {}), now_ms()))
    return {"ok": True}


# ── 术语表 ──────────────────────────────────────────────────────────────────
@router.get("/term")
async def term_list(request: Request, slug: str, q: str = ""):
    current_user(request)
    s = _slug(slug)
    rows = dbm.db().query("SELECT * FROM term WHERE slug=? ORDER BY name", (s,))
    for r in rows:
        r["aliases"] = dbm.Database.jloads(r["aliases_json"], [])
    if q.strip():
        n = q.strip().lower()
        rows = [r for r in rows if n in r["name"].lower()
                or any(n in a.lower() for a in r["aliases"])]
    return {"items": rows}


@router.post("/term")
async def term_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "术语得有名字")
    aliases = [str(a).strip() for a in (payload.get("aliases") or []) if str(a).strip()]
    tid = payload.get("id")
    d = dbm.db()
    if tid:
        if not d.one("SELECT id FROM term WHERE id=? AND slug=?", (tid, s)):
            raise HTTPException(404, "没有这条术语")
        d.execute("UPDATE term SET name=?, aliases_json=?, kind=?, note=?, updated_at=?"
                  " WHERE id=?",
                  (name, dbm.Database.jdumps(aliases), str(payload.get("kind") or ""),
                   str(payload.get("note") or ""), now_ms(), tid))
        return {"ok": True, "id": tid}
    try:
        tid = d.execute("INSERT INTO term(slug,name,aliases_json,kind,note,updated_at)"
                        " VALUES(?,?,?,?,?,?)",
                        (s, name, dbm.Database.jdumps(aliases),
                         str(payload.get("kind") or ""), str(payload.get("note") or ""),
                         now_ms()))
    except Exception:
        raise HTTPException(400, "已经有一条同名术语了")
    return {"ok": True, "id": tid}


@router.delete("/term")
async def term_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM term WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这条术语")
    dbm.db().execute("DELETE FROM term WHERE id=?", (id,))
    return {"ok": True}


@router.post("/term/check")
async def term_check(request: Request, payload: dict = Body(...)):
    """一致性扫描：同一个东西的不同叫法、以及术语写错的字。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    terms = dbm.db().query("SELECT * FROM term WHERE slug=?", (s,))
    files = chapter_files(s)
    issues = []
    for t in terms:
        aliases = dbm.Database.jloads(t["aliases_json"], [])
        for a in aliases:
            if not a or a == t["name"]:
                continue
            for c in files:
                try:
                    text = read_text(s, c["path"])
                except Exception:
                    continue
                if a in text:
                    issues.append({"kind": "alias", "term": t["name"], "variant": a,
                                   "path": c["path"], "name": c["name"],
                                   "hint": f"这里用的是「{a}」，术语表里写的是「{t['name']}」"})
                    break
    for c in files[:60]:
        try:
            text = read_text(s, c["path"])
        except Exception:
            continue
        for t in terms:
            name = t["name"]
            for i in range(len(name) - 1):
                bad = name[:i] + name[i + 1] + name[i] + name[i + 2:]
                if bad != name and bad in text:
                    issues.append({"kind": "typo", "term": name, "variant": bad,
                                   "path": c["path"], "name": c["name"],
                                   "hint": f"「{bad}」是不是「{name}」写错了"})
                    break
    return {"items": issues[:200], "count": len(issues)}


# ── 素材库 ──────────────────────────────────────────────────────────────────
# 一条素材的正文可能有几万字（真实那本书里 11 条 = 16.8 万字）。列表接口老是把整段正文吐出来，
# 列表页也就把 16.8 万字全塞进 DOM —— 手机上滚动发涩、找东西困难，而且用户根本不想在列表里读全文。
# 现在：列表默认走"摘要模式"（body 截到 PREVIEW_CHARS，另给 bodyLen 说明真有多长），
# 想看全文点进详情页（/material/item 拿完整的一条）。默认不截断这一点刻意保留给老调用方。
PREVIEW_CHARS = 160
# 摘要结尾允许往前找的"断得好看"的字符：句末标点优先，其次分句标点，再其次空格。
_CLIP_STRONG = "。！？…"
_CLIP_WEAK = "；;.!?、，,：: "
_MD_HEAD = re.compile(r"^#{1,6}\s*", re.M)
_MD_QUOTE = re.compile(r"^\s{0,3}>\s?", re.M)


def _clip(text: str, n: int = PREVIEW_CHARS) -> tuple[str, bool]:
    """截摘要：尽量断在句号/逗号/空格后面，别把词切一半。

    以前是 body[:160] 硬切，列表里常出现「...角色」「避免...」这种断在介词、
    标点后面的半截话（同一条素材断法还不一样，看着像没加载完）。
    现在先找句末标点，找不到退到分句标点，再找不到退到空格；都没有才硬切。
    """
    if len(text) <= n:
        return text, False
    window = text[:n]
    for chars, floor in ((_CLIP_STRONG, int(n * 0.5)), (_CLIP_WEAK, int(n * 0.7))):
        best = -1
        for ch in chars:
            i = window.rfind(ch)
            if i > best:
                best = i
        if best >= floor:
            return text[:best + 1].rstrip(), True
    return window.rstrip(), True


def _preview_text(body: str) -> tuple[str, bool]:
    """列表里给人看的一小段：先把 markdown 记号洗掉（不该让用户看 `> **` 这种生符号）。"""
    t = (body or "").strip()
    t = _MD_HEAD.sub("", t)
    t = _MD_QUOTE.sub("", t)
    t = t.replace("**", "").replace("__", "").replace("`", "")
    t = re.sub(r"\s+", " ", t).strip()
    return _clip(t)


def _material_row(r: dict, preview: bool) -> dict:
    r["tags"] = dbm.Database.jloads(r.get("tags_json") or "[]", [])
    body = r.get("body") or ""
    r["bodyLen"] = len(body)
    if preview:
        r["body"], r["truncated"] = _preview_text(body)
    return r


@router.get("/material")
async def material_list(request: Request, slug: str, kind: str = "", tag: str = "",
                        preview: int = 0):
    current_user(request)
    s = _slug(slug)
    rows = dbm.db().query("SELECT * FROM material WHERE slug=? ORDER BY updated_at DESC", (s,))
    rows = [_material_row(dict(r), bool(preview)) for r in rows]
    if kind:
        rows = [r for r in rows if r["kind"] == kind]
    if tag:
        rows = [r for r in rows if tag in r["tags"]]
    return {"items": rows, "preview": bool(preview), "count": len(rows)}


@router.get("/material/item")
async def material_item(request: Request, slug: str, id: int):
    """单条素材的全文（列表走摘要，点开才取全文）。"""
    current_user(request)
    s = _slug(slug)
    row = dbm.db().one("SELECT * FROM material WHERE id=? AND slug=?", (id, s))
    if not row:
        raise HTTPException(404, "没有这条素材")
    return {"item": _material_row(dict(row), False)}


@router.post("/material")
async def material_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    title = str(payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "素材得有个标题")
    tags = [str(t).strip() for t in (payload.get("tags") or []) if str(t).strip()]
    mid = payload.get("id")
    d = dbm.db()
    if mid:
        if not d.one("SELECT id FROM material WHERE id=? AND slug=?", (mid, s)):
            raise HTTPException(404, "没有这条素材")
        d.execute("UPDATE material SET kind=?, title=?, body=?, tags_json=?, path=?,"
                  " updated_at=? WHERE id=?",
                  (str(payload.get("kind") or "note"), title, str(payload.get("body") or ""),
                   dbm.Database.jdumps(tags), str(payload.get("path") or ""), now_ms(), mid))
        return {"ok": True, "id": mid}
    nid = d.execute(
        "INSERT INTO material(slug,kind,title,body,tags_json,path,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (s, str(payload.get("kind") or "note"), title, str(payload.get("body") or ""),
         dbm.Database.jdumps(tags), str(payload.get("path") or ""), now_ms(), now_ms()))
    return {"ok": True, "id": nid}


@router.delete("/material")
async def material_delete(request: Request, id: int = 0, ids: str = "", slug: str = ""):
    """删一条（id=）或一批（ids=1,2,3）。

    批量在列表页「多选」里用：以前只能一条条点进详情页删，收十条素材要来回二十次。
    两个参数都不给算参数错（400），别让人以为删成功了。
    """
    current_user(request)
    s = _slug(slug)
    todo = [int(x) for x in str(ids).split(",") if str(x).strip().isdigit()]
    if id:
        todo.append(int(id))
    todo = list(dict.fromkeys(todo))
    if not todo:
        raise HTTPException(400, "要删哪条？给 id 或 ids")
    d = dbm.db()
    gone, missing = [], []
    for mid in todo:
        if d.one("SELECT id FROM material WHERE id=? AND slug=?", (mid, s)):
            gone.append(mid)
        else:
            missing.append(mid)
    for mid in gone:
        d.execute("DELETE FROM material WHERE id=?", (mid,))
    if not gone:
        raise HTTPException(404, "这些素材在「%s」里找不到" % s)
    return {"ok": True, "deleted": gone, "count": len(gone), "missing": missing}


# ── 审计日志 ────────────────────────────────────────────────────────────────
@router.get("/audit")
async def audit(request: Request, slug: str = "", limit: int = 100, action: str = ""):
    current_user(request)
    d = dbm.db()
    q, p = "SELECT * FROM audit WHERE 1=1", []
    if slug:
        q += " AND slug=?"
        p.append(slug)
    if action:
        q += " AND action LIKE ?"
        p.append(action + "%")
    q += " ORDER BY at DESC LIMIT ?"
    p.append(max(1, min(500, limit)))
    rows = d.query(q, p)
    for r in rows:
        r["detail"] = d.jloads(r["detail_json"], {})
    return {"items": rows}


# ── 全文替换（带预览，防误伤）──────────────────────────────────────────────
@router.post("/replace")
async def replace(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    find = str(payload.get("find") or "")
    to = str(payload.get("replace") or "")
    if not find:
        raise HTTPException(400, "要替换什么？")
    scope = str(payload.get("scope") or "manuscript")
    limit_path = str(payload.get("path") or "")
    if limit_path:
        files = [c for c in chapter_files(s) if c["path"] == limit_path]
        if not files:
            raise HTTPException(404, "没有这一章")
    else:
        files = [c for c in chapter_files(s) if c["path"].startswith(scope)] or chapter_files(s)
    hits = []
    for c in files:
        try:
            text = read_text(s, c["path"])
        except Exception:
            continue
        n = text.count(find)
        if n:
            hits.append({"path": c["path"], "name": c["name"], "count": n,
                         "preview": _snippet(text, find)})
    if not payload.get("apply"):
        return {"applied": False, "find": find, "replace": to,
                "files": hits, "total": sum(h["count"] for h in hits)}
    from ..store import write_text
    changed = 0
    for h in hits:
        text = read_text(s, h["path"])
        write_text(s, h["path"], text.replace(find, to), origin="user", note="全文替换")
        changed += h["count"]
    from .books import sync_book
    sync_book(s)
    _audit("replace", s, find=find, replace=to, count=changed)
    return {"applied": True, "files": len(hits), "replaced": changed}


def _snippet(text: str, find: str, span: int = 24) -> str:
    i = text.find(find)
    if i < 0:
        return ""
    a = max(0, i - span)
    return ("…" if a else "") + text[a:i] + "【" + find + "】" + text[i + len(find):i + len(find) + span]
