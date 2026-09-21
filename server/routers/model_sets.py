# -*- coding: utf-8 -*-
"""模型组：按**用途**指定模型，一套配置复用到多处。

用户的原话是「规划用大模型、润色用快模型」。这张表在 `0001_init.sql` 里就建好了
（`model_set` / `model_set_member`），但一直没有任何接口去用它 —— 属于"空壳"。
这里把它接上，而且是**真生效**的：`write.py` 的 `_resolve_model()` 会问它。

规矩（写进 docs/进度.md，免得自己以后忘）：
* 只有**启用**（`setting.models.activeSet`）的那个组才参与解析；没启用时一切照旧。
* 优先级：本次请求里点名 > 启用中的模型组（按用途）> 预设里为这本书选的 > 全局默认。
* 解析结果在 `/api/model-sets/resolve` 和 `/api/write/status` 里都能看到，
  不搞"它到底用了哪个模型"的黑箱。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..security import current_user
from ..store import now_ms

router = APIRouter(tags=["models"])

# 用途清单（前后端共用，改这里就够了）
PURPOSES = [
    ("planner", "规划", "写细纲、理大纲、想剧情走向 —— 需要脑子好使的模型"),
    ("writer", "写正文", "真正落笔写正文的那一个"),
    ("polish", "润色改写", "润色、改写、行内 AI —— 要快、要听话"),
    ("fast", "杂活", "摘要、起名、抽取信息这类小活"),
]
PURPOSE_KEYS = tuple(p[0] for p in PURPOSES)

ACTIVE_KEY = "models.activeSet"


def _active_set() -> str:
    row = dbm.db().one("SELECT value_json FROM setting WHERE key=?", (ACTIVE_KEY,))
    v = dbm.db().jloads(row["value_json"], "") if row else ""
    return v if isinstance(v, str) else ""


def _set_of(name: str) -> dict | None:
    d = dbm.db()
    row = d.one("SELECT * FROM model_set WHERE name=?", (name,))
    if not row:
        return None
    members = {}
    keys = {}
    for m in d.query("SELECT * FROM model_set_member WHERE set_id=? ORDER BY sort, id",
                     (row["id"],)):
        members[m["purpose"]] = {"id": m["provider_id"], "model": m["model_id"]}
        keys[m["purpose"]] = f"{_group_of(m['provider_id'])}/{m['model_id']}"
    return {"id": row["id"], "name": row["name"], "note": row["note"],
            "updatedAt": row["updated_at"], "members": members, "keys": keys}


def _group_of(provider_id: int) -> str:
    row = dbm.db().one("SELECT grp, name FROM provider WHERE id=?", (provider_id,))
    if not row:
        return ""
    return row["grp"] or row["name"]


def _provider_by_key(model_key: str) -> dict | None:
    """`组名/模型id` → provider 行（模型分组用的组名可能含 `/`，所以从右往左切）。"""
    if not model_key or "/" not in model_key:
        return None
    grp, model_id = model_key.rsplit("/", 1)
    for p in dbm.db().query("SELECT * FROM provider WHERE enabled=1 ORDER BY sort, id"):
        if (p["grp"] or p["name"]) != grp:
            continue
        m = dbm.db().one("SELECT * FROM provider_model WHERE provider_id=? AND model_id=?",
                         (p["id"], model_id))
        if m:
            return p
    return None


def purpose_model(slug: str, purpose: str) -> str:
    """启用中的模型组为这个用途指定的模型（没启用/没配就返回空串）。"""
    name = _active_set()
    if not name:
        return ""
    st = _set_of(name)
    if not st:
        return ""
    return st["keys"].get(purpose) or ""


@router.get("/model-sets")
async def model_sets(request: Request):
    current_user(request)
    d = dbm.db()
    names = [r["name"] for r in d.query("SELECT name FROM model_set ORDER BY name")]
    sets = [s for s in (_set_of(n) for n in names) if s]
    active = _active_set()
    return {"sets": sets, "active": active,
            "purposes": [{"key": k, "name": n, "hint": h} for k, n, h in PURPOSES],
            "total": len(sets)}


@router.post("/model-sets/save")
async def model_sets_save(request: Request, payload: dict = Body(...)):
    """新建或覆盖一个模型组。`members` 形如 `{"writer": "组名/模型id"}`。"""
    current_user(request)
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 40:
        raise HTTPException(400, "模型组得有个 40 字以内的名字")
    members = payload.get("members") or {}
    if not isinstance(members, dict):
        raise HTTPException(400, "members 得是「用途 → 模型」的对象")
    bad = [k for k in members if k not in PURPOSE_KEYS]
    if bad:
        raise HTTPException(400, "不认识的用途：" + "、".join(bad))
    rows = []
    for purpose, key in members.items():
        key = str(key or "").strip()
        if not key:
            continue
        p = _provider_by_key(key)
        if not p:
            raise HTTPException(400, f"模型库里没有这个模型：{key}")
        rows.append((purpose, p["id"], key.rsplit("/", 1)[1]))
    d = dbm.db()
    with d.tx() as conn:
        old = d.one("SELECT id FROM model_set WHERE name=?", (name,))
        if old:
            sid = old["id"]
            conn.execute("UPDATE model_set SET note=?, updated_at=? WHERE id=?",
                         (str(payload.get("note") or ""), now_ms(), sid))
            conn.execute("DELETE FROM model_set_member WHERE set_id=?", (sid,))
        else:
            sid = conn.execute("INSERT INTO model_set(name,note,updated_at) VALUES(?,?,?)",
                               (name, str(payload.get("note") or ""), now_ms())).lastrowid
        for i, (purpose, pid, model_id) in enumerate(rows):
            conn.execute("INSERT INTO model_set_member(set_id,purpose,provider_id,model_id,sort)"
                         " VALUES(?,?,?,?,?)", (sid, purpose, pid, model_id, i))
    return {"ok": True, "name": name, "members": len(rows),
            "detail": _set_of(name)}


@router.delete("/model-sets")
async def model_sets_delete(request: Request, name: str):
    current_user(request)
    d = dbm.db()
    row = d.one("SELECT id FROM model_set WHERE name=?", (name,))
    if not row:
        raise HTTPException(404, "没有这个模型组")
    with d.tx() as conn:
        conn.execute("DELETE FROM model_set_member WHERE set_id=?", (row["id"],))
        conn.execute("DELETE FROM model_set WHERE id=?", (row["id"],))
    if _active_set() == name:
        d.execute("INSERT INTO setting(key,value_json,updated_at) VALUES(?,?,?)"
                  " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
                  " updated_at=excluded.updated_at", (ACTIVE_KEY, '""', now_ms()))
    return {"ok": True, "deleted": name}


@router.post("/model-sets/activate")
async def model_sets_activate(request: Request, payload: dict = Body(...)):
    """启用某个组（`name` 给空串 = 关掉，回到原来的解析顺序）。"""
    current_user(request)
    name = str(payload.get("name") or "").strip()
    if name and not _set_of(name):
        raise HTTPException(404, "没有这个模型组")
    dbm.db().execute("INSERT INTO setting(key,value_json,updated_at) VALUES(?,?,?)"
                     " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
                     " updated_at=excluded.updated_at",
                     (ACTIVE_KEY, dbm.db().jdumps(name), now_ms()))
    return {"ok": True, "active": name}


@router.get("/model-sets/resolve")
async def model_sets_resolve(request: Request, slug: str = "", purpose: str = "writer"):
    """这个用途最后会落到哪个模型上（把三个来源摊开给人看）。"""
    current_user(request)
    if purpose not in PURPOSE_KEYS:
        raise HTTPException(400, "不认识的用途：" + purpose)
    from .books import model_options
    from .write import _default_model, _preset_model
    opts = model_options()
    used = purpose_model(slug, purpose)
    via = "模型组" if used else ""
    mk = used or _preset_model(slug, purpose) or _default_model(slug)
    if not via:
        via = "预设" if _preset_model(slug, purpose) else "全局默认"
    return {"purpose": purpose, "modelKey": mk, "via": via, "activeSet": _active_set(),
            "setModel": used, "default": opts.get("default")}
