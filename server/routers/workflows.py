# -*- coding: utf-8 -*-
"""流水线（工作流）与批量操作：把「写正文 → 润色 → 质检」这类固定套路打包成一条命令。

为什么要有它：一章一章手点，等于把写作变成了体力活。这里把常用的几步连起来，
点一次就跑完；跑的是**后台任务**（`job` 表），能看进度、能取消，关掉页面也不影响。

安全线（跟写作台一致）：
* 动的都是正文时，`origin="model"` → 进「改动」收件箱，用户点头才算数。
* 每一步的结果都留在 `job.result_json` 里，跑完能回看每一步写了什么。
"""
from __future__ import annotations

import asyncio
import threading

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..args import num
from ..security import current_user
from ..store import now_ms

router = APIRouter(tags=["workflows"])

STEP_KINDS = [
    ("outline", "写细纲", "按这一章的要求生成细纲，存进大纲等人确认"),
    ("write", "写正文", "按细纲与前文写整章，进「改动」收件箱"),
    ("continue", "往下续写", "接着这一章已写的内容往下写"),
    ("polish", "润色", "删水词、把抽象换成具体，进「改动」收件箱"),
    ("summary", "写摘要", "两句话的摘要，存到章节上"),
    ("lint", "质检", "静态查 AI 味并修掉机械问题（不调模型）"),
]
KIND_KEYS = tuple(k for k, _, _ in STEP_KINDS)

# 现成的三条流水线：用户第一次打开就有能用的，不用自己拼
PRESETS = [
    {"name": "细纲→正文→润色", "note": "最常用的一条：先立骨架，再落笔，最后收水词",
     "steps": [{"kind": "outline"}, {"kind": "write"}, {"kind": "polish"}]},
    {"name": "正文→质检", "note": "写完一遍后过机：查 AI 味并修掉机械问题",
     "steps": [{"kind": "write"}, {"kind": "lint"}]},
    {"name": "续写→摘要", "note": "接着往下写一章，顺手把摘要填上",
     "steps": [{"kind": "continue"}, {"kind": "summary"}]},
]


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _doc(r: dict) -> dict:
    steps = dbm.db().jloads(r["steps_json"], [])
    return {"id": r["id"], "name": r["name"], "note": r["note"], "slug": r["slug"],
            "steps": steps, "stepCount": len(steps), "updatedAt": r["updated_at"]}


def _job_progress(jid: str, percent: int, note: str = "") -> None:
    dbm.db().execute("UPDATE job SET progress=?, updated_at=? WHERE job_id=?",
                     (max(0, min(100, int(percent))), now_ms(), jid))
    if note:
        dbm.db().execute("UPDATE job SET title=? WHERE job_id=?", (note[:120], jid))


def _state(jid: str) -> str:
    return str(dbm.db().scalar("SELECT status FROM job WHERE job_id=?", (jid,)) or "")


def _wait_if_paused(jid: str) -> bool:
    """任务被暂停时就地等着（不退出、不丢进度）；等的时候被取消就返回 False。

    暂停不是「假装停一下」：跑完当前这一步再停，进度停在哪儿就是哪儿，
    继续之后从下一步接着跑（每一步的结果都留在 job.result_json 里）。
    """
    import time as _t
    while _state(jid) == "paused":
        _t.sleep(0.8)
    return _state(jid) != "canceled"


