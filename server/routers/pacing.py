# -*- coding: utf-8 -*-
"""节奏 / 情绪曲线 与 角色一致性体检 的接口（引擎在 engine/pacing.py、engine/consistency.py）。"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from ..engine import consistency as C
from ..engine import pacing as P
from ..security import current_user

router = APIRouter(tags=["pacing"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


@router.get("/pacing/curve")
async def curve(request: Request, slug: str, limit: int = 0):
    """整本书的节奏曲线：每章一个点（张力/情绪正负/对话占比/句长/动作密度）+ 走势毛病。"""
    current_user(request)
    return P.curve(_slug(slug), limit=max(0, min(2000, int(limit or 0))))


@router.get("/pacing/one")
async def one(request: Request, slug: str, path: str = ""):
    """单章的形状（写作台里"这一章现在什么节奏"）。"""
    current_user(request)
    s = _slug(slug)
    if not path:
        raise HTTPException(400, "要看哪一章（path 不能空）")
    from ..store import read_text
    try:
        text = read_text(s, path)
    except Exception as e:
        raise HTTPException(404, f"读不到这一章：{e}") from e
    m = P.chapter_metrics(text)
    return {"path": path, "metrics": m}


@router.get("/consistency/report")
async def consistency_report(request: Request, slug: str):
    """角色一致性体检：年龄/外貌/称呼/代词/近似名字/消失的角色，每条带出处。"""
    current_user(request)
    return C.report(_slug(slug))


@router.post("/consistency/alias")
async def add_alias(request: Request, payload: dict = Body(...)):
    """把体检里"疑似笔误/另一个叫法"登记成别名（一条建议要能一键落实）。"""
    current_user(request)
    s = _slug(payload.get("slug") or "")
    name = str(payload.get("name") or "").strip()
    alias = str(payload.get("alias") or "").strip()
    if not name or not alias:
        raise HTTPException(400, "得说清是谁的别名（name / alias 都要有）")
    from .. import db as dbm
    from ..engine.world import find_entity
    row = find_entity(s, name)
    if not row:
        raise HTTPException(404, f"世界里没有「{name}」这个人（先去世界面板建一个）")
    d = dbm.db()
    try:
        d.execute("INSERT INTO entity_alias(slug,entity_id,alias) VALUES(?,?,?)",
                  (s, row["id"], alias))
    except Exception:
        return {"ok": True, "already": True, "entityId": row["id"], "alias": alias}
    return {"ok": True, "entityId": row["id"], "alias": alias}
