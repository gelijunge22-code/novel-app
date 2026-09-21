# -*- coding: utf-8 -*-
"""提示词库（阶段 17）：AI 人设提示词可编辑 / 可版本 / 可回滚 / 可对比，外加常用片段。

规矩：
* 全局一份默认；每本书可以有自己的覆盖（按书隔离）。
* 每次保存都进 `prompt_version` 留档；**回滚也是新增一个版本**，历史永远不丢。
* 生效顺序：书级覆盖 > 全局自定义 > 内置人设（`llm/prompts.PROFILES`）。
  最终拿去拼系统提示词的地方是 `llm/prompts.build_system()` —— 只此一处，不另开分支。
"""
from __future__ import annotations

import difflib

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from ..llm.prompts import PROFILES
from ..security import current_user
from ..store import now_ms

router = APIRouter(tags=["prompts"])


def _scope(payload: dict) -> tuple[str, str]:
    scope = "book" if str(payload.get("scope") or "") in ("book", "project") else "global"
    slug = str(payload.get("slug") or "").strip() if scope == "book" else ""
    if scope == "book":
        if not slug:
            raise HTTPException(400, "缺少 slug")
        from .books import require_book
        slug = require_book(slug)
    return scope, slug


def _row(scope: str, slug: str, key: str) -> dict | None:
    return dbm.db().one("SELECT * FROM prompt WHERE scope=? AND slug=? AND key=?",
                        (scope, slug, key))


def _next_version(scope: str, slug: str, key: str) -> int:
    """下一个版本号 = 历史里最大的 +1。

    不能拿「当前那一行的 version」来加 —— 删掉自定义再重存时那一行没了，
    会从 1 重新开始，跟旧历史撞号（出现过两个 v1）。历史只增不减、号只往上走。
    """
    return int(dbm.db().scalar("SELECT COALESCE(MAX(version),0) FROM prompt_version"
                               " WHERE scope=? AND slug=? AND key=?", (scope, slug, key)) or 0) + 1


def _check_key(key: str) -> str:
    key = str(key or "").strip()
    if not key:
        raise HTTPException(400, "缺少提示词 key")
    if key not in PROFILES and not key.startswith("custom."):
        raise HTTPException(400, "不认识的提示词：%s" % key)
    return key


def effective(key: str, slug: str = "") -> tuple[str, str, int]:
    """这本书实际生效的人设正文 → (正文, 来源 book|global|builtin, 版本号)。"""
    for scope, s in (("book", slug or ""), ("global", "")):
        r = _row(scope, s, key)
        if r and (r["body"] or "").strip():
            return r["body"], scope, int(r["version"] or 1)
    return (PROFILES.get(key, {}).get("system") or ""), "builtin", 0


def _item(key: str, slug: str) -> dict:
    prof = PROFILES.get(key) or {}
    body, source, version = effective(key, slug)
    r = _row("book", slug, key) if slug else None
    g = _row("global", "", key)
    own = r or g
    return {
        "key": key,
        "name": prof.get("name") or (own["name"] if own else key),
        "description": prof.get("description") or "",
        "purpose": prof.get("purpose") or key,
        "body": body,
        "builtin": prof.get("system") or "",
        "source": source,                     # book / global / builtin
        "version": version,
        "updatedAt": (own["updated_at"] if own else None),
        "hasBook": bool(r), "hasGlobal": bool(g),
        "editable": True,
    }


@router.get("/prompts")
async def prompts_list(request: Request, slug: str = ""):
    """有 slug 就按那本书算（书级覆盖优先），没有就只看全局。"""
    current_user(request)
    s = ""
    if slug:
        from .books import require_book
        s = require_book(slug)
    keys = list(PROFILES.keys())
    # 自定义 key 也列出来（用户自己加的，不丢）
    for r in dbm.db().query("SELECT DISTINCT key FROM prompt WHERE key LIKE 'custom.%'"):
        if r["key"] not in keys:
            keys.append(r["key"])
    return {"slug": s, "items": [_item(k, s) for k in keys]}


@router.post("/prompts/save")
async def prompts_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    key = _check_key(payload.get("key"))
    scope, slug = _scope(payload)
    body = str(payload.get("body") or "")
    if not body.strip():
        raise HTTPException(400, "正文不能是空的（想恢复内置的就点「恢复内置」）")
    note = str(payload.get("note") or "").strip()[:200]
    d = dbm.db()
    ver = _next_version(scope, slug, key)
    name = str(payload.get("name") or (PROFILES.get(key, {}).get("name")) or key)[:60]
    d.execute("INSERT INTO prompt(scope,slug,key,name,purpose,body,version,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,slug,key) DO UPDATE SET"
              " name=excluded.name, body=excluded.body, version=excluded.version,"
              " updated_at=excluded.updated_at",
              (scope, slug, key, name, key, body, ver, now_ms()))
    d.execute("INSERT INTO prompt_version(scope,slug,key,version,body,note,created_at)"
              " VALUES(?,?,?,?,?,?,?)", (scope, slug, key, ver, body, note, now_ms()))
    return {"ok": True, "key": key, "scope": scope, "slug": slug, "version": ver}


@router.get("/prompts/versions")
async def prompts_versions(request: Request, key: str, scope: str = "global", slug: str = ""):
    current_user(request)
    key = _check_key(key)
    scope, slug = _scope({"scope": scope, "slug": slug})
    rows = dbm.db().query("SELECT version,note,created_at,length(body) AS chars,body"
                          " FROM prompt_version WHERE scope=? AND slug=? AND key=?"
                          " ORDER BY version DESC LIMIT 50", (scope, slug, key))
    cur = _row(scope, slug, key)
    body, source, ver = effective(key, slug)
    return {"key": key, "scope": scope, "slug": slug, "source": source, "version": ver,
            "current": body, "builtin": PROFILES.get(key, {}).get("system") or "",
            "saved": bool(cur),
            "versions": [{"version": r["version"], "note": r["note"],
                          "createdAt": r["created_at"], "chars": r["chars"]} for r in rows]}