# ── 单步执行（批量与流水线共用同一份实现）────────────────────────────────────
async def run_step(slug: str, step: dict, default_path: str = "", jid: str = "") -> dict:
    from . import lint as lint_r
    from .write import _apply, _respond, build_prompt
    kind = str(step.get("kind") or "").strip()
    if kind not in KIND_KEYS:
        raise HTTPException(400, "不认识的步骤：" + kind)
    path = str(step.get("path") or default_path or "")
    inst = str(step.get("instruction") or "").strip()
    if kind == "lint":
        if not path:
            raise HTTPException(400, "质检得指名哪一章")
        from ..engine import lint as L
        from ..store import read_text
        text = read_text(slug, path)
        report = L.scan(text, path=path)
        hits = report.get("hits") or []
        n_fixed = 0
        if step.get("fix", True) and hits:
            new_text, n_fixed = L.fix(text)
            if new_text != text and n_fixed:
                _apply(slug, path, new_text, {"apply": True, "mode": "polish"},
                       "流水线：质检修复")
        dbm.db().execute(
            "INSERT INTO lint_run(slug,path,created_at,hits_json,stats_json) VALUES(?,?,?,?,?)",
            (slug, path, now_ms(), dbm.db().jdumps(hits[:200]),
             dbm.db().jdumps({**report["stats"], "grade": report["grade"]})))
        return {"kind": kind, "path": path, "issues": len(hits), "fixed": n_fixed,
                "score": report["stats"]["score"], "grade": report["grade"]}
    if not path:
        raise HTTPException(400, "这一步得指名哪一章")
    mode = {"outline": "outline", "write": "chapter", "continue": "continue",
            "polish": "polish", "summary": "summary"}[kind]
    payload = {"slug": slug, "path": path, "mode": mode, "stream": False,
               "instruction": inst, "maxTokens": int(step.get("maxTokens") or 0) or None}
    out = await _respond(slug, {**payload, "apply": False}, mode)
    text = (out.get("text") or "").strip()
    res = {"kind": kind, "path": path, "words": len(text), "model": out.get("model"),
           "preview": text[:200]}
    if not text:
        res["empty"] = True
        return res
    if kind == "outline":
        if step.get("save", True):
            oid = dbm.db().execute(
                "INSERT INTO outline(slug,chapter_path,level,body,approved,updated_at)"
                " VALUES(?,?,?,?,0,?)", (slug, path, "detail", text, now_ms()))
            res["outlineId"] = oid
    elif kind == "summary":
        dbm.db().execute("UPDATE chapter SET summary=?, updated_at=? WHERE slug=? AND path=?",
                         (text, now_ms(), slug, path))
    else:                                   # write / continue / polish → 落盘进收件箱
        if step.get("apply", True):
            res.update(_apply(slug, path, text,
                              {"apply": True, "mode": mode, "append": kind == "continue"},
                              "流水线：" + {"write": "写正文", "continue": "续写",
                                            "polish": "润色"}[kind]))
    return res


# ── 后台跑 ──────────────────────────────────────────────────────────────────
async def _run_steps(jid: str, slug: str, steps: list[dict], default_path: str) -> None:
    results, done = [], 0
    try:
        for i, step in enumerate(steps):
            if not _wait_if_paused(jid):
                from .agent import finish_job
                finish_job(jid, "canceled", result={"steps": results})
                return
            _job_progress(jid, int(i * 100 / max(1, len(steps))))
            try:
                r = await run_step(slug, step, default_path, jid)
            except Exception as e:                       # 单步失败别把整条流水线炸掉
                r = {"kind": step.get("kind"), "error": str(e)[:300], "path": default_path}
            results.append(r)
            done += 1
            _job_progress(jid, int(done * 100 / max(1, len(steps))))
            if not _wait_if_paused(jid):          # 这一步刚跑完就被暂停/取消
                if _state(jid) == "canceled":
                    from .agent import finish_job
                    finish_job(jid, "canceled", result={"steps": results})
                    return
        _wait_if_paused(jid)                  # 最后一步之后被暂停：等它继续再收尾
        from .agent import finish_job
        bad = [r for r in results if r.get("error")]
        finish_job(jid, "failed" if bad else "done",
                   result={"steps": results, "ok": len(results) - len(bad)},
                   error=("；".join(r["error"] for r in bad)[:300] if bad else ""))
    except Exception as e:                               # 兜底：任务状态不能烂在 running
        from .agent import finish_job
        finish_job(jid, "failed", result={"steps": results}, error=str(e)[:300])


def start_job_thread(kind: str, title: str, slug: str, steps: list[dict],
                     default_path: str = "") -> str:
    from .agent import new_job
    jid = new_job(kind, title, slug, {"steps": steps, "path": default_path})
    t = threading.Thread(target=lambda: asyncio.run(
        _run_steps(jid, slug, steps, default_path)), daemon=True,
        name="job-" + jid)
    t.start()
    return jid


# ── 流水线 CRUD ─────────────────────────────────────────────────────────────
@router.get("/workflows")
async def workflows(request: Request, slug: str = ""):
    current_user(request)
    d = dbm.db()
    rows = d.query("SELECT * FROM workflow WHERE slug='' OR slug=? ORDER BY slug, name",
                   (slug or "",))
    if not rows:
        # 一条都没有时，把三条现成的写进去（用户第一次点开就有东西可用）
        for p in PRESETS:
            d.execute("INSERT OR IGNORE INTO workflow(slug,name,note,steps_json,updated_at)"
                      " VALUES('',?,?,?,?)",
                      (p["name"], p["note"], d.jdumps(p["steps"]), now_ms()))
        rows = d.query("SELECT * FROM workflow WHERE slug='' OR slug=? ORDER BY slug, name",
                       (slug or "",))
    return {"items": [_doc(r) for r in rows], "total": len(rows),
            "kinds": [{"key": k, "name": n, "hint": h} for k, n, h in STEP_KINDS]}


