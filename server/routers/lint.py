# -*- coding: utf-8 -*-
"""质检（AI 味检测）：扫一章 / 扫全书 / 一键修 / 用模型看语境。

静态规则表在 `engine/lint_rules.py`（条数不写死，见 `L.RULE_SUMMARY` / `/lint/rules` 的 `count`），
纯本地、不花钱。
这里的第四条接口 `/lint/llm` 是**可选**的：用模型看规则看不出来的毛病
（人物前后不一致、情节断裂），没有配模型就直接告诉用户原因，不假装成功。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..engine import lint as L
from ..llm import LLMError
from ..llm.providers import complete, provider_of
from ..security import current_user
from ..store import chapter_files, hanzi, now_ms, read_text, write_text

router = APIRouter(tags=["lint"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


@router.get("/lint/rules")
async def lint_rules(request: Request):
    current_user(request)
    items = L.rules()
    return {"count": len(items), "items": items, "categories": L.CATEGORIES,
            "summary": L.RULE_SUMMARY,
            "gradeBands": [{"min": lo, "name": nm} for lo, nm in L.GRADE_BANDS]}


@router.post("/lint/scan")
async def lint_scan(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    path = str(payload.get("path") or "")
    text = str(payload.get("text") or "")
    if not text and path:
        try:
            text = read_text(s, path)
        except FileNotFoundError:
            raise HTTPException(404, "没有这一章")
    if not text:
        raise HTTPException(400, "要扫哪一章？给 path 或者 text")
    out = L.scan(text, path=path)
    dbm.db().execute(
        "INSERT INTO lint_run(slug,path,created_at,hits_json,stats_json) VALUES(?,?,?,?,?)",
        (s, path, now_ms(), dbm.Database.jdumps(out["hits"][:200]),
         dbm.Database.jdumps({**out["stats"], "grade": out["grade"]})))
    out["slug"] = s
    return out


@router.post("/lint/scan-book")
async def lint_scan_book(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    out = L.scan_book_cached(s, limit=int(payload.get("limit") or 400))
    for ch in out["chapters"]:
        dbm.db().execute(
            "INSERT INTO lint_run(slug,path,created_at,hits_json,stats_json) VALUES(?,?,?,'[]',?)",
            (s, ch["path"], now_ms(), dbm.Database.jdumps(
                {"hits": ch["hits"], "score": ch["score"], "byCategory": ch["byCategory"]})))
    _prune_runs(s)
    return out


@router.get("/lint/report")
async def lint_report(request: Request, slug: str, path: str = "", limit: int = 20):
    """最近几次扫描的结果（前端「质检」面板开屏读它）。"""
    current_user(request)
    s = _slug(slug)
    if path:
        rows = dbm.db().query(
            "SELECT * FROM lint_run WHERE slug=? AND path=? ORDER BY created_at DESC LIMIT ?",
            (s, path, limit))
    else:
        rows = dbm.db().query(
            "SELECT * FROM lint_run WHERE slug=? ORDER BY created_at DESC LIMIT ?", (s, limit))
    for r in rows:
        r["hits"] = dbm.Database.jloads(r["hits_json"], [])
        r["stats"] = dbm.Database.jloads(r["stats_json"], {})
    latest = rows[0] if rows else None
    # 面板开屏读的就是这里 —— 以前每次都把全书重扫（100 万字 6.5 秒），
    # 现在走按章缓存：只有改过的章才重扫（见 engine/lint.py 的 scan_book_cached）。
    return {"items": rows, "latest": latest,
            "book": L.scan_book_cached(s, limit=200) if not path else None}


LINT_KEEP = 2000        # 每本书最多留多少条扫描记录（每扫一次全书 = 一章一行，不砍会无限涨）


def _prune_runs(slug: str) -> None:
    """`lint_run` 是"每次扫描每章一行"：201 章的书点 10 次「扫全书」就是 2010 行。
    跟 `peer_log` 一样的治法：每本书只留最近 `LINT_KEEP` 条。"""
    dbm.db().execute(
        "DELETE FROM lint_run WHERE slug=? AND id < (SELECT MIN(id) FROM"
        " (SELECT id FROM lint_run WHERE slug=? ORDER BY id DESC LIMIT ?))", (slug, slug, LINT_KEEP))


@router.post("/lint/fix")
async def lint_fix(request: Request, payload: dict = Body(...)):
    """一键修：只删「删掉不影响意思」的东西。默认只预览，apply=true 才落盘。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    path = str(payload.get("path") or "")
    text = str(payload.get("text") or "")
    if not text and path:
        try:
            text = read_text(s, path)
        except FileNotFoundError:
            raise HTTPException(404, "没有这一章")
    if not text:
        raise HTTPException(400, "要修哪一章？给 path 或者 text")
    fixed, n = L.fix(text, rules=payload.get("rules"))
    before = L.scan(text, path=path)
    after = L.scan(fixed, path=path)
    out = {"removed": n, "changed": fixed != text, "words": hanzi(fixed),
           "before": {"hits": len(before["hits"]), "score": before["stats"]["score"]},
           "after": {"hits": len(after["hits"]), "score": after["stats"]["score"]},
           "text": fixed if payload.get("returnText", True) else ""}
    if payload.get("apply"):
        if not path:
            raise HTTPException(400, "要落盘就得说清是哪一章")
        res = write_text(s, path, fixed, origin="model", note="质检自动修")
        from .books import sync_book
        sync_book(s)
        out["applied"] = True
        out["mtimeMs"] = res["mtimeMs"]
        out["pending"] = True
    else:
        out["applied"] = False
    return out


@router.post("/lint/llm")
async def lint_llm(request: Request, payload: dict = Body(...)):
    """用模型查语境问题（不一致、断裂）。没模型时明确报错，不假装。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    path = str(payload.get("path") or "")
    model_key = str(payload.get("modelKey") or "").strip()
    if not model_key:
        row = dbm.db().one("SELECT value_json FROM setting WHERE key='models.default'")
        if row:
            v = dbm.db().jloads(row["value_json"], None)
            model_key = v if isinstance(v, str) else ""
    if not model_key:
        raise HTTPException(400, "没配模型：这一项要用模型才能看，去「工具 → 模型」加一个")
    try:
        provider, mid = provider_of(model_key)
    except LLMError as e:
        raise HTTPException(400, str(e))
    if path:
        text = read_text(s, path)
    else:
        files = chapter_files(s)
        text = "\n\n".join(read_text(s, c["path"]) for c in files[:4])
    from ..llm.prompts import book_context
    system = ("你是长篇小说的责任编辑。只挑**语境级**的硬伤：人物前后不一致、"
              "时间线矛盾、情节断裂、设定自相矛盾。不要挑文笔风格。"
              "输出格式：每条一行，`问题｜原文片段｜为什么不对`。没有硬伤就回「没发现硬伤」。")
    try:
        out = await complete(provider, mid, [{"role": "user", "content":
                              book_context(s, tail_chars=600) + "\n\n【待查正文】\n" + text[:12000]}],
                             system=system, temperature=0.2)
    except LLMError as e:
        raise HTTPException(502, str(e))
    return {"text": out.strip(), "model": model_key, "chars": len(text)}
