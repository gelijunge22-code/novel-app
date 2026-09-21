# -*- coding: utf-8 -*-
"""设定（世界书）。

前端 `api/lore/tree` 只列条目、`api/lore/search` 全文搜。
我们额外提供条目的增删改查（新前端要用），路径都限制在书目录内。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from .. import args
from .. import db as dbm
from ..security import current_user
from ..store import P, book_dir, read_text, walk, write_text, create_file, delete_path, now_ms

router = APIRouter(tags=["lore"])

CATEGORIES = ["character", "world", "faction", "event", "item", "system", "note"]


def _book(slug: str) -> str:
    from .books import require_book
    return require_book(slug)


def _lore_files(slug: str) -> list[dict]:
    out = []
    for n in walk(slug):
        p = n["path"]
        if p.endswith(".md") and (p.startswith("lorebook/") or p.startswith("world/")
                                  or n["entryType"] == "lore"):
            out.append({"path": p, "name": p.split("/")[-1][:-3]})
    out.sort(key=lambda x: x["path"])
    return out


@router.get("/lore/tree")
async def lore_tree(slug: str, request: Request):
    current_user(request)
    s = _book(slug)
    return {"files": _lore_files(s),
            "categories": _categories(s)}


def _categories(slug: str) -> list[dict]:
    base = book_dir(slug) / "lorebook"
    out = []
    if base.is_dir():
        for d in sorted(base.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                out.append({"key": d.name, "name": _cat_name(d.name),
                            "count": len(list(d.glob("*.md")))})
    known = {c["key"] for c in out}
    for c in CATEGORIES:
        if c not in known:
            out.append({"key": c, "name": _cat_name(c), "count": 0})
    return out


_CN = {"character": "角色", "world": "世界", "faction": "势力", "event": "事件",
       "item": "物品", "system": "体系", "note": "随记", "location": "地点", "term": "术语"}


def _cat_name(k: str) -> str:
    return _CN.get(k, k)


@router.get("/lore/search")
async def lore_search(slug: str, q: str, request: Request, limit: int = 30):
    current_user(request)
    s = _book(slug)
    kw = (q or "").strip()
    if not kw:
        return {"hits": []}
    hits: list[dict] = []
    for f in _lore_files(s):
        try:
            text = read_text(s, f["path"])
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if kw in line:
                hits.append({"path": f["path"], "line": i, "text": line.strip()[:160]})
                if len(hits) >= limit:
                    return {"hits": hits}
    return {"hits": hits}


@router.get("/lore/entry")
async def lore_entry(slug: str, path: str, request: Request):
    current_user(request)
    s = _book(slug)
    try:
        return {"path": path, "content": read_text(s, path)}
    except FileNotFoundError:
        raise HTTPException(404, "没有这条设定")
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))


@router.post("/lore/entry")
async def lore_entry_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _book(payload.get("slug") or "")
    path = args.s(payload.get("path"), name="设定路径").strip()
    content = args.s(payload.get("content"), name="正文")
    new = bool(payload.get("create"))
    if not path:
        raise HTTPException(400, "缺少设定路径")
    try:
        if new:
            create_file(s, path, content)
        else:
            write_text(s, path, content, origin="user", note="编辑设定")
    except FileExistsError:
        raise HTTPException(400, "同名条目已经存在")
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "path": path, "mtimeMs": now_ms()}


@router.delete("/lore/entry")
async def lore_entry_delete(slug: str, path: str, request: Request):
    current_user(request)
    s = _book(slug)
    try:
        out = delete_path(s, path)
    except FileNotFoundError:
        raise HTTPException(404, "没有这条设定")
    return out
