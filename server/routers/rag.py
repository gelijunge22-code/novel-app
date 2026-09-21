# -*- coding: utf-8 -*-
"""记忆（工具页「记忆」）：AI 记得这本书发生过什么。"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from ..args import clamp
from ..engine import memory as mem
from ..security import current_user

router = APIRouter(tags=["rag"])


@router.get("/projects/rag/inspector")
async def rag_inspector(request: Request, projectRoot: str = "", limit: int = 200):
    current_user(request)
    from .books import require_book
    return mem.inspector(require_book(projectRoot), limit)


@router.get("/projects/rag/subject")
async def rag_subject(request: Request, projectRoot: str = "", subjectPath: str = "",
                      subject: str = ""):
    current_user(request)
    from .books import require_book
    s = require_book(projectRoot)
    who = subjectPath or subject
    if not who:
        raise HTTPException(400, "缺少 subjectPath")
    return mem.subject_detail(s, who)


@router.get("/projects/rag/search")
async def rag_search_get(request: Request, projectRoot: str = "", subjectPath: str = "",
                         subject: str = "", q: str = "", limit: int = 8):
    return await rag_search(request, projectRoot,
                            {"subjectPath": subjectPath or subject, "query": q,
                             "limit": limit})


@router.get("/projects/rag/memories")
async def rag_memories_get(request: Request, projectRoot: str = ""):
    """列这本书记忆库里有哪些主体（老平台这个路径是 GET）。"""
    current_user(request)
    from .books import require_book
    return mem.inspector(require_book(projectRoot), 500)


@router.post("/projects/rag/search")
async def rag_search(request: Request, projectRoot: str = "", payload: dict = Body(default={})):
    current_user(request)
    from .books import require_book
    body = payload or {}
    return mem.search(require_book(projectRoot), body.get("subjectPath") or "",
                      body.get("query") or "", clamp(body.get("limit"), 8, lo=1, hi=50))


@router.delete("/projects/rag/memories")
async def rag_forget(request: Request, projectRoot: str = "", payload: dict = Body(default={})):
    current_user(request)
    from .books import require_book
    s = require_book(projectRoot)
    body = payload or {}
    # 字段名收口：老平台叫 subjectPath，引擎里叫 subject，两个都收 ——
    # 只认前一个的话，调用方发 subject 会静默变成"删空 subject 的那条"，什么都不删还回 200。
    subj = body.get("subjectPath") or body.get("subject") or ""
    if not subj and not body.get("topic"):
        raise HTTPException(400, "缺少数删除目标")
    return mem.forget(s, subj, body.get("topic") or "")


@router.post("/projects/rag/rebuild")
async def rag_rebuild(request: Request, projectRoot: str = "", payload: dict = Body(default={})):
    current_user(request)
    from .books import require_book
    s = require_book(projectRoot)
    from .agent import finish_job, new_job
    jid = new_job("rag_rebuild", "重建记忆", s)
    try:
        out = await mem.rebuild(s, model_key=(payload or {}).get("modelKey") or "")
        finish_job(jid, "done", result=out)
        return out
    except Exception as e:
        finish_job(jid, "failed", error=str(e))
        raise HTTPException(500, f"重建失败：{e}")


@router.get("/projects/rag/debug")
async def rag_debug_get(request: Request, projectRoot: str = ""):
    current_user(request)
    from .books import require_book
    s = require_book(projectRoot)
    ins = mem.inspector(s, 50)
    return {"projectRoot": s, "ok": True, "subjects": len(ins.get("subjects") or []),
            "index": ins.get("index") or {}, "embedding": ins.get("embedding") or {},
            "checks": [{"name": "记忆主体", "ok": bool(ins.get("subjects")),
                        "detail": f"{len(ins.get('subjects') or [])} 个"}]}


@router.post("/projects/rag/debug")
async def rag_debug(request: Request, projectRoot: str = "", payload: dict = Body(default={})):
    """体检：把记忆库的真实状态摆出来（不猜、不美化）。"""
    current_user(request)
    from .. import db as dbm
    from .books import require_book
    s = require_book(projectRoot)
    d = dbm.db()
    return {
        "projectRoot": s,
        "memoryCount": d.scalar("SELECT COUNT(*) FROM memory WHERE slug=?", (s,)) or 0,
        "eventCount": d.scalar("SELECT COUNT(*) FROM memory_event WHERE slug=?", (s,)) or 0,
        "subjectCount": d.scalar("SELECT COUNT(DISTINCT subject) FROM memory WHERE slug=?", (s,)) or 0,
        "indexRows": d.scalar("SELECT COUNT(*) FROM rag_index WHERE slug=?", (s,)) or 0,
        "lastRebuild": d.scalar("SELECT MAX(created_at) FROM memory WHERE slug=?", (s,)),
        "topSubjects": d.query(
            "SELECT subject, COUNT(*) n FROM memory WHERE slug=? GROUP BY subject"
            " ORDER BY n DESC LIMIT 10", (s,)),
    }
