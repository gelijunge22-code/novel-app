# -*- coding: utf-8 -*-
"""人物声音档案的接口（引擎在 `engine/voice.py`）。

一句话：**「他是怎么说话的」要能存下来、能核对、能喂给写手。**
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Request

from .. import args
from ..engine import voice as V
from ..security import current_user

router = APIRouter(tags=["voice"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


@router.get("/voice/fields")
async def fields(request: Request):
    """档案有哪些字段（前端照这个画表单，只有一份定义）。"""
    current_user(request)
    return {"items": V.VOICE_FIELDS}


@router.get("/voice/profiles")
async def profiles(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    return {"items": V.all_profiles(s), "count": len(V.all_profiles(s))}


@router.get("/voice/profile")
async def profile(request: Request, slug: str, name: str):
    """一个人的档案 + 他的台词（带出处）+ 从台词里数出来的候选口头禅。"""
    current_user(request)
    s = _slug(slug)
    p = V.get_profile(s, name)
    lines = [l for l in V.attributed(s) if l["speaker"] == p["name"]]
    fp = V.fingerprint([l["line"] for l in lines])
    return {
        "name": p["name"], "entityId": p.get("entityId"), "exists": p.get("exists", False),
        "voice": p.get("voice") or {}, "fingerprint": fp,
        "issues": V.check_one(p["name"], p, fp, lines),
        "samples": [{"line": l["line"], "path": l["path"], "lineNo": l["lineNo"]}
                    for l in lines[:20]],
        "candidates": V.sample_words(s, p["name"]),
    }


@router.post("/voice/profile")
async def save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug") or "")
    name = str(payload.get("name") or "").strip()
    if not name:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="得先说是谁（name 不能空）")
    out = V.save_profile(s, name, args.obj(payload.get("voice"), {}, name="声音档案") or {},
                         kind=args.s(payload.get("kind"), name="类型"))
    out["saved"] = True
    return out


@router.delete("/voice/profile")
async def clear(request: Request, slug: str = "", name: str = ""):
    """只清「声音档案」，人还在（他的事实、关系一条不动）。"""
    current_user(request)
    s = _slug(slug)
    if not name.strip():
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="得说是谁")
    out = V.save_profile(s, name, {})
    out["cleared"] = True
    return out


@router.get("/voice/report")
async def report(request: Request, slug: str):
    """整本书的声音体检：档案覆盖率、谁和谁一个腔、逐人问题。"""
    current_user(request)
    return V.report(_slug(slug))


@router.get("/voice/brief")
async def brief(request: Request, slug: str, names: str = ""):
    """写作链路用的「你们这么说话」小抄（前端也能看着它对稿子）。"""
    current_user(request)
    s = _slug(slug)
    who = [x.strip() for x in (names or "").replace("，", ",").split(",") if x.strip()]
    if not who:
        who = [p["name"] for p in V.all_profiles(s) if p.get("voice")][:6]
    return {"names": who, "brief": V.voice_brief(s, who)}
