# -*- coding: utf-8 -*-
"""笔记：读书时随手记下的东西（可带摘录的原句）。

跟书签的分工：书签管「读到哪」，笔记管「想到了什么」。
笔记是**按书**存的，换设备也带着走（不像本地书签只在这台手机上）。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from ..security import current_user
from ..store import now_ms

router = APIRouter(tags=["notes"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _doc(r: dict) -> dict:
    return {"id": r["id"], "slug": r["slug"], "path": r["path"] or "",
            "percent": float(r["percent"] or 0), "quote": r["quote"] or "",
            "text": r["text"] or "", "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
            "chars": len(r["text"] or ""), "quoteChars": len(r["quote"] or "")}


@router.get("/notes")
async def notes(request: Request, slug: str, q: str = "", limit: int = 200):
    current_user(request)
    s = _slug(slug)
    if q:
        like = "%" + q.strip() + "%"
        rows = dbm.db().query(
            "SELECT * FROM note WHERE slug=? AND (text LIKE ? OR quote LIKE ? OR path LIKE ?)"
            " ORDER BY id DESC LIMIT ?", (s, like, like, like, int(limit)))
        # 有搜索词时 total 是**命中数**（不然前端会出现「0 条命中但写着共 3 条」）
        total = dbm.db().scalar(
            "SELECT COUNT(*) FROM note WHERE slug=? AND (text LIKE ? OR quote LIKE ? OR"
            " path LIKE ?)", (s, like, like, like)) or 0
    else:
        rows = dbm.db().query("SELECT * FROM note WHERE slug=? ORDER BY id DESC LIMIT ?",
                              (s, int(limit)))
        total = dbm.db().scalar("SELECT COUNT(*) FROM note WHERE slug=?", (s,)) or 0
    return {"items": [_doc(r) for r in rows], "total": total, "q": q,
            "allNotes": dbm.db().scalar("SELECT COUNT(*) FROM note WHERE slug=?", (s,)) or 0}


@router.post("/note")
async def note_save(request: Request, payload: dict = Body(...)):
    """新建（不给 id）或修改（给 id）。空笔记不给存 —— 免得点一下就多一条空白。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    text = str(payload.get("text") or "").strip()
    quote = str(payload.get("quote") or "").strip()
    if not text and not quote:
        raise HTTPException(400, "笔记是空的，写点什么再存")
    n = now_ms()
    d = dbm.db()
    nid = num(payload.get("id"), 0, name="笔记号")
    if nid:
        row = d.one("SELECT * FROM note WHERE id=? AND slug=?", (nid, s))
        if not row:
            raise HTTPException(404, "没有这条笔记")
        d.execute("UPDATE note SET path=?, percent=?, quote=?, text=?, updated_at=? WHERE id=?",
                  (str(payload.get("path") or row["path"]),
                   num(payload.get("percent"), row["percent"] or 0, kind=float, lo=0, hi=100,
                       name="进度"),
                   quote, text, n, nid))
    else:
        nid = d.execute(
            "INSERT INTO note(slug,path,percent,quote,text,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (s, str(payload.get("path") or ""),
             num(payload.get("percent"), 0.0, kind=float, lo=0, hi=100, name="进度"),
             quote, text, n, n))
    from .misc import _audit
    _audit("note.save", s, str(payload.get("path") or ""), id=nid)
    return {"ok": True, "id": nid, "item": _doc(d.one("SELECT * FROM note WHERE id=?", (nid,)))}


@router.delete("/note")
async def note_delete(request: Request, id: int, slug: str):
    current_user(request)
    s = _slug(slug)
    row = dbm.db().one("SELECT * FROM note WHERE id=? AND slug=?", (int(id), s))
    if not row:
        raise HTTPException(404, "没有这条笔记")
    # 笔记是用户自己写的东西：删之前先留一份到回收目录，能在「数据」里找回
    from ..paths import Paths
    from ..config import CFG
    import json as _json
    keep = Paths(CFG).data / "trash"
    keep.mkdir(parents=True, exist_ok=True)
    (keep / ("note-%d-%d.json" % (int(id), now_ms()))).write_text(
        _json.dumps(dict(row), ensure_ascii=False, indent=2), encoding="utf-8")
    dbm.db().execute("DELETE FROM note WHERE id=?", (int(id),))
    return {"ok": True, "deleted": int(id)}
