# -*- coding: utf-8 -*-
"""文件浏览器 + 改动收件箱（工具页的「文件」和「改动」两件）。

两个工作区：
* `projectRoot=<书>`  —— 书目录
* `workspaceKind=user-assets` —— 全局资产目录（data/assets，技能/文风/模板放这儿）

规矩：删除一律移进 `data/trash`，**绝不真删**（用户的东西不能丢）。
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from .. import db as dbm
from ..paths import safe_rel
from ..security import current_user
from ..store import (P, book_dir, entry_type, hanzi, iso, now_ms, read_text, read_text_in, resolve_in,
                     walk_dir, write_text, write_text_in, create_file, create_dir,
                     delete_path, rename_path, copy_in, IMAGE_EXT, TEXT_EXT)

router = APIRouter(tags=["files"])

ASSETS = P.data / "assets"


def ws_root(projectRoot: str, workspaceKind: str) -> Path:
    if (workspaceKind or "").lower() in ("user-assets", "user_assets", "assets") or not projectRoot:
        ASSETS.mkdir(parents=True, exist_ok=True)
        if not any(ASSETS.iterdir()):
            _seed_assets()
        return ASSETS
    from .books import require_book
    return book_dir(require_book(projectRoot))


def _seed_assets() -> None:
    """全局资产第一次用的时候，把内置文风/参考放进去，方便直接改。"""
    src = Path(__file__).resolve().parent.parent / "assets"
    for sub in ("styles", "references"):
        d = ASSETS / sub
        d.mkdir(parents=True, exist_ok=True)
        s = src / sub
        if s.is_dir():
            for f in s.glob("*.md"):
                dst = d / f.name
                if not dst.exists():
                    dst.write_text(f.read_text("utf-8"), encoding="utf-8")


def _arg(body: dict | None, query_value: str, *names: str) -> str:
    """同一个参数可能放在查询串里，也可能放在 body 里 —— 老前端两种都发过，都得认。"""
    if query_value:
        return query_value
    for n in names:
        v = (body or {}).get(n)
        if v:
            return str(v)
    return ""


def _is_book_ws(projectRoot: str, workspaceKind: str) -> bool:
    return bool(projectRoot) and (workspaceKind or "").lower() not in (
        "user-assets", "user_assets", "assets")


# ── 文件树 / 读 / 写 ────────────────────────────────────────────────────────
@router.get("/workspace-files/tree")
async def tree(request: Request, projectRoot: str = "", workspaceKind: str = ""):
    current_user(request)
    root = ws_root(projectRoot, workspaceKind)
    nodes = walk_dir(root)
    for n in nodes:
        n.setdefault("mode", "-rw-r--r--")
        n.setdefault("absolutePath", str(resolve_in(root, n["path"])))
        n["isDirectory"] = False
        n["hasIndex"] = False
        n["contentNode"] = n["path"].endswith(".md")
        n["summary"] = ""
        n.setdefault("title", n["name"])
        n["frontmatter"] = {}
        n["frontmatterError"] = None
        n["state"] = None
        n["refs"] = []
        n["words"] = n.get("words", 0)
        n["editable"] = str(n["path"]).lower().endswith(tuple(TEXT_EXT))
        n["issueSummary"] = {"selfCount": 0, "subtreeCount": 0, "count": 0,
                             "highestLevel": None}
    if _is_book_ws(projectRoot, workspaceKind):
        words = {r["path"]: r["words"] for r in dbm.db().query(
            "SELECT path, words FROM chapter WHERE slug=?", (projectRoot,))}
        for n in nodes:
            if n["path"] in words:
                n["words"] = words[n["path"]]
    return {"projectRoot": projectRoot, "root": str(root), "nodes": nodes,
            "items": nodes, "revision": len(nodes),
            "issues": [], "validatedAt": now_ms()}


@router.get("/workspace-files/read")
async def read(request: Request, projectRoot: str = "", path: str = "", workspaceKind: str = ""):
    current_user(request)
    root = ws_root(projectRoot, workspaceKind)
    rel = safe_rel(path)
    if not rel:
        raise HTTPException(400, "路径不合法")
    p = resolve_in(root, rel)
    if not p.exists() or p.is_dir():
        raise HTTPException(404, "没有这个文件")
    ext = p.suffix.lower()
    editable = ext in TEXT_EXT and p.stat().st_size <= 8 * 1024 * 1024
    if not editable:
        return {"path": rel, "absolutePath": str(p), "entryType": entry_type(rel),
                "content": "", "editable": False, "binary": True,
                "mtimeMs": p.stat().st_mtime * 1000.0, "size": p.stat().st_size}
    try:
        text = read_text_in(root, rel)
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    return {"path": rel, "absolutePath": str(p), "entryType": entry_type(rel),
            "content": text, "editable": True, "binary": False,
            "mtimeMs": p.stat().st_mtime * 1000.0, "size": p.stat().st_size,
            "words": hanzi(text)}


@router.put("/workspace-files/write")
async def write(request: Request, projectRoot: str = "", path: str = "", workspaceKind: str = "",
                payload: dict = Body(default={})):
    current_user(request)
    body = payload or {}
    projectRoot = _arg(body, projectRoot, "projectRoot", "slug")
    workspaceKind = _arg(body, workspaceKind, "workspaceKind")
    rel = safe_rel(path or body.get("path") or "")
    if not rel:
        raise HTTPException(400, "路径不合法")
    content = body.get("content")
    if content is None:
        raise HTTPException(400, "没有内容")
    root = ws_root(projectRoot, workspaceKind)
    p = resolve_in(root, rel)
    base_content = body.get("baseContent")
    if base_content is not None and p.exists() and not body.get("force"):
        try:
            cur = p.read_text("utf-8")
        except Exception:
            cur = None
        if cur is not None and cur != base_content:
            raise HTTPException(409, "这个文件在别处被改过了，先刷新再保存")
    if _is_book_ws(projectRoot, workspaceKind):
        import time as _t
        before = ""
        if p.exists():
            try:
                before = p.read_text("utf-8")
            except Exception:
                before = ""
        out = write_text(projectRoot, rel, str(content),
                         origin=(body.get("actorKind") or "user"), note=body.get("note") or "")
    else:
        out = write_text_in(root, rel, str(content))
    mtime = p.stat().st_mtime * 1000.0
    return {"ok": True, "mtimeMs": mtime, "path": rel, "words": hanzi(str(content))}


@router.post("/workspace-files/create-file")
async def create_f(request: Request, projectRoot: str = "", workspaceKind: str = "",
                   payload: dict = Body(default={})):
    current_user(request)
    body = payload or {}
    projectRoot = _arg(body, projectRoot, "projectRoot", "slug")
    workspaceKind = _arg(body, workspaceKind, "workspaceKind")
    rel = safe_rel(body.get("path") or "")
    if not rel:
        raise HTTPException(400, "路径不合法")
    root = ws_root(projectRoot, workspaceKind)
    p = resolve_in(root, rel)
    if p.exists():
        raise HTTPException(400, "已经有一个同名文件了")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.get("content") or "", encoding="utf-8")
    if _is_book_ws(projectRoot, workspaceKind):
        from .books import sync_book
        sync_book(projectRoot)
    return {"ok": True, "path": rel, "mtimeMs": p.stat().st_mtime * 1000.0}


@router.post("/workspace-files/create-directory")
async def create_d(request: Request, projectRoot: str = "", workspaceKind: str = "",
                   payload: dict = Body(default={})):
    current_user(request)
    payload = payload or {}
    projectRoot = _arg(payload, projectRoot, "projectRoot", "slug")
    workspaceKind = _arg(payload, workspaceKind, "workspaceKind")
    rel = safe_rel(payload.get("path") or "")
    if not rel:
        raise HTTPException(400, "路径不合法")
    root = ws_root(projectRoot, workspaceKind)
    p = resolve_in(root, rel)
    if p.exists():
        raise HTTPException(400, "已经有一个同名目录了")
    p.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": rel}


@router.delete("/workspace-files/delete")
async def delete(request: Request, projectRoot: str = "", path: str = "", workspaceKind: str = "",
                 payload: dict = Body(default={})):
    current_user(request)
    body = payload or {}
    projectRoot = _arg(body, projectRoot, "projectRoot", "slug")
    workspaceKind = _arg(body, workspaceKind, "workspaceKind")
    rel = safe_rel(path or body.get("path") or "")
    if not rel:
        raise HTTPException(400, "路径不合法")
    root = ws_root(projectRoot, workspaceKind)
    p = resolve_in(root, rel)
    if not p.exists():
        raise HTTPException(404, "没有这个文件")
    dst = P.trash / (projectRoot or "assets") / f"{int(now_ms())}-{p.name}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(str(p), str(dst))
    if _is_book_ws(projectRoot, workspaceKind):
        from .books import sync_book
        sync_book(projectRoot)
    return {"ok": True, "path": rel, "trashedTo": str(dst)}


@router.patch("/workspace-files/rename")
async def rename(request: Request, projectRoot: str = "", workspaceKind: str = "",
                 payload: dict = Body(default={})):
    current_user(request)
    body = payload or {}
    projectRoot = _arg(body, projectRoot, "projectRoot", "slug")
    workspaceKind = _arg(body, workspaceKind, "workspaceKind")
    a = safe_rel(body.get("from") or "")
    b = safe_rel(body.get("to") or "")
    if not a or not b:
        raise HTTPException(400, "缺少 from / to")
    root = ws_root(projectRoot, workspaceKind)
    src, dst = resolve_in(root, a), resolve_in(root, b)
    if not src.exists():
        raise HTTPException(404, "原文件不在了")
    if dst.exists():
        raise HTTPException(400, "目标已经存在")
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(str(src), str(dst))
    if _is_book_ws(projectRoot, workspaceKind):
        dbm.db().execute("UPDATE chapter SET path=? WHERE slug=? AND path=?",
                         (b, projectRoot, a))
        from .books import sync_book
        sync_book(projectRoot)
    return {"ok": True, "from": a, "to": b}


@router.post("/workspace-files/upload-file")
async def upload(request: Request, projectRoot: str = "", workspaceKind: str = "",
                 path: str = "", file: UploadFile = File(default=None),
                 payload: dict = Body(default=None)):
    current_user(request)
    if file is None:
        form = await request.form()
        file = form.get("file")
        projectRoot = projectRoot or str(form.get("projectRoot") or "")
        path = path or str(form.get("path") or "")
        if file is None:
            raise HTTPException(400, "没有收到文件")
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件是空的")
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(413, "文件超过 200MB")
    name = Path(getattr(file, "filename", "") or "upload.bin").name
    rel = safe_rel(path or "") or safe_rel(f"upload/{name}")
    if not rel:
        raise HTTPException(400, "路径不合法")
    root = ws_root(projectRoot, workspaceKind)
    dst = resolve_in(root, rel)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)
    if _is_book_ws(projectRoot, workspaceKind):
        from .books import sync_book
        sync_book(projectRoot)
    return {"ok": True, "path": rel, "size": len(data),
            "mtimeMs": dst.stat().st_mtime * 1000.0}


@router.get("/workspace-files/download")
async def download(request: Request, projectRoot: str = "", path: str = "", workspaceKind: str = ""):
    current_user(request)
    root = ws_root(projectRoot, workspaceKind)
    rel = safe_rel(path)
    if not rel:
        raise HTTPException(400, "路径不合法")
    p = resolve_in(root, rel)
    if not p.exists() or p.is_dir():
        raise HTTPException(404, "没有这个文件")
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


# ── 改动收件箱 ──────────────────────────────────────────────────────────────
def inbox_groups(slug: str) -> list[dict]:
    rows = dbm.db().query(
        "SELECT * FROM revision WHERE slug=? AND status='pending' ORDER BY path, created_at DESC",
        (slug,))
    by_path: dict[str, list[dict]] = {}
    for r in rows:
        by_path.setdefault(r["path"], []).append(r)
    out = []
    for path, items in items_by_path(by_path):
        out.append({
            "path": path,
            "revision": max(i["rev"] for i in items),
            "baseHash": None,
            "endHash": hash_text(items[0]["after_text"] or ""),
            "entries": [{"id": i["id"], "actorKind": i["actor_kind"] or "user",
                         "actorDetail": None,
                         "operationType": i["kind"] or "write",
                         "occurredAt": iso(i["created_at"]),
                         "kind": i["kind"],
                         "beforeBytes": len(i["before_text"] or ""),
                         "afterBytes": len(i["after_text"] or "")} for i in items],
        })
    return out


def items_by_path(by_path: dict):
    return sorted(by_path.items(), key=lambda kv: kv[0])


def hash_text(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def inbox_revision(slug: str) -> int:
    """收件箱的一份「版本号」：改动过就变，前端据此判断要不要重画。"""
    return int(dbm.db().scalar(
        "SELECT MAX(id) FROM revision WHERE slug=?", (slug,)) or 0)


@router.get("/workspace-history/inbox")
async def history_inbox(request: Request, projectRoot: str = ""):
    current_user(request)
    from .books import require_book
    s = require_book(projectRoot)
    groups = inbox_groups(s)
    return {"revision": inbox_revision(s), "groups": groups, "items": groups,
            "count": len(groups), "changedFiles": [g["path"] for g in groups]}


@router.get("/workspace-history/diff")
async def history_diff(request: Request, projectRoot: str = "", path: str = ""):
    current_user(request)
    from .books import require_book
    s = require_book(projectRoot)
    rows = dbm.db().query(
        "SELECT * FROM revision WHERE slug=? AND path=? ORDER BY rev DESC LIMIT 2", (s, path))
    if not rows:
        raise HTTPException(404, "这个文件没有改动记录")
    import difflib
    cur = rows[0]
    old = rows[1]["after_text"] if len(rows) > 1 else cur["before_text"]
    diff = "\n".join(difflib.unified_diff(
        (old or "").splitlines(), (cur["after_text"] or "").splitlines(),
        fromfile="改之前", tofile="改之后", lineterm="", n=2))
    return {"path": path, "diff": diff or "(内容没变化)", "revision": cur["rev"],
            "status": cur["status"]}


@router.post("/workspace-history/accept")
async def history_accept(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = payload.get("projectRoot") or payload.get("slug")
    path = payload.get("path")
    dbm.db().execute(
        "UPDATE revision SET status='accepted' WHERE slug=? AND path=? AND status='pending'",
        (s, path))
    return {"ok": True}


@router.post("/workspace-history/accept-all")
async def history_accept_all(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = payload.get("projectRoot") or payload.get("slug")
    # rowcount 不是 execute()：UPDATE 之后 lastrowid 是上一次 INSERT 的 rowid，不是行数。
    n = dbm.db().rowcount(
        "UPDATE revision SET status='accepted' WHERE slug=? AND status='pending'", (s,))
    return {"ok": True, "accepted": n}


@router.post("/workspace-history/revert")
async def history_revert(request: Request, payload: dict = Body(...)):
    """把文件退回改动之前。**只动这一份文件**，不碰别的东西。"""
    current_user(request)
    from .books import require_book, sync_book
    s = require_book(payload.get("projectRoot") or payload.get("slug"))
    path = payload.get("path") or ""
    row = dbm.db().one(
        "SELECT * FROM revision WHERE slug=? AND path=? AND status='pending'"
        " ORDER BY rev DESC LIMIT 1", (s, path))
    if not row:
        raise HTTPException(404, "这个文件没有可退回的改动")
    write_text(s, path, row["before_text"] or "", snapshot=False, origin="revert")
    dbm.db().execute(
        "UPDATE revision SET status='reverted' WHERE slug=? AND path=? AND status='pending'",
        (s, path))
    sync_book(s)
    return {"ok": True, "path": path, "restoredFrom": row["rev"]}


# ── api/inbox（老前端的入口，等价于 workspace-history/inbox）────────────────
@router.get("/inbox")
async def inbox(request: Request, slug: str = ""):
    current_user(request)
    from .books import require_book
    s = require_book(slug)
    groups = inbox_groups(s)
    return {"revision": inbox_revision(s), "groups": groups, "items": groups,
            "count": len(groups)}


@router.post("/inbox/accept")
async def inbox_accept(request: Request, payload: dict = Body(...)):
    current_user(request)
    dbm.db().execute(
        "UPDATE revision SET status='accepted' WHERE slug=? AND path=? AND status='pending'",
        (payload.get("slug"), payload.get("path")))
    return {"ok": True}


@router.post("/inbox/revert")
async def inbox_revert(request: Request, payload: dict = Body(...)):
    return await history_revert(request, {
        "projectRoot": payload.get("slug"), "path": payload.get("path")})
