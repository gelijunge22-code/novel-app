# -*- coding: utf-8 -*-
"""对端同步接口：让**手机上的后端**去跟服务器对账（GOAL C2）。

前端只需要知道四件事：
  * `GET  /api/peer/state`      这本书跟服务器同步到哪儿了
  * `POST /api/peer/sync`       推 / 拉 / 双向（口令只在这一次请求里用，不落盘）
  * `GET  /api/peer/conflicts`  两边都改过的，列出来让用户挑
  * `POST /api/peer/resolve`    挑完了写回去（本地 + 顺手推给服务器）
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from .. import peer
from ..security import current_user
from ..store import now_ms, read_text, write_text

router = APIRouter(tags=["peer"])


@router.get("/peer/state")
async def peer_state(request: Request, slug: str):
    current_user(request)
    from .books import require_book
    return peer.state(require_book(slug))


@router.post("/peer/sync")
async def peer_sync(request: Request, payload: dict = Body(...)):
    current_user(request)
    from .books import require_book
    base = (payload.get("base") or "").strip()
    password = payload.get("password") or ""
    direction = (payload.get("direction") or "both").strip()
    if not base:
        raise HTTPException(400, "先填服务器地址")
    if not base.startswith(("http://", "https://")):
        base = "http://" + base
    if direction not in ("pull", "push", "both"):
        raise HTTPException(400, "direction 只能是 pull / push / both")
    try:
        cookie = peer.login(base, password)
        # 「首次进 App」：手机上还没有这本书时，先照服务器建一本再拉（否则只能干瞪眼）
        wanted = (payload.get("slug") or "").strip()
        if not wanted:
            raise HTTPException(400, "得说清同步哪本书")
        if direction in ("pull", "both"):
            made = peer.ensure_local_book(wanted, base, cookie)
            slug = made["slug"]
        else:
            slug = require_book(wanted)
        out: dict = {"slug": slug, "base": base, "direction": direction}
        if direction in ("pull", "both"):
            # 一趟拉不完就接着拉（每趟有上限，长书第一次用一章一章来会很慢）——
            # 但**有上限**，不能把一次请求挂死；拉不完剩下的会在提示里写清楚。
            out["pull"] = peer.pull(slug, base, cookie)
            rounds = 1
            while (out["pull"] or {}).get("more") and rounds < 5:
                again = peer.pull(slug, base, cookie)
                out["pull"]["pulled"] += again.get("pulled", 0)
                out["pull"]["unchanged"] += again.get("unchanged", 0)
                out["pull"]["conflicts"] += again.get("conflicts", 0)
                out["pull"]["errors"] += again.get("errors", 0)
                out["pull"]["failed"] = (out["pull"].get("failed") or []) + (again.get("failed") or [])
                out["pull"]["more"] = again.get("more", 0)
                out["pull"]["rounds"] = rounds + 1
                rounds += 1
        if direction in ("push", "both"):
            out["push"] = peer.push(slug, base, cookie)
        # 换过东西之后，目录/字数要跟着刷新
        from .books import sync_book
        sync_book(slug)
        out["conflicts"] = len(peer.open_conflicts(slug))
        out["state"] = peer.state(slug)
        return out
    except peer.PeerError as e:
        raise HTTPException(502, str(e))


@router.get("/peer/conflicts")
async def peer_conflicts(request: Request, slug: str):
    current_user(request)
    from .books import require_book
    return {"items": peer.open_conflicts(require_book(slug))}


@router.get("/peer/conflict")
async def peer_conflict(request: Request, id: int):
    current_user(request)
    r = dbm.db().one("SELECT * FROM sync_conflict WHERE id=?", (int(id),))
    if not r:
        raise HTTPException(404, "没有这条冲突")
    return {"id": r["id"], "slug": r["slug"], "path": r["path"], "status": r["status"],
            "baseMtimeMs": r["base_mtime"], "localMtimeMs": r["local_mtime"],
            "serverMtimeMs": r["server_mtime"], "createdAt": r["created_at"],
            "localText": r["local_text"], "serverText": r["server_text"]}


@router.post("/peer/resolve")
async def peer_resolve(request: Request, payload: dict = Body(...)):
    """挑「用我这版 / 用服务器那版 / 用我合并的这版」。

    挑完只动**本地**；要推给服务器时前端再点一次"推给服务器"（或者在这里带 base+password）。
    """
    current_user(request)
    cid = num(payload.get("id"), 0, name="冲突号")
    pick = (payload.get("pick") or "").strip()          # local | server | merged
    if pick not in ("local", "server", "merged"):
        raise HTTPException(400, "pick 只能是 local / server / merged")
    r = dbm.db().one("SELECT * FROM sync_conflict WHERE id=?", (cid,))
    if not r:
        raise HTTPException(404, "没有这条冲突")
    slug, path = r["slug"], r["path"]
    if pick == "local":
        text = payload.get("text")
        if text is None:
            text = read_text(slug, path)                 # 本地那份本来就在，不用改
    elif pick == "server":
        text = r["server_text"]
    else:
        text = payload.get("text")
        if text is None:
            raise HTTPException(400, "挑合并稿就得把合并后的正文给我")
    write_text(slug, path, text or "", origin="peer", note="同步冲突挑完了")
    dbm.db().execute("UPDATE sync_conflict SET status=?, resolved_at=? WHERE id=?",
                     (pick, now_ms(), cid))
    base = (payload.get("base") or "").strip()
    pushed = None
    if base:
        try:
            cookie = peer.login(base if base.startswith("http") else "http://" + base,
                                payload.get("password") or "")
            pushed = peer.push(slug, base if base.startswith("http") else "http://" + base,
                               cookie, [path], base_by_path={path: int(r["server_mtime"] or 0)})
        except peer.PeerError as e:
            pushed = {"error": str(e)}
    return {"ok": True, "id": cid, "pick": pick, "slug": slug, "path": path,
            "chars": len(text or ""), "pushed": pushed}