@router.get("/prompts/diff")
async def prompts_diff(request: Request, key: str, version: int, scope: str = "global",
                       slug: str = ""):
    """拿某个历史版本跟「现在生效的」比一比（只读，不改任何东西）。"""
    current_user(request)
    key = _check_key(key)
    scope, slug = _scope({"scope": scope, "slug": slug})
    old = dbm.db().one("SELECT body,note FROM prompt_version WHERE scope=? AND slug=? AND key=?"
                       " AND version=?", (scope, slug, key, int(version)))
    if not old:
        raise HTTPException(404, "没有这个版本")
    cur_body, source, cur_ver = effective(key, slug)
    diff = list(difflib.unified_diff((old["body"] or "").splitlines(),
                                    (cur_body or "").splitlines(),
                                    fromfile="v%d" % int(version),
                                    tofile="现在（%s）" % ("没改过" if source == "builtin" else "v%d" % cur_ver),
                                    lineterm="", n=2))
    return {"key": key, "version": int(version), "note": old["note"],
            "from": old["body"], "to": cur_body, "diff": diff[:400]}


@router.post("/prompts/rollback")
async def prompts_rollback(request: Request, payload: dict = Body(...)):
    """回滚到某个历史版本：把那一版正文重新存一次（新增版本，历史不动）。"""
    current_user(request)
    key = _check_key(payload.get("key"))
    scope, slug = _scope(payload)
    ver = num(payload.get("version"), 0, name="提示词版本号")
    old = dbm.db().one("SELECT body FROM prompt_version WHERE scope=? AND slug=? AND key=? AND version=?",
                       (scope, slug, key, ver))
    if not old:
        raise HTTPException(404, "没有这个版本")
    cur = _row(scope, slug, key)
    new_ver = _next_version(scope, slug, key)
    d = dbm.db()
    name = (cur["name"] if cur else "") or PROFILES.get(key, {}).get("name") or key
    d.execute("INSERT INTO prompt(scope,slug,key,name,purpose,body,version,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,slug,key) DO UPDATE SET"
              " body=excluded.body, version=excluded.version, updated_at=excluded.updated_at",
              (scope, slug, key, name, key, old["body"], new_ver, now_ms()))
    d.execute("INSERT INTO prompt_version(scope,slug,key,version,body,note,created_at)"
              " VALUES(?,?,?,?,?,?,?)",
              (scope, slug, key, new_ver, old["body"], "回滚到 v%d" % ver, now_ms()))
    return {"ok": True, "version": new_ver, "from": ver}


@router.delete("/prompts/override")
async def prompts_delete(request: Request, key: str, scope: str = "global", slug: str = ""):
    """删掉这份自定义，让它重新跟下一层走（书级删了就回到全局/内置）。"""
    current_user(request)
    key = _check_key(key)
    scope, slug = _scope({"scope": scope, "slug": slug})
    d = dbm.db()
    cur = _row(scope, slug, key)
    if not cur:
        return {"ok": True, "removed": False}
    d.execute("DELETE FROM prompt WHERE scope=? AND slug=? AND key=?", (scope, slug, key))
    return {"ok": True, "removed": True, "wasVersion": cur["version"], "body": cur["body"]}


@router.delete("/prompts/versions")
async def prompts_clear_versions(request: Request, key: str, scope: str = "global", slug: str = ""):
    """清空某份提示词的历史（只在用户明确点「清空历史」时调；当前生效的正文不动）。"""
    current_user(request)
    key = _check_key(key)
    scope, slug = _scope({"scope": scope, "slug": slug})
    n = dbm.db().scalar("SELECT COUNT(*) FROM prompt_version WHERE scope=? AND slug=? AND key=?",
                        (scope, slug, key)) or 0
    dbm.db().execute("DELETE FROM prompt_version WHERE scope=? AND slug=? AND key=?",
                     (scope, slug, key))
    return {"ok": True, "removed": int(n)}


# ── 片段（Snippet）─────────────────────────────────────────────────────────
@router.get("/snippets")
async def snippets_list(request: Request):
    current_user(request)
    rows = dbm.db().query("SELECT * FROM snippet ORDER BY updated_at DESC")
    return {"items": [{"key": r["key"], "name": r["name"], "body": r["body"],
                       "tags": r["tags"], "useCount": r["use_count"],
                       "updatedAt": r["updated_at"]} for r in rows]}


@router.post("/snippets/save")
async def snippets_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    key = str(payload.get("key") or "").strip()[:60]
    name = str(payload.get("name") or "").strip()[:60]
    body = str(payload.get("body") or "")
    if not key:
        key = "s" + str(now_ms())
    if not name:
        raise HTTPException(400, "片段得有个名字")
    if not body.strip():
        raise HTTPException(400, "片段内容是空的")
    dbm.db().execute(
        "INSERT INTO snippet(key,name,body,tags,use_count,updated_at) VALUES(?,?,?,?,0,?)"
        " ON CONFLICT(key) DO UPDATE SET name=excluded.name, body=excluded.body,"
        " tags=excluded.tags, updated_at=excluded.updated_at",
        (key, name, body, str(payload.get("tags") or "")[:120], now_ms()))
    return {"ok": True, "key": key}


@router.delete("/snippets")
async def snippets_delete(request: Request, key: str):
    current_user(request)
    dbm.db().execute("DELETE FROM snippet WHERE key=?", (key,))
    return {"ok": True}

