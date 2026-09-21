# -*- coding: utf-8 -*-
"""增量同步与冲突处理（手机离线改了、服务器也改了怎么办）。

规矩（也写在 docs/设计方案.md 里）：
* **两边都改过 → 绝不替用户选**。两份都存进 `sync_conflict`，原文件一个字节都不动，
  等用户在 App 里挑「用我这版 / 用服务器那版」。
* 本地没改过的文件（mtime 没变）直接放行，不打扰。
* 「保留我这版」不是覆盖完了就算：写之前先留快照（`store.write_text` 自带），
  所以服务器那版仍然能从「改动 → 历史」里找回来。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from ..security import current_user
from ..store import mtime_ms, now_ms, read_text, write_text

router = APIRouter(tags=["sync"])

MAX_TEXT = 400_000          # 单章塞进请求/响应的上限（防止一本百万字一次拉爆内存）


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def record_conflict(slug: str, path: str, *, base: int, local_text: str,
                    server_text: str, server_mtime: int) -> int:
    """把一次冲突原样记下来（两份正文都留），返回冲突 id。"""
    return dbm.db().execute(
        "INSERT INTO sync_conflict(slug,path,base_mtime,local_mtime,server_mtime,"
        "local_text,server_text,status,created_at) VALUES(?,?,?,?,?,?,?,'open',?)",
        (slug, path, int(base or 0), now_ms(), int(server_mtime or 0),
         (local_text or "")[:MAX_TEXT], (server_text or "")[:MAX_TEXT], now_ms()))


def _conflict_doc(r: dict, *, with_text: bool = True) -> dict:
    out = {"id": r["id"], "slug": r["slug"], "path": r["path"], "status": r["status"],
           "baseMtimeMs": r["base_mtime"], "serverMtimeMs": r["server_mtime"],
           "localMtimeMs": r["local_mtime"], "createdAt": r["created_at"],
           "resolvedAt": r["resolved_at"],
           "localChars": len(r["local_text"] or ""), "serverChars": len(r["server_text"] or "")}
    if with_text:
        out["localText"] = r["local_text"]
        out["serverText"] = r["server_text"]
    return out


# ── 读：变了哪些章 / 取一章正文 ─────────────────────────────────────────────
@router.get("/sync/changes")
async def sync_changes(request: Request, slug: str, since: int = 0):
    """`since` 是毫秒时间戳（上次同步时服务器给的 `now`）。只回变化的章节，不带全文。"""
    current_user(request)
    s = _slug(slug)
    from .books import sync_book
    sync_book(s)
    rows = dbm.db().query(
        "SELECT path,title,words,mtime_ms,updated_at FROM chapter WHERE slug=?", (s,))
    changed = [r for r in rows if int(r["mtime_ms"] or 0) > int(since or 0)]
    total = sum(r["words"] for r in rows)
    return {"slug": s, "serverTime": now_ms(), "since": since,
            "changed": changed, "count": len(changed), "totalWords": total,
            "all": [r["path"] for r in rows]}


@router.get("/sync/chapter")
async def sync_chapter(request: Request, slug: str, path: str, since: int = 0):
    """取一章正文；本地时间戳比服务器新时告诉 App「不用换」。"""
    current_user(request)
    s = _slug(slug)
    from .books import require_path
    p = require_path(s, path)
    mt = mtime_ms(s, p)
    if since and int(mt) <= int(since):
        return {"path": p, "unchanged": True, "mtimeMs": mt}
    return {"path": p, "unchanged": False, "mtimeMs": mt, "content": read_text(s, p)}


# ── 写：把手机上攒的改动推回来（带冲突判断）────────────────────────────────
@router.post("/sync/push")
async def sync_push(request: Request, payload: dict = Body(...)):
    """把离线期间攒下的改动推回服务器。

    `items` 形如 `[{path, content, baseMtimeMs, force?}]`。
    每条结果里 `status` 是 `ok | conflict | unchanged`；`conflict` 的会附上服务器那版正文，
    手机端拿它直接给用户看两版的差别，不用再跑一趟。
    """
    current_user(request)
    s = _slug(payload.get("slug"))
    items = payload.get("items") or []
    if not isinstance(items, list):
        raise HTTPException(400, "items 得是一串改动")
    if len(items) > 50:
        raise HTTPException(400, "一次最多推 50 条")
    from .books import require_path, sync_book
    out = []
    conflicts = 0
    for it in items:
        try:
            p = require_path(s, str((it or {}).get("path") or ""))
        except HTTPException as e:
            out.append({"path": (it or {}).get("path"), "status": "bad", "error": e.detail})
            continue
        content = it.get("content")
        if content is None:
            out.append({"path": p, "status": "bad", "error": "没有正文内容"})
            continue
        content = str(content)[:MAX_TEXT]
        base = num(it.get("baseMtimeMs"), 0, name="基准版本号")
        try:
            server_text = read_text(s, p)
            cur = int(mtime_ms(s, p))
        except FileNotFoundError:
            server_text, cur = None, 0
        if server_text is not None and server_text == content:
            out.append({"path": p, "status": "unchanged", "mtimeMs": cur})
            continue
        if not it.get("force") and base and cur and abs(cur - base) > 2 and server_text is not None:
            cid = record_conflict(s, p, base=base, local_text=content,
                                  server_text=server_text, server_mtime=cur)
            conflicts += 1
            out.append({"path": p, "status": "conflict", "conflictId": cid,
                        "serverMtimeMs": cur, "baseMtimeMs": base,
                        "serverText": server_text[:MAX_TEXT]})
            continue
        res = write_text(s, p, content, origin="user", note="手机同步")
        out.append({"path": p, "status": "ok", "mtimeMs": res["mtimeMs"], "words": res["words"]})
    if conflicts:
        try:
            from .core import notify
            notify("sync", "有 %d 章两边都改过" % conflicts,
                   "去「同步」里挑一版：两边的内容都留着，没动你的稿子。", s)
        except Exception:
            # 推送提醒失败（没装通知渠道）不该拦住同步本身。
            pass
    sync_book(s)
    return {"slug": s, "results": out, "conflicts": conflicts,
            "ok": sum(1 for r in out if r["status"] == "ok"), "total": len(out)}


# ── 冲突清单与处理 ──────────────────────────────────────────────────────────
@router.get("/sync/conflicts")
async def sync_conflicts(request: Request, slug: str = "", status: str = "open", limit: int = 20):
    current_user(request)
    d = dbm.db()
    if slug:
        s = _slug(slug)
        rows = d.query("SELECT * FROM sync_conflict WHERE slug=? AND status=? ORDER BY id DESC"
                       " LIMIT ?", (s, status, int(limit)))
    else:
        rows = d.query("SELECT * FROM sync_conflict WHERE status=? ORDER BY id DESC LIMIT ?",
                       (status, int(limit)))
    return {"items": [_conflict_doc(r, with_text=False) for r in rows], "total": len(rows)}


@router.get("/sync/conflict")
async def sync_conflict_one(request: Request, id: int):
    """看一条冲突的全文（两边都给你）。"""
    current_user(request)
    r = dbm.db().one("SELECT * FROM sync_conflict WHERE id=?", (int(id),))
    if not r:
        raise HTTPException(404, "没有这条冲突")
    return _conflict_doc(r)


@router.post("/sync/resolve")
async def sync_resolve(request: Request, payload: dict = Body(...)):
    """用哪一版。`choice`: local（我这版）/ server（服务器那版）/ merged（我给合并稿）。

    merged 时要给 `text`。无论选哪个，旧内容都会留快照，能回退。
    """
    current_user(request)
    d = dbm.db()
    r = d.one("SELECT * FROM sync_conflict WHERE id=?",
              (num(payload.get("id"), 0, name="冲突号"),))
    if not r:
        raise HTTPException(404, "没有这条冲突")
    if r["status"] != "open":
        return {"ok": True, "already": r["status"]}
    s = _slug(r["slug"])
    choice = str(payload.get("choice") or "")
    if choice == "local":
        text = r["local_text"]
    elif choice == "server":
        text = r["server_text"]
    elif choice in ("merged", "merge"):
        text = str(payload.get("text") or "")
        if not text.strip():
            raise HTTPException(400, "合并稿是空的")
    else:
        raise HTTPException(400, "choice 只能是 local / server / merged")
    res = write_text(s, r["path"], text, origin="user",
                     note="同步冲突：%s" % {"local": "用了手机这版", "server": "用了服务器这版",
                                            "merged": "用了我合并的"}.get(choice, choice))
    from .books import sync_book
    sync_book(s)
    with d.tx() as conn:
        conn.execute("UPDATE sync_conflict SET status=?, resolved_at=? WHERE id=?",
                     (choice, now_ms(), r["id"]))
    return {"ok": True, "id": r["id"], "choice": choice, "mtimeMs": res["mtimeMs"],
            "words": res["words"]}


@router.get("/sync/state")
async def sync_state(request: Request, slug: str = ""):
    """同步面板开屏：有多少条待处理的冲突。"""
    current_user(request)
    d = dbm.db()
    if slug:
        s = _slug(slug)
        n = d.scalar("SELECT COUNT(*) FROM sync_conflict WHERE slug=? AND status='open'", (s,)) or 0
    else:
        n = d.scalar("SELECT COUNT(*) FROM sync_conflict WHERE status='open'") or 0
    return {"openConflicts": n}