@router.post("/workflows/save")
async def workflows_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 40:
        raise HTTPException(400, "流水线得有个 40 字以内的名字")
    steps = payload.get("steps") or []
    if not isinstance(steps, list) or not steps:
        raise HTTPException(400, "至少得有一两步")
    if len(steps) > 8:
        raise HTTPException(400, "步骤数超出上限（最多 8 步）")
    for st in steps:
        if str((st or {}).get("kind") or "") not in KIND_KEYS:
            raise HTTPException(400, "不认识的步骤：" + str((st or {}).get("kind")))
    slug = str(payload.get("slug") or "")
    if slug:
        slug = _slug(slug)
    d = dbm.db()
    old = d.one("SELECT id FROM workflow WHERE slug=? AND name=?", (slug, name))
    if old:
        d.execute("UPDATE workflow SET note=?, steps_json=?, updated_at=? WHERE id=?",
                  (str(payload.get("note") or ""), d.jdumps(steps), now_ms(), old["id"]))
        wid = old["id"]
    else:
        wid = d.execute("INSERT INTO workflow(slug,name,note,steps_json,updated_at)"
                        " VALUES(?,?,?,?,?)",
                        (slug, name, str(payload.get("note") or ""), d.jdumps(steps), now_ms()))
    return {"ok": True, "id": wid, "name": name, "steps": len(steps)}


@router.delete("/workflows")
async def workflows_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    row = dbm.db().one("SELECT * FROM workflow WHERE id=?", (int(id),))
    if not row:
        raise HTTPException(404, "没有这条流水线")
    dbm.db().execute("DELETE FROM workflow WHERE id=?", (int(id),))
    return {"ok": True, "deleted": int(id), "name": row["name"]}


@router.post("/workflows/run")
async def workflows_run(request: Request, payload: dict = Body(...)):
    """跑一条流水线（或直接给 steps）。返回 jobId，进度去 `/agent/jobs` 看。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    path = str(payload.get("path") or "")
    steps = None
    if payload.get("id"):
        row = dbm.db().one("SELECT * FROM workflow WHERE id=?",
                           (num(payload.get("id"), 0, name="流水线号"),))
        if not row:
            raise HTTPException(404, "没有这条流水线")
        steps = dbm.db().jloads(row["steps_json"], [])
    elif payload.get("steps"):
        steps = payload["steps"]
    elif payload.get("name"):
        row = dbm.db().one("SELECT * FROM workflow WHERE name=? AND (slug='' OR slug=?)",
                           (str(payload["name"]), s))
        if not row:
            raise HTTPException(404, "没有这条流水线")
        steps = dbm.db().jloads(row["steps_json"], [])
    if not steps:
        raise HTTPException(400, "没说要跑哪条流水线")
    if not path and any(st.get("kind") != "lint" for st in steps):
        raise HTTPException(400, "得先挑一章")
    if path:
        from .books import require_path
        path = require_path(s, path)
    title = "流水线：" + str(payload.get("name") or "%d 步" % len(steps)) + \
            ("（%s）" % path.split("/")[-1] if path else "")
    jid = start_job_thread("workflow", title, s, steps, path)
    return {"ok": True, "jobId": jid, "steps": len(steps), "path": path}


# ── 批量操作 ────────────────────────────────────────────────────────────────
BATCH_MODES = {"outline": "写细纲", "polish": "润色", "summary": "写摘要",
               "chapter": "写正文", "continue": "续写"}


@router.post("/write/batch")
async def write_batch(request: Request, payload: dict = Body(...)):
    """一次处理多章：给一串 path，按 mode 挨个跑，进度在后台任务里。

    跑出来的东西跟单章一模一样：细纲进大纲表等人确认、正文/润色进「改动」收件箱。
    """
    current_user(request)
    s = _slug(payload.get("slug"))
    mode = str(payload.get("mode") or "outline")
    if mode not in BATCH_MODES:
        raise HTTPException(400, "批量只支持：" + "、".join(BATCH_MODES))
    paths = [str(p) for p in (payload.get("paths") or []) if str(p).strip()]
    if not paths:
        raise HTTPException(400, "先挑几章")
    if len(paths) > 50:
        raise HTTPException(400, "一次最多 50 章，分两回跑吧")
    from .books import require_path
    paths = [require_path(s, p) for p in paths]
    inst = str(payload.get("instruction") or "").strip()
    steps = [{"kind": {"outline": "outline", "polish": "polish", "summary": "summary",
                       "chapter": "write", "continue": "continue"}[mode],
              "path": p, "instruction": inst, "apply": bool(payload.get("apply", True)),
              "save": True} for p in paths]
    jid = start_job_thread("batch", "批量" + BATCH_MODES[mode] + "（%d 章）" % len(paths),
                           s, steps, "")
    return {"ok": True, "jobId": jid, "mode": mode, "chapters": len(paths),
            "paths": paths}
