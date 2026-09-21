# -*- coding: utf-8 -*-
"""Agent 运行时：把一句话变成"读文件 → 想 → 写文件 → 汇报"的一串动作，全过程流式可见。

工具协议用**纯文本行**（`[tool:名字] {json}`）而不是各家不一的 function calling ——
中文模型对文本协议更稳，且不挑渠道（见 docs/设计方案 §5.4）。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid

from .. import db as dbm
from .. import events
from ..llm.prompts import build_system, digest_system, preset_values, profile_of
from ..llm.providers import LLMError, provider_of, stream_chat, stream_with_fallback

def note_tool_call(called: list, files: list, name: str, args: dict, res: dict | None) -> None:
    """把一次工具调用记进「这一轮 AI 用了什么」的账（界面上那张卡片）。

    单独抽出来是为了能被**断言**：判据用合成的 write_file 参数调这个函数，
    就能验证"改了哪些文件"真的会记账，而**不用真往用户的书里写一个文件**。
    """
    called.append({"name": name, "arg": _arg_line(args),
                   "ok": not (isinstance(res, dict) and "error" in res)})
    if name == "write_file":
        p = str((args or {}).get("path") or "").strip()
        if p and p not in files:
            files.append(p)


def _arg_line(a: dict) -> str:
    """工具参数压成一行给人看的 —— 界面上 chip 与「用了什么」卡片只显示这一小截。"""
    if not isinstance(a, dict):
        return ""
    for k in ("path", "q", "entity", "name", "prefix", "result", "content"):
        v = a.get(k)
        if v:
            return str(v).replace("\n", " ").strip()[:60]
    return ""


TOOL_LINE = re.compile(r"^\s*\[tool:([A-Za-z_.]+)\]\s*(\{.*\})?\s*$")
MAX_ROUNDS = 6

RUNNING: dict[int, asyncio.Task] = {}
ABORTS: set[int] = set()


# ── 会话 ────────────────────────────────────────────────────────────────────
def session_row(sid: int) -> dict:
    row = dbm.db().one("SELECT * FROM chat_session WHERE id=?", (sid,))
    if not row:
        raise KeyError("没有这个会话")
    return row


def session_snapshot(sid: int) -> dict:
    d = dbm.db()
    s = session_row(sid)
    entries = [_entry_payload(e["id"], _row=e)
               for e in d.query("SELECT * FROM chat_entry WHERE session_id=? ORDER BY seq", (sid,))]
    model = {}
    if s["model_key"] and "/" in s["model_key"]:
        grp, mid = s["model_key"].split("/", 1)
        model = {"modelId": mid, "providerConfigId": grp}
    return {
        "sessionId": s["id"], "identity": s["identity"],
        "summary": {"title": s["title"], "profileKey": s["profile_key"],
                    "status": s["status"], "archived": bool(s["archived"]),
                    "currentProjectRoot": s["slug"],
                    "activeInvocation": bool(s["status"] == "running"),
                    "model": model},
        "profileKey": s["profile_key"], "title": s["title"],
        "model": model,
        "history": {"entries": entries},
        "activeInvocation": bool(s["status"] == "running"),
        # ⚠ 第 42 轮只增不减加的一条：**这个会话的事件头**（最大 seq）。
        # 为什么要它：SSE 一接上会把历史事件重放一遍（本来是为了"中途断线补课"），
        # 前端于是把**上一轮已经跑完的 message_start 又当成本轮重新建一遍**，
        # 长出几个"正在打字…"的空气泡（用户看到的一屏空泡泡）。前端拿这个数当 `after` 传回去，
        # 就只收"这之后的"事件，历史交给快照渲染 —— 两边各管一段，不重叠。
        "lastEventSeq": int(d.scalar("SELECT MAX(seq) FROM chat_event WHERE session_id=?",
                                     (sid,), default=0) or 0),
    }


def _entry_payload(entry_id: int, _row: dict | None = None) -> dict:
    row = _row or dbm.db().one("SELECT * FROM chat_entry WHERE id=?", (entry_id,))
    blocks = dbm.db().jloads(row["blocks_json"], [])
    out = {"id": f"e{row['id']}", "type": row["type"], "blocks": blocks,
           "usage": dbm.db().jloads(row["usage_json"], {}), "timestamp": row["created_at"]}
    # 前端按 type 分派：user 看 blocks[].content，assistant 看 content/toolCalls
    if row["type"] == "assistant":
        text = "".join(str(b.get("content", "")) for b in blocks if b.get("type") == "text")
        out["content"] = {"preview": text}
        # 多 Agent 编排：每条回复挂上"这一步是谁做的"，界面上显示角色徽章
        rl = next((b for b in blocks if b.get("type") == "role"), None)
        if rl:
            out["role"] = rl.get("role") or ""
            out["roleName"] = rl.get("roleName") or ""
            out["roleTitle"] = rl.get("title") or ""
            out["orchestraSeq"] = rl.get("seq")
        out["toolCalls"] = [{"name": b.get("name"), "args": b.get("args")}
                            for b in blocks if b.get("type") == "tool_call"]
        out["model"] = dbm.db().jloads(row["usage_json"], {}).get("model", "")
    elif row["type"] == "tool_result":
        first = blocks[0] if blocks else {}
        out["toolName"] = first.get("name") or ""
        out["result"] = {"content": first.get("content") or []}
        out["isError"] = bool(first.get("isError"))
    elif row["type"] == "system":
        text = "".join(str(b.get("content", "")) for b in blocks if b.get("type") == "text")
        out["content"] = {"preview": text}
        out["text"] = text
    return out


def append_entry(sid: int, type_: str, blocks: list, *, usage: dict | None = None,
                 emit_event: bool = True) -> int:
    d = dbm.db()
    seq = (d.scalar("SELECT MAX(seq) FROM chat_entry WHERE session_id=?", (sid,)) or 0) + 1
    try:
        eid = d.execute(
            "INSERT INTO chat_entry(session_id,seq,type,blocks_json,usage_json,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (sid, seq, type_, d.jdumps(blocks), d.jdumps(usage or {}), dbm.now_ms()))
    except Exception as e:
        # 会话被删了（编排还在跑）：抛 SessionGone 让上游安静收尾，别刷一屏 traceback
        if not events.session_alive(sid):
            raise events.SessionGone(f"会话 {sid} 已经被删掉，这一条不再写入") from e
        raise
    d.execute("UPDATE chat_session SET updated_at=? WHERE id=?", (dbm.now_ms(), sid))
    if emit_event:
        events.emit(sid, "session_entry", {"type": "session_entry",
                                          "entry": _entry_payload(eid)})
    return eid


def create_session(profile_key: str, slug: str = "", title: str = "",
                   model_key: str = "") -> dict:
    d = dbm.db()
    n = dbm.now_ms()
    default_model = d.scalar("SELECT value_json FROM setting WHERE key='models.default'")
    # 按书存：这本书指定过模型就用它（用户要的"这本书用哪个模型，可以跟别的书不同"）
    book_model = d.scalar("SELECT value_json FROM setting WHERE key=?",
                          ("models.book:" + slug,)) if slug else None
    mk = (model_key or (book_model or "").strip('"')
          or (default_model.strip('"') if default_model else "") or "")
    sid = d.execute(
        "INSERT INTO chat_session(identity,slug,profile_key,title,summary,status,model_key,"
        "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, slug, profile_key or "leader.default",
         title or (profile_of(profile_key)["name"] + "会话"), "", "idle", mk, n, n))
    events.emit(sid, "session_state_changed",
                {"type": "session_state_changed", "state": _state(sid)})
    return session_snapshot(sid)


def _state(sid: int) -> dict:
    s = session_row(sid)
    model = {}
    if s["model_key"] and "/" in s["model_key"]:
        grp, mid = s["model_key"].split("/", 1)
        model = {"modelId": mid, "providerConfigId": grp}
    return {"summary": {"title": s["title"], "profileKey": s["profile_key"],
                        "status": s["status"], "currentProjectRoot": s["slug"]},
            "model": model,
            "activeInvocation": bool(s["status"] == "running")}


# ── 工具 ────────────────────────────────────────────────────────────────────
def _tool_list_files(slug: str, args: dict) -> dict:
    from ..store import walk
    prefix = str(args.get("prefix") or "")
    nodes = [n["path"] for n in walk(slug) if n["path"].startswith(prefix)]
    return {"files": nodes[:200], "count": len(nodes)}


def _tool_read_file(slug: str, args: dict) -> dict:
    from ..store import read_text
    p = str(args.get("path") or "")
    try:
        text = read_text(slug, p)
    except Exception as e:
        return {"error": f"读不了 {p}：{e}"}
    return {"path": p, "content": text[:20000], "truncated": len(text) > 20000}


def _tool_search_book(slug: str, args: dict) -> dict:
    from ..store import chapter_files, read_text
    kw = str(args.get("q") or "").strip()
    if not kw:
        return {"error": "缺少 q"}
    hits = []
    for ch in chapter_files(slug):
        try:
            text = read_text(slug, ch["path"])
        except Exception:
            continue
        i = text.find(kw)
        while i >= 0 and len(hits) < 20:
            hits.append({"path": ch["path"], "context": text[max(0, i - 40): i + len(kw) + 40]})
            i = text.find(kw, i + len(kw))
    return {"hits": hits}


def _tool_world_state(slug: str, args: dict) -> dict:
    from .world import state_of_entity
    return state_of_entity(slug, str(args.get("entity") or ""), args.get("at"))


def _tool_promise_list(slug: str, args: dict) -> dict:
    rows = dbm.db().query("SELECT name,kind,status,setup_scene,due_chapter,note FROM promise"
                          " WHERE slug=? ORDER BY status, name", (slug,))
    return {"promises": rows}


def _tool_write_file(slug: str, args: dict) -> dict:
    from ..store import read_text, write_text
    p = str(args.get("path") or "")
    content = args.get("content")
    if not p or content is None:
        return {"error": "缺少 path 或 content"}
    before = ""
    try:
        before = read_text(slug, p)
    except Exception:
        # 改写前读不到原文 → diff 当成以前是空的，比让这次改写失败好。
        pass
    # 预设里的「改动感知」（第 33 轮起真生效）：默认"要确认"——AI 改的进「改动」等用户收；
    # 选了"直接用"就当场算数（仍然留版本快照，随时能换回去）。
    try:
        from ..llm.prompts import preset_values
        _auto = str(preset_values(slug).get("fileChangeAwareness") or "on").strip() == "off"
        if os.environ.get("PRESET_LANDING_FORCE") == "ignore":
            _auto = False   # 反证钩子：假装这一项没人读（见 tools/preset_audit.py）
    except Exception:
        _auto = False   # 读不到预设就当"要确认"，宁可多一步确认，也不能悄悄改用户的稿子
    try:
        write_text(slug, p, str(content), origin="model",
                   note=str(args.get("note") or "AI 写稿"), pending=(not _auto))
    except Exception as e:
        return {"error": f"写不了 {p}：{e}"}
    from ..routers.books import sync_book
    try:
        sync_book(slug)
    except Exception:
        # 文件已经落盘了，索引重扫失败不该把它报成写失败。
        pass
    return {"ok": True, "path": p, "beforeChars": len(before), "afterChars": len(str(content)),
            # 说清"这次到底算不算数"：用户选了「直接用」时别再让 AI 告诉用户"等确认"
            # （那样用户去「改动」里找会找不到，反而以为丢了）。
            "note": ("已直接写入（预设里「改动感知」选了「直接用」；版本快照仍在，可换回）"
                     if _auto else "改动已进入「改动」列表，等用户确认")}


def _tool_report_result(slug: str, args: dict) -> dict:
    return {"result": str(args.get("result") or "")}



# ── 用户点名要"AI 真能用上工具"（第 31 轮）：下面这些是**把界面里已有的能力接到 AI 手上** ──
# 每一个都**复用界面同一份数据**（同一张表 / 同一个引擎函数），不另开数据源、不复制逻辑。
# 输出一律压小（只给前若干条 + 总数），别把整本书塞进上下文。


def _tool_chapter_list(slug: str, args: dict) -> dict:
    """章节表：哪几章、多少字、最近写到哪 —— AI 写长文前先看这个，省得它瞎猜进度。"""
    from ..store import chapter_files
    chs = chapter_files(slug)
    limit = int(args.get("limit") or 200)
    return {"count": len(chs),
            "chapters": [{"path": c["path"], "title": c.get("title") or "",
                          "words": c.get("words") or 0} for c in chs[-limit:]],
            "totalWords": sum(int(c.get("words") or 0) for c in chs)}


def _tool_lore_list(slug: str, args: dict) -> dict:
    """设定（世界引擎）：有哪些实体、都是哪一类 —— 跟「设定」面板同一张 entity 表。"""
    kind = str(args.get("kind") or "").strip()
    q = str(args.get("q") or "").strip()
    sql = "SELECT id,kind,name,first_seen_path,updated_at FROM entity WHERE slug=?"
    rows = dbm.db().query(sql, (slug,))
    out = [r for r in rows
           if (not kind or r["kind"] == kind) and (not q or q in (r["name"] or ""))]
    return {"count": len(out),
            "entities": [{"kind": r["kind"], "name": r["name"],
                          "firstSeen": r["first_seen_path"] or ""} for r in out[:200]]}


def _tool_lore_read(slug: str, args: dict) -> dict:
    """某个设定的**事实明细**（含"哪一刻改成什么样"）—— 写正文前查一眼，避免设定吃书。"""
    ent = str(args.get("entity") or "").strip()
    if not ent:
        return {"error": "缺少 entity"}
    state = _tool_world_state(slug, {"entity": ent, "at": args.get("at")})
    if state.get("error"):
        return state
    facts = dbm.db().query(
        "SELECT f.key, f.value, f.confidence, f.source_path FROM fact f"
        " JOIN entity e ON e.id=f.entity_id WHERE f.slug=? AND e.name LIKE ?"
        " ORDER BY f.key LIMIT 200", (slug, "%" + ent + "%"))
    state["facts"] = facts
    return state


def _tool_memory_search(slug: str, args: dict) -> dict:
    """记忆：这条书里"谁在什么时间知道什么"（同「记忆」面板的同一份数据）。"""
    from . import memory as mem
    q = str(args.get("q") or "").strip()
    if not q:
        return {"error": "缺少 q"}
    r = mem.search(slug, str(args.get("subject") or ""), q, int(args.get("limit") or 8))
    hits = r.get("candidates") or []
    return {"query": q, "count": len(hits),
            "hits": [{"subject": h["subject"], "topic": h["topic"],
                      "text": str(h["text"])[:300], "source": h.get("source") or ""} for h in hits]}


def _tool_lint_check(slug: str, args: dict) -> dict:
    """AI 味检查（中文质检）：跟「质检」面板同一个引擎、同一套规则。"""
    from . import lint as lintmod
    from ..store import read_text
    text = str(args.get("text") or "")
    path = str(args.get("path") or "")
    if not text and path:
        try:
            text = read_text(slug, path)
        except Exception as e:
            return {"error": f"读不了 {path}：{e}"}
    if not text:
        return {"error": "要么给 text，要么给 path"}
    r = lintmod.scan(text, path=path, limit=int(args.get("limit") or 40))
    return {"score": r.get("score"), "grade": r.get("grade"),
            "chars": r.get("chars"), "count": len(r.get("hits") or []),
            "hits": [{"rule": h.get("rule"), "line": h.get("line"),
                      "text": str(h.get("text") or "")[:80],
                      "why": str(h.get("why") or "")[:80]} for h in (r.get("hits") or [])[:40]]}


def _tool_consistency_check(slug: str, args: dict) -> dict:
    """一致性检查：称呼/外貌/年龄/能力前后是否打架（同「走查」那一套）。"""
    from . import consistency
    r = consistency.report(slug)
    issues = r.get("issues") or []
    return {"score": r.get("score"), "grade": r.get("grade"),
            "stats": r.get("stats") or {}, "count": len(issues),
            "issues": [{"key": i.get("key"), "who": i.get("who"),
                        "text": str(i.get("text") or "")[:160],
                        "advice": str(i.get("advice") or "")[:120],
                        "where": [{"path": w.get("path"), "line": w.get("line"),
                                   "quote": str(w.get("quote") or "")[:60]}
                                  for w in (i.get("where") or [])[:3]]}
                       for i in issues[:40]]}


def _tool_outline_read(slug: str, args: dict) -> dict:
    """大纲（剧情线 + 细纲）：这本书该往哪走、这一章要写什么。

    用户第 32 轮把「剧情线」的作用改成了**大纲**：防忘、防跑偏、防 OOC。
    `edited` 是"谁最后改的"（user / ai）—— 提示词里会写明**用户改的优先**。
    """
    d = dbm.db()
    th = d.query("SELECT id,name,kind,status,summary,origin,updated_at FROM thread"
                 " WHERE slug=? ORDER BY order_no, id", (slug,))
    ol = d.query("SELECT chapter_path,level,body,approved,updated_at FROM outline"
                 " WHERE slug=? ORDER BY chapter_path, level", (slug,))
    return {"threads": [{"name": r["name"], "kind": r["kind"], "status": r["status"],
                         "summary": (r["summary"] or "")[:400],
                         "edited": (r.get("origin") or "user")} for r in th],
            "outlines": [{"chapter": r["chapter_path"], "level": r["level"],
                          "body": (r["body"] or "")[:600], "approved": bool(r["approved"])}
                         for r in ol[:40]],
            "note": "用户手改过的条目（edited=user）优先，AI 不得自行覆盖；要改先说明理由"}


def _tool_outline_write(slug: str, args: dict) -> dict:
    """AI 改大纲（剧情线 / 细纲）。**只增不减、不覆盖用户手改的条目**：

    · 同名剧情线：用户手改过（origin=user）→ **不改**，回一条"这条是用户定的，我不动"；
    · 同名剧情线：AI 自己写过的 → 更新（并记 origin=ai）；
    · 没同名 → 新建（origin=ai）。
    这样用户改完的东西不会被 AI 下一轮"顺手写回去"（用户点名的"用户写的直接没用"）。
    """
    d = dbm.db()
    name = str(args.get("name") or "").strip()
    if not name:
        return {"error": "缺少 name（这条大纲叫什么）"}
    summary = str(args.get("summary") or "")[:2000]
    kind = str(args.get("kind") or "main")
    row = d.one("SELECT * FROM thread WHERE slug=? AND name=?", (slug, name))
    if row and (row["origin"] or "user") == "user":
        return {"ok": False, "blocked": True, "name": name,
                "why": "「%s」是用户自己定的，AI 不覆盖。要改请先跟用户确认。" % name,
                "current": (row["summary"] or "")[:400]}
    if row:
        d.execute("UPDATE thread SET summary=?, kind=?, updated_at=? WHERE id=?",
                  (summary or row["summary"], kind, __import__("time").time() * 1000, row["id"]))
        return {"ok": True, "name": name, "mode": "updated",
                "note": "改动已进入「改动」列表，等用户确认"}
    d.execute("INSERT INTO thread(slug,name,kind,status,summary,order_no,origin,updated_at)"
              " VALUES(?,?,?,?,?,?,?,?)",
              # status 用界面那一套（open/done/paused）—— 以前写的是 "active"，
              # 那是 decision 表的值，界面上会原样显示成「active」（用户看不懂）。
              (slug, name, kind, "open", summary, 99, "ai", __import__("time").time() * 1000))
    return {"ok": True, "name": name, "mode": "created"}


def _tool_notes_read(slug: str, args: dict) -> dict:
    """笔记（用户自己的想法摘录） —— 跟「笔记」面板同一张表。"""
    rows = dbm.db().query("SELECT path,percent,quote,text FROM note WHERE slug=?"
                          " ORDER BY updated_at DESC LIMIT 100", (slug,))
    return {"count": len(rows),
            "notes": [{"path": r["path"], "quote": str(r["quote"] or "")[:120],
                       "text": str(r["text"] or "")[:300]} for r in rows]}


def _tool_term_list(slug: str, args: dict) -> dict:
    """术语表（专有名词怎么写）—— 防错别字/前后写法不一。"""
    rows = dbm.db().query("SELECT name,aliases_json,kind,note FROM term WHERE slug=?"
                          " ORDER BY name LIMIT 300", (slug,))
    return {"count": len(rows),
            "terms": [{"name": r["name"], "kind": r["kind"], "note": str(r["note"] or "")[:120],
                       "aliases": dbm.db().jloads(r["aliases_json"], [])} for r in rows]}


def _tool_material_list(slug: str, args: dict) -> dict:
    """素材（收集来的句子/桥段/设定碎片），可带关键词筛。"""
    q = str(args.get("q") or "").strip()
    rows = dbm.db().query("SELECT kind,title,body,tags_json FROM material WHERE slug=?"
                          " ORDER BY updated_at DESC LIMIT 200", (slug,))
    out = []
    for r in rows:
        blob = (r["title"] or "") + " " + (r["body"] or "")
        if q and q not in blob:
            continue
        out.append({"kind": r["kind"], "title": r["title"] or "",
                    "text": str(r["body"] or "")[:300],
                    "tags": dbm.db().jloads(r["tags_json"], [])})
    return {"count": len(out), "materials": out[:80]}


def _tool_reference_list(slug: str, args: dict) -> dict:
    """参考资料（参考书架：同人/写作时借鉴的样本）。**只列目录，不整篇灌进上下文。**"""
    rows = dbm.db().query("SELECT title,author,source,kind,words FROM reference WHERE slug=?"
                          " ORDER BY created_at DESC LIMIT 200", (slug,))
    return {"count": len(rows),
            "references": [{"title": r["title"], "author": r["author"] or "",
                            "source": r["source"] or "", "kind": r["kind"] or "",
                            "words": r["words"] or 0} for r in rows]}


def _tool_reference_read(slug: str, args: dict) -> dict:
    """读一条参考资料的一截（按关键词给上下文片段，别把整本参考书读进来）。"""
    title = str(args.get("title") or "").strip()
    q = str(args.get("q") or "").strip()
    if not title and not q:
        return {"error": "要么给 title，要么给 q"}
    rows = dbm.db().query("SELECT title,text FROM reference WHERE slug=?"
                          " AND (title LIKE ? OR source LIKE ?)",
                          (slug, "%" + (title or q) + "%", "%" + (title or q) + "%"))
    if not rows:
        return {"error": "没有这条参考资料（先用 reference_list 看看有哪些）"}
    r = rows[0]
    text = r["text"] or ""
    if q:
        i = text.find(q)
        if i >= 0:
            return {"title": r["title"], "hit": q,
                    "excerpt": text[max(0, i - 300): i + 900]}
    return {"title": r["title"], "excerpt": text[:1200], "truncated": len(text) > 1200}


def _tool_pacing_check(slug: str, args: dict) -> dict:
    """节奏体检：哪几章一直在铺垫/一直在大场面（防"写着写着没起伏"）。"""
    from . import pacing
    cv = pacing.curve(slug, limit=int(args.get("limit") or 0))
    points = cv.get("points") or []
    al = pacing.alerts(points)
    return {"chapters": len(points), "alerts": al[:20], "summary": pacing.summary(points)}



def _tool_web_search(slug: str, args: dict) -> dict:
    """联网搜索（用户第 31 轮要的"所有 AI 都能开联网搜索"）。

    **没开开关就直接回原因、一个请求都不发**（"绝不偷偷联网"）；开了才真去搜，
    而且只从可信站点里挑（名单见 `engine/websearch.py`，用户能在设置里自己加站）。
    """
    from . import websearch as web
    r = asyncio.run(web.search(str(args.get("q") or ""), int(args.get("n") or 5)))
    if not r.get("ok"):
        # 搜不到时**也要把原因带出去**（哪个引擎、什么错）—— 否则用户只看到"没搜到"，
        # 判据也没法说清是网络的问题还是过滤的问题（第 31 轮踩到过）。
        return {"error": r.get("error") or "没搜到", "engines": r.get("engines"),
                "engineErrors": r.get("errors"), "dropped": (r.get("dropped") or [])[:5]}
    return {"query": r["query"], "note": r["note"], "count": r["count"],
            "results": [{"title": x["title"], "url": x["url"], "source": x["source"],
                         "snippet": x["snippet"][:300]} for x in r["results"]],
            # 线索：通用搜索找到、但来源不在可信名单里的 → **只当线索，不采信**
            "leads": [{"title": x["title"], "url": x["url"], "host": x["host"],
                       "snippet": x["snippet"][:160]} for x in (r.get("leads") or [])],
            "dropped": (r.get("dropped") or [])[:5], "engines": r.get("engines")}


def _tool_web_fetch(slug: str, args: dict) -> dict:
    """抓一条网页正文（压成纯文本、截断 4000 字）—— 只抓可信站点。"""
    from . import websearch as web
    r = asyncio.run(web.fetch(str(args.get("url") or ""), str(args.get("q") or "")))
    if not r.get("ok"):
        return {"error": r.get("error") or "抓不到"}
    return {"url": r["url"], "source": r["source"], "chars": r["chars"],
            "excerpt": r["excerpt"], "truncated": r.get("truncated"),
            "note": "引用时请写清来源（%s）" % r["source"]}


TOOLS = {
    "list_files": _tool_list_files,
    "read_file": _tool_read_file,
    "search_book": _tool_search_book,
    "world_state": _tool_world_state,
    "promise_list": _tool_promise_list,
    "write_file": _tool_write_file,
    "report_result": _tool_report_result,
    # ↓ 第 31 轮接上来的（界面里本来就有，AI 之前够不着）
    "chapter_list": _tool_chapter_list,
    "lore_list": _tool_lore_list,
    "lore_read": _tool_lore_read,
    "memory_search": _tool_memory_search,
    "lint_check": _tool_lint_check,
    "consistency_check": _tool_consistency_check,
    "outline_read": _tool_outline_read,
    "outline_write": _tool_outline_write,
    "notes_read": _tool_notes_read,
    "term_list": _tool_term_list,
    "material_list": _tool_material_list,
    "reference_list": _tool_reference_list,
    "reference_read": _tool_reference_read,
    "pacing_check": _tool_pacing_check,
    # ↓ 联网搜索（用户第 31 轮）：默认关，开了才真发请求
    "web_search": _tool_web_search,
    "web_fetch": _tool_web_fetch,
}


WEB_TOOLS = ("web_search", "web_fetch")


def run_tool(slug: str, name: str, args: dict) -> dict:
    fn = TOOLS.get(name)
    if not fn:
        return {"error": f"没有这个工具：{name}"}
    if name in WEB_TOOLS:
        # 联网是**用户开关**说了算（第 31 轮）：这里再拦一道，
        # 不管提示词怎么写、哪个角色来调，"没开就一个请求都不发"都必须成立。
        from . import websearch as web
        if not web.enabled():
            return {"error": "联网搜索没开（设置里打开我才能上网）"}
    try:
        return fn(slug, args or {})
    except Exception as e:
        return {"error": f"{name} 出错：{e}"}


# ── 一次调用 ────────────────────────────────────────────────────────────────
def start_invocation(sid: int, text: str, *, model_key: str = "",
                     payload: dict | None = None) -> str:
    """起一次执行。

    payload 里带 `mode`（discuss / plan / execute）时走**多 Agent 编排**
    （见 engine/orchestra.py：leader/retriever/researcher/writer/critic 分工 + 交接）；
    不带就还是单 Agent + 工具的老路（一句话问答用不着整条流水线）。
    """
    inv = uuid.uuid4().hex
    ABORTS.discard(sid)
    task = asyncio.create_task(_run(sid, text, inv, model_key, payload or {}))
    RUNNING[sid] = task
    return inv


def abort(sid: int) -> bool:
    ABORTS.add(sid)
    t = RUNNING.get(sid)
    if t and not t.done():
        t.cancel()
    return True


def _history_messages(sid: int, limit: int = 24) -> list[dict]:
    rows = dbm.db().query("SELECT * FROM chat_entry WHERE session_id=? ORDER BY seq DESC LIMIT ?",
                          (sid, limit))
    out = []
    for r in reversed(rows):
        blocks = dbm.db().jloads(r["blocks_json"], [])
        if r["type"] == "user":
            txt = "\n".join(b.get("content", "") for b in blocks if b.get("type") == "text")
            out.append({"role": "user", "content": txt})
        elif r["type"] == "assistant":
            txt = "".join(str(b.get("content", "")) for b in blocks if b.get("type") == "text")
            out.append({"role": "assistant", "content": txt})
        elif r["type"] == "tool_result":
            out.append({"role": "user", "content": "工具结果：" + json.dumps(
                blocks, ensure_ascii=False)[:4000]})
    return out


def _split_tool_lines(text: str) -> tuple[str, list[tuple[str, dict]]]:
    """把助手文本里的 `[tool:x] {json}` 行摘出来。"""
    keep, calls = [], []
    for line in (text or "").splitlines():
        m = TOOL_LINE.match(line)
        if m:
            name = m.group(1)
            try:
                args = json.loads(m.group(2) or "{}")
            except Exception:
                args = {}
            calls.append((name, args if isinstance(args, dict) else {}))
        else:
            keep.append(line)
    return "\n".join(keep).strip(), calls


async def _run(sid: int, text: str, inv: str, model_key: str = "",
               payload: dict | None = None) -> None:
    d = dbm.db()
    sess = session_row(sid)
    slug = sess["slug"]
    profile_key = sess["profile_key"]
    mk = model_key or sess["model_key"] or ""
    mode = str((payload or {}).get("mode") or "")
    # 三种模式（讨论/计划/执行）走编排层：角色分解 + 交接 + 权限不同
    if mode:
        from . import orchestra
        if mode in orchestra.MODES:
            d.execute("UPDATE chat_session SET status='running' WHERE id=?", (sid,))
            events.emit(sid, "session_state_changed",
                        {"type": "session_state_changed", "state": _state(sid)},
                        invocation_id=inv)
            try:
                await orchestra.run(sid, text, inv, payload or {}, mk)
            finally:
                RUNNING.pop(sid, None)
                ABORTS.discard(sid)
                d.execute("UPDATE chat_session SET status='idle' WHERE id=?", (sid,))
                if not sess["title"] or sess["title"].endswith("会话"):
                    title = (text or "").strip().splitlines()[0][:18] or sess["title"]
                    d.execute("UPDATE chat_session SET title=? WHERE id=?", (title, sid))
                try:
                    events.emit(sid, "session_state_changed",
                                {"type": "session_state_changed", "state": _state(sid)},
                                invocation_id=inv)
                    events.emit(sid, "agent_end",
                                {"type": "agent_end", "status": "completed",
                                 "mode": mode}, invocation_id=inv)
                except Exception:
                    # 收尾事件发不出去（会话已经没了 / 前端断了）不该影响本次调用的返回。
                    pass
                events.trim(sid)
            return
    t0 = time.time()
    provider: dict = {}
    mid = ""
    stop_reason = "completed"
    usage_total = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    d.execute("UPDATE chat_session SET status='running' WHERE id=?", (sid,))
    events.emit(sid, "session_state_changed",
                {"type": "session_state_changed", "state": _state(sid)}, invocation_id=inv)
    try:
        append_entry(sid, "user", [{"type": "text", "content": text}])
        try:
            provider, mid = provider_of(mk)
        except LLMError as e:
            append_entry(sid, "system", [{"type": "text", "content": f"模型没配好：{e}"}])
            raise
        values = preset_values(slug)
        memory_hits = _memory_hits(slug, text)
        system = build_system(profile_key, slug, values, memory_hits=memory_hits)
        msgs = _history_messages(sid)
        allowed = set(profile_of(profile_key)["tools"])
        # 「这一轮 AI 用了什么」的账（用户要的"看得见"）：看了什么从**真拼出来的 system** 里读，
        # 调了什么/动了哪些文件边跑边补 —— 卡片上写的跟模型真拿到的必须是同一件事。
        ctx_digest = digest_system(system)
        ctx_called: list = []
        ctx_files: list = []

        def ctx_now() -> dict:
            return dict(ctx_digest, tools={"allowed": sorted(allowed),
                                           "called": list(ctx_called)},
                        files=list(ctx_files))

        for round_no in range(MAX_ROUNDS):
            if sid in ABORTS:
                stop_reason = "aborted"
                break
            msg_id = uuid.uuid4().hex
            events.emit(sid, "message_start", {"type": "message_start", "role": "assistant",
                                              "messageId": msg_id, "round": round_no},
                        invocation_id=inv)
            buf = []
            ttft = 0
            try:
                async for ev in stream_with_fallback(
                        provider, mid, msgs, system=system, temperature=0.85,
                        stream=(payload or {}).get("stream"), primary_key=mk):
                    if sid in ABORTS:
                        break
                    if ev["type"] == "delta":
                        if not ttft:
                            ttft = int((time.time() - t0) * 1000)
                        buf.append(ev["delta"])
                        events.emit(sid, "message_update", {
                            "type": "message_update", "messageId": msg_id,
                            "update": {"type": "text_delta", "delta": ev["delta"]}},
                            invocation_id=inv)
                    elif ev["type"] == "usage":
                        for k in usage_total:
                            usage_total[k] += int(ev["usage"].get(k) or 0)
                    elif ev["type"] == "notice":
                        append_entry(sid, "system", [{"type": "text", "content": ev["notice"]}])
                    elif ev["type"] == "error":
                        stop_reason = "error"
                        events.emit(sid, "message_update", {
                            "type": "message_update", "messageId": msg_id,
                            "update": {"type": "error", "message": ev["error"]}},
                            invocation_id=inv)
            except asyncio.CancelledError:
                stop_reason = "aborted"
                raise
            except Exception as e:
                stop_reason = "error"
                append_entry(sid, "system", [{"type": "text", "content": f"模型调用失败：{e}"}])
                break

            raw = "".join(buf)
            visible, calls = _split_tool_lines(raw)
            calls = [(n, a) for n, a in calls if n in allowed]
            blocks = []
            if visible:
                blocks.append({"type": "text", "content": visible})
            for n, a in calls:
                blocks.append({"type": "tool_call", "name": n, "args": a})
            if blocks or calls:
                append_entry(sid, "assistant", blocks,
                             usage={**usage_total, "model": mid, "context": ctx_now()})
            msgs.append({"role": "assistant", "content": visible or raw[:4000]})

            if not calls:
                break
            try:                      # 边跑边把账推给界面（用户能实时看见它在读什么、改什么）
                events.emit(sid, "turn_context", {"type": "turn_context", "context": ctx_now()},
                            invocation_id=inv)
            except Exception:
                pass
            for n, a in calls:
                events.emit(sid, "tool_execution_start",
                            {"type": "tool_execution_start", "toolCallId": uuid.uuid4().hex,
                             "toolName": n, "args": a}, invocation_id=inv)
                res = await asyncio.to_thread(run_tool, slug, n, a)
                events.emit(sid, "tool_execution_end",
                            {"type": "tool_execution_end", "toolName": n, "args": a,
                             "isError": "error" in res,
                             "result": {"content": [{"type": "text",
                                                     "text": json.dumps(res, ensure_ascii=False)[:6000]}]}},
                            invocation_id=inv)
                note_tool_call(ctx_called, ctx_files, n, a, res)
                append_entry(sid, "tool_result", [
                    {"type": "result", "name": n, "isError": "error" in res,
                     "content": [{"type": "text",
                                  "text": json.dumps(res, ensure_ascii=False)[:6000]}]}])
                msgs.append({"role": "user", "content":
                             f"[tool:{n}] 结果：{json.dumps(res, ensure_ascii=False)[:6000]}"})
        else:
            stop_reason = "max_rounds"
    except asyncio.CancelledError:
        stop_reason = "aborted"
    except Exception as e:
        stop_reason = "error"
        try:
            append_entry(sid, "system", [{"type": "text", "content": f"执行出错：{e}"}])
        except Exception:
            # 这是「尽量把出错原因写进会话」；写不进去时别把真正的异常盖掉。
            pass
    finally:
        RUNNING.pop(sid, None)
        ABORTS.discard(sid)
        d.execute("UPDATE chat_session SET status='idle' WHERE id=?", (sid,))
        total = usage_total["input"] + usage_total["output"]
        if not sess["title"] or sess["title"].endswith("会话"):
            title = (text or "").strip().splitlines()[0][:18] or sess["title"]
            d.execute("UPDATE chat_session SET title=? WHERE id=?", (title, sid))
        d.execute("INSERT INTO trace(session_id,invocation_id,slug,provider,model,kind,stop_reason,"
                  "input_tokens,output_tokens,cache_read,cache_write,ttft_ms,duration_ms,created_at)"
                  " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (str(sid), inv, slug, provider.get("id") if provider else "", mid,
                   "turn", stop_reason,
                   usage_total["input"], usage_total["output"], usage_total["cacheRead"],
                   usage_total["cacheWrite"], 0, int((time.time() - t0) * 1000), dbm.now_ms()))
        try:
            events.emit(sid, "session_state_changed",
                        {"type": "session_state_changed", "state": _state(sid)},
                        invocation_id=inv)
            events.emit(sid, "agent_end", {"type": "agent_end", "status": stop_reason},
                        invocation_id=inv)
        except Exception:
            # 同上：收尾事件是给界面看的，发失败不影响已经算完的结果。
            pass
        events.trim(sid)


def _memory_hits(slug: str, text: str, limit: int = 6) -> list[str]:
    """粗检索：把问题里出现的实体/词在记忆里找一找，命中就塞进上下文。"""
    if not slug or not text:
        return []
    d = dbm.db()
    rows = d.query("SELECT subject,topic,view_text FROM memory WHERE slug=? LIMIT 500", (slug,))
    hits = []
    for r in rows:
        blob = f"{r['subject']} {r['topic']}"
        if any(tok and tok in text for tok in (r["subject"], r["topic"])):
            hits.append(f"{r['subject']}／{r['topic']}：{r['view_text'][:120]}")
        if len(hits) >= limit:
            break
    return hits
