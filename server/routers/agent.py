# -*- coding: utf-8 -*-
"""AI 会话、档案、任务、技能、运行痕迹。

会话事件流（SSE）的形状与旧层实测一致（见 ref/golden）：
    {seq, sessionId, invocationId, eventEpoch, kind, event:{type, ...}}
断线重连用 `?after=<最后收到的 seq>` 补齐，不丢话。
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import db as dbm
from .. import events
from ..engine import agent_runtime as rt
from ..engine import orchestra
from ..llm.prompts import PROFILES, profile_of
from ..security import current_user
from ..store import now_ms

router = APIRouter(tags=["agent"])


def _need_sid(sid) -> int:
    try:
        return int(sid)
    except (TypeError, ValueError):
        raise HTTPException(400, "会话标识不合法")


def _clip(text: str, term: str) -> str:
    """把命中那一段前后各 60 字截出来。"""
    i = text.find(term)
    if i < 0:
        return text[:140]
    a, b = max(0, i - 60), min(len(text), i + len(term) + 60)
    return ("…" if a else "") + text[a:b] + ("…" if b < len(text) else "")


def _hit_of(d, sid: int, term: str) -> str:
    """检索时给一小段命中上下文（没有检索词就返回空串）。

    正文里命中就截正文；只在标题/摘要里命中（或者这会话还没有正文）就退到那里，
    总之不能出现「搜到了却什么都不显示」。
    """
    if not term:
        return ""
    row = d.one("SELECT blocks_json FROM chat_entry WHERE session_id=? AND blocks_json LIKE ?"
                " ORDER BY seq LIMIT 1", (sid, "%" + term + "%"))
    if row:
        blocks = d.jloads(row["blocks_json"], [])
        text = "".join(str(b.get("content", "")) for b in blocks if b.get("type") == "text")
        if text:
            return _clip(text, term)
    meta = d.one("SELECT title, summary FROM chat_session WHERE id=?", (sid,)) or {}
    for v in (meta.get("title") or "", meta.get("summary") or ""):
        if term in v:
            return _clip(v, term)
    return ""


# ── 会话 ────────────────────────────────────────────────────────────────────
@router.get("/agent/sessions")
async def sessions(request: Request, scope: str = "all", projectRoot: str = "",
                    limit: int = 50, q: str = ""):
    """会话列表。`q` 是检索（阶段 16.7）：标题、摘要、正文里任意一处命中就算。

    搜索在 SQL 里做（标题/摘要）+ 正文用 LIKE 关联一次，路子简单但够快；
    命中正文时把那一段前后 60 字带回来，方便一眼看出「是不是我要找的那次」。
    """
    current_user(request)
    d = dbm.db()
    where, params = "1=1", []
    if scope in ("project", "book") and projectRoot:
        where += " AND slug=?"
        params.append(projectRoot)
    if scope == "all":
        where += " AND archived=0"
    elif scope in ("archived",):
        where += " AND archived=1"
    term = (q or "").strip()
    if term:
        like = "%" + term + "%"
        where += (" AND (title LIKE ? OR summary LIKE ? OR id IN"
                  " (SELECT session_id FROM chat_entry WHERE blocks_json LIKE ?))")
        params += [like, like, like]
    rows = d.query(f"SELECT * FROM chat_session WHERE {where} ORDER BY updated_at DESC LIMIT ?",
                   (*params, int(limit)))
    items = []
    for r in rows:
        usage = d.one("SELECT SUM(input_tokens) i, SUM(output_tokens) o FROM trace WHERE session_id=?",
                      (str(r["id"]),)) or {}
        last = d.one("SELECT blocks_json FROM chat_entry WHERE session_id=? AND type='assistant'"
                     " ORDER BY seq DESC LIMIT 1", (r["id"],))
        preview = ""
        if last:
            blocks = d.jloads(last["blocks_json"], [])
            preview = "".join(str(b.get("content", "")) for b in blocks
                              if b.get("type") == "text")[:120]
        items.append({
            "sessionId": r["id"], "sessionIdentity": r["identity"],
            "profileKey": r["profile_key"], "currentProjectRoot": r["slug"],
            "title": r["title"], "summary": r["summary"], "status": r["status"],
            "updatedAt": r["updated_at"], "archived": bool(r["archived"]),
            "lastMessagePreview": preview,
            "hit": _hit_of(d, r["id"], term),
            "usage": {"input": usage.get("i") or 0, "output": usage.get("o") or 0,
                      "cacheRead": 0, "cacheWrite": 0,
                      "totalTokens": (usage.get("i") or 0) + (usage.get("o") or 0),
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
            "profileAvailability": "loaded" if r["profile_key"] in PROFILES else "loaded",
            "interaction": {"canInvoke": True, "canResolveUserInput": False,
                            "canRegisterAttachment": True, "canInsertAttachment": True,
                            "canMutateHistory": True, "canChangeRuntime": True,
                            "canArchive": True, "canRestore": bool(r["archived"]),
                            "canAbort": r["status"] == "running"},
        })
    return {"items": items, "total": len(items), "offset": 0, "limit": int(limit),
            "hasMore": len(items) >= int(limit),
            "eventCursor": {"eventEpoch": dbm.db().scalar(
                "SELECT epoch FROM chat_event ORDER BY seq DESC LIMIT 1") or "", "after": 0}}


@router.post("/agent/sessions")
async def session_new(request: Request, payload: dict = Body(...)):
    current_user(request)
    pk = payload.get("profileKey") or "leader.default"
    if pk not in PROFILES:
        raise HTTPException(400, f"没有这个档案：{pk}")
    slug = payload.get("currentProjectRoot") or payload.get("projectRoot") or ""
    return rt.create_session(pk, slug, payload.get("title") or "",
                             payload.get("modelKey") or "")


@router.get("/agent/sessions/{sid}")
async def session_get(sid: str, request: Request):
    current_user(request)
    try:
        return rt.session_snapshot(_need_sid(sid))
    except KeyError:
        raise HTTPException(404, "没有这个会话")


@router.delete("/agent/sessions/{sid}")
async def session_delete(sid: str, request: Request):
    current_user(request)
    i = _need_sid(sid)
    dbm.db().execute("DELETE FROM chat_session WHERE id=?", (i,))
    return {"ok": True}


@router.post("/agent/sessions/{sid}/invocations")
async def session_invoke(sid: str, request: Request, payload: dict = Body(...)):
    current_user(request)
    i = _need_sid(sid)
    row = dbm.db().one("SELECT * FROM chat_session WHERE id=?", (i,))
    if not row:
        raise HTTPException(404, "没有这个会话")
    if row["status"] == "running":
        raise HTTPException(409, "这个会话还在回复，等它说完或先按停")
    text = ((payload.get("message") or {}).get("text") or payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "没有要发的内容")
    mode = str(payload.get("mode") or "").strip()
    if mode and mode not in orchestra.MODES:
        raise HTTPException(400, f"不认识的模式：{mode}（可选 {list(orchestra.MODES)}）")
    inv = rt.start_invocation(i, text, model_key=payload.get("modelKey") or "",
                              payload={"mode": mode, "path": payload.get("path") or "",
                                         "divided": payload.get("divided", True)})
    return {"invocationId": inv, "status": "running", "mode": mode,
            "clientMessageId": payload.get("clientMessageId") or ""}


@router.post("/agent/sessions/{sid}/abort")
async def session_abort(sid: str, request: Request):
    current_user(request)
    rt.abort(_need_sid(sid))
    return {"ok": True}


@router.post("/agent/sessions/{sid}/commands")
async def session_command(sid: str, request: Request, payload: dict = Body(...)):
    current_user(request)
    i = _need_sid(sid)
    cmd = (payload.get("command") or "").strip()
    d = dbm.db()
    if cmd == "rename":
        d.execute("UPDATE chat_session SET title=?, updated_at=? WHERE id=?",
                  (payload.get("title") or "未命名", now_ms(), i))
    elif cmd == "archive":
        d.execute("UPDATE chat_session SET archived=1, updated_at=? WHERE id=?", (now_ms(), i))
    elif cmd == "restore":
        d.execute("UPDATE chat_session SET archived=0, updated_at=? WHERE id=?", (now_ms(), i))
    elif cmd in ("model", "set-model"):
        d.execute("UPDATE chat_session SET model_key=?, updated_at=? WHERE id=?",
                  (payload.get("modelKey") or "", now_ms(), i))
    else:
        raise HTTPException(400, f"不认识的命令：{cmd}")
    events.emit(i, "session_state_changed",
                {"type": "session_state_changed", "state": rt._state(i)})
    return {"ok": True, "command": cmd}


@router.get("/agent/orchestra")
async def orchestra_catalog(request: Request, slug: str = ""):
    """角色与模式目录：界面上要显示"这一步是谁在干活"。

    多带一个 `defaultMode`（）：预设里主创的「干活方式」以前是个**没人读**的 radio，
    现在它是"这本书 AI 对话的默认干活方式"。用户在对话页临时切换，以对话页为准
    （前端只在"这本书还没选过"时才拿它当初值）。没配置 / 配得不认识 → 空串，前端自己回落。
    """
    from ..llm.prompts import planning_mode, preset_values
    try:
        dflt = planning_mode(preset_values(slug))
    except Exception:
        dflt = ""
    return {"modes": orchestra.mode_names(), "roles": orchestra.roles_catalog(),
            "defaultMode": dflt}


@router.get("/agent/sessions/{sid}/runs")
async def session_runs(sid: str, request: Request, limit: int = 5):
    """这次编排到底谁干了什么、交接了什么、被权限挡了什么 —— 可复查。"""
    current_user(request)
    return {"runs": orchestra.run_record(_need_sid(sid), limit)}


@router.get("/agent/sessions/{sid}/events")
async def session_events(sid: str, request: Request, after: int = 0):
    current_user(request)
    i = _need_sid(sid)
    if not dbm.db().one("SELECT id FROM chat_session WHERE id=?", (i,)):
        raise HTTPException(404, "没有这个会话")
    return StreamingResponse(events.sse(i, after), media_type="text/event-stream",
                             headers={"cache-control": "no-cache", "x-accel-buffering": "no",
                                      "connection": "keep-alive"})


# ── 档案 ────────────────────────────────────────────────────────────────────
@router.get("/agent/profiles/catalog")
async def profiles_catalog(request: Request):
    current_user(request)
    out = []
    for key, p in PROFILES.items():
        out.append({
            "profileKey": key, "kind": "agent", "name": p["name"],
            "description": p["description"], "fileName": f"builtin/{key}.profile.md",
            "source": "install", "overrideState": "install_only", "loadStatus": "loaded",
            "schemaLocked": True, "canEdit": False, "canRestore": False,
            "creationMode": "public", "issues": [],
        })
    return out


@router.get("/agent/profiles/build-status")
async def profiles_build_status(request: Request):
    current_user(request)
    return {"profiles": _build_status(), "items": _build_status()}


def _build_status() -> list[dict]:
    return [{"profileKey": k, "name": p["name"], "loadStatus": "loaded", "issue": None,
             "buildState": {"running": False, "queued": False, "reason": None,
                            "updatedAt": None}}
            for k, p in PROFILES.items()]


@router.get("/agent/profiles/source")
async def profiles_source_get(request: Request, profileKey: str = "", fileName: str = ""):
    return await profiles_source(request, {"profileKey": profileKey, "fileName": fileName})


@router.post("/agent/profiles/source")
async def profiles_source(request: Request, payload: dict = Body(default={})):
    current_user(request)
    key = ""
    fname = str((payload or {}).get("fileName") or "")
    if fname:
        key = fname.split("/")[-1].split(".")[0]
    key = key or str((payload or {}).get("profileKey") or "")
    if key not in PROFILES:
        raise HTTPException(400, f"没有这个档案：{key}")
    p = PROFILES[key]
    return {"profileKey": key, "toolKeys": p["tools"], "source": p["system"],
            "catalogItem": {"name": p["name"], "description": p["description"]}}


@router.post("/agent/profiles/compile-all")
async def profiles_compile(request: Request):
    current_user(request)
    return {"ok": True, "compiled": len(PROFILES)}


@router.get("/agent/skills")
async def agent_skills(request: Request):
    """AI **真正能调用**的工具清单。

    改的（）：「说不上来的，有一种**儿戏感**……很多功能没什么用」——
    以前这里是**写死的 5 条描述**（write_chapter / llmlint / consistency…），
    跟运行时真放行的工具**对不上**：面板说有「一致性检查」，AI 手里根本没有这个工具。
    现在改成**从真注册表读**（`engine/agent_runtime.py: TOOLS`）：每个工具一条，
    带中文名（前端 TOOL_LABEL）、说明（提示词里那份 `_TOOL_HELP`）、
    以及**哪些角色拿得到它**（PROFILES）—— 面板说什么，AI 就真能做什么。
    """
    current_user(request)
    from ..engine.agent_runtime import TOOLS
    from ..llm.prompts import PROFILES, _TOOL_HELP
    labels: dict = {}
    try:
        blob = (Path(__file__).resolve().parents[2] / "frontend" / "js" / "chat.js").read_text("utf-8")
        k = blob.index("const TOOL_LABEL = {")
        labels = dict(re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'", blob[k:blob.index("};", k)]))
    except Exception:
        labels = {}
    who: dict = {}
    for key, prof in PROFILES.items():
        for t in prof.get("tools") or []:
            who.setdefault(t, []).append(prof.get("name") or key)
    return [{"name": name, "label": labels.get(name) or name,
             "description": _TOOL_HELP.get(name, "").strip(),
             "agents": who.get(name, [])} for name in sorted(TOOLS)]


# ── 后台任务 ────────────────────────────────────────────────────────────────
def _job_doc(r: dict, *, with_result: bool = False) -> dict:
    out = {"jobId": r["job_id"], "kind": r["kind"], "title": r["title"],
           "slug": r["slug"], "status": r["status"], "progress": r["progress"],
           "error": r["error"], "createdAt": r["created_at"],
           "updatedAt": r["updated_at"], "finishedAt": r["finished_at"]}
    if with_result:
        out["steps"] = dbm.db().jloads(r["result_json"], {}).get("steps") or []
        out["payload"] = dbm.db().jloads(r["payload_json"], {})
    return out


@router.get("/agent/jobs")
async def jobs(request: Request, limit: int = 50):
    current_user(request)
    rows = dbm.db().query("SELECT * FROM job ORDER BY updated_at DESC LIMIT ?", (int(limit),))
    return {"jobs": [_job_doc(r) for r in rows],
            "eventCursor": {"eventEpoch": "", "after": 0}}


@router.get("/agent/jobs/{job_id}")
async def job_detail(job_id: str, request: Request):
    """单条任务的详情：**每一步的结果都在里面**（批量/流水线跑完靠它回看）。"""
    current_user(request)
    r = dbm.db().one("SELECT * FROM job WHERE job_id=?", (job_id,))
    if not r:
        raise HTTPException(404, "没有这个任务")
    return _job_doc(r, with_result=True)


@router.post("/agent/jobs/{job_id}/cancel")
async def job_cancel(job_id: str, request: Request):
    current_user(request)
    dbm.db().execute("UPDATE job SET status='canceled', updated_at=? WHERE job_id=? AND"
                     " status IN ('queued','running')", (now_ms(), job_id))
    return {"ok": True}


@router.post("/agent/jobs/{job_id}/pause")
async def job_pause(job_id: str, request: Request):
    """暂停一个正在跑的长任务（批量 / 流水线）。

    当前这一步跑完就停在原地：进度、已经跑出来的结果都留着；点继续从下一步接着跑。
    跟「取消」是两回事 —— 取消是不要了，暂停是待会儿还接着来。
    """
    current_user(request)
    n = dbm.db().rowcount("UPDATE job SET status='paused', updated_at=? WHERE job_id=?"
                          " AND status='running'", (now_ms(), job_id))
    if not n:
        raise HTTPException(409, "这个任务现在不是「正在跑」，暂停不了")
    return {"ok": True, "status": "paused"}


@router.post("/agent/jobs/{job_id}/resume")
async def job_resume(job_id: str, request: Request):
    current_user(request)
    n = dbm.db().rowcount("UPDATE job SET status='running', updated_at=? WHERE job_id=?"
                          " AND status='paused'", (now_ms(), job_id))
    if not n:
        raise HTTPException(409, "这个任务不在暂停中")
    return {"ok": True, "status": "running"}


@router.post("/agent/jobs/clear-finished")
async def jobs_clear(request: Request):
    current_user(request)
    # 必须用 rowcount：execute() 回的是 cursor.lastrowid，DELETE 之后它给的是
    # **上一次 INSERT 留下的 rowid**，拿来当"清了几条"会报出一个凭空的数字
    # （实测：实际只该清 23 条，接口报 194）。
    n = dbm.db().rowcount("DELETE FROM job WHERE status IN ('done','failed','canceled')")
    return {"ok": True, "cleared": n}


def new_job(kind: str, title: str, slug: str = "", payload: dict | None = None) -> str:
    import uuid
    jid = uuid.uuid4().hex[:16]
    n = now_ms()
    dbm.db().execute("INSERT INTO job(job_id,kind,title,slug,status,payload_json,created_at,"
                     "updated_at) VALUES(?,?,?,?,?,?,?,?)",
                     (jid, kind, title, slug, "running", dbm.db().jdumps(payload or {}), n, n))
    return jid


def finish_job(jid: str, status: str = "done", *, result: dict | None = None, error: str = "") -> None:
    dbm.db().execute("UPDATE job SET status=?, result_json=?, error=?, updated_at=?, finished_at=?"
                     " WHERE job_id=?",
                     (status, dbm.db().jdumps(result or {}), error, now_ms(), now_ms(), jid))


# ── 运行痕迹 ────────────────────────────────────────────────────────────────
@router.get("/agent/traces/recent")
async def traces(request: Request, limit: int = 50):
    current_user(request)
    rows = dbm.db().query("SELECT * FROM trace ORDER BY created_at DESC LIMIT ?", (int(limit),))
    return {"entries": [{"id": str(r["id"]), "ts": r["created_at"], "status": "ok",
                         "kind": r["kind"], "invocationId": r["invocation_id"],
                         "turnIndex": 0, "provider": r["provider"], "model": r["model"],
                         "stopReason": r["stop_reason"] or "stop",
                         "totalTokens": r["input_tokens"] + r["output_tokens"],
                         "usage": {"input": r["input_tokens"], "output": r["output_tokens"],
                                   "cacheRead": r["cache_read"], "cacheWrite": r["cache_write"]},
                         "toolsHash": "", "ttftMs": r["ttft_ms"], "durationMs": r["duration_ms"],
                         "bytes": 0, "bucket": "1m"} for r in rows],
            "items": [{"id": str(r["id"]), "ts": r["created_at"],
                       "stopReason": r["stop_reason"] or "stop", "durationMs": r["duration_ms"],
                       "ttftMs": r["ttft_ms"], "provider": r["provider"], "model": r["model"],
                       "totalTokens": r["input_tokens"] + r["output_tokens"],
                       "correlation": {"kind": r["kind"]}} for r in rows]}
