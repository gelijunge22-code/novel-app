# -*- coding: utf-8 -*-
"""记忆库：AI「记得这本书发生过什么」。

两种来源，都写进同一套表：
* **有模型时**：把正文分块发给模型，让它抽 [主体, 属性, 取值] 与事件 —— 这是真正的语义记忆；
* **没模型时**：从世界引擎已登记的实体与事实里生成本地记忆（不编造，只是换一种视角）。
对外接口（inspector / subject / search / forget）与旧平台一致，前端一行不用改。
"""
from __future__ import annotations

import json
import re

from .. import db as dbm
from ..store import chapter_files, now_ms, read_text

EXTRACT_PROMPT = """你在读一部中文长篇小说的正文，请抽取"读者需要记住的事实"。

只输出 JSON，不要任何解释，格式：
{"memories":[{"subject":"人物或势力或地点的名字","topic":"属性名（如 身份/武器/关系/目标）",
"view":"一句话说清这个属性现在是什么","aliases":["别名1"]}],
 "events":[{"subject":"谁","text":"发生了什么（一句话，含结果）","tick":"第几章或时间词"}]}

要求：
- 只写正文里**确实写到**的内容，不要推测、不要补充常识。
- subject 用正文里的正式称呼；别名放在 aliases。
- 每条 view 不超过 40 字。最多 20 条 memories、20 条 events。"""


async def rebuild(slug: str, *, model_key: str = "", progress=None) -> dict:
    """重建整本书的记忆。"""
    d = dbm.db()
    chapters = chapter_files(slug)
    d.execute("DELETE FROM memory WHERE slug=?", (slug,))
    d.execute("DELETE FROM memory_event WHERE slug=?", (slug,))
    d.execute("DELETE FROM rag_index WHERE slug=?", (slug,))
    n_mem = n_ev = 0
    source = "world-engine"
    key = model_key or (d.scalar("SELECT value_json FROM setting WHERE key='models.default'") or "").strip('"')
    if key:
        try:
            from ..llm.providers import complete, provider_of
            provider, mid = provider_of(key)
            for i, ch in enumerate(chapters):
                if progress:
                    progress(i, len(chapters))
                try:
                    text = read_text(slug, ch["path"])[:6000]
                except Exception:
                    continue
                try:
                    raw = await complete(provider, mid, [{"role": "user",
                                                          "content": EXTRACT_PROMPT + "\n\n【正文】\n" + text}],
                                         temperature=0.2, max_tokens=2000)
                    data = _json_of(raw)
                except Exception:
                    continue
                if not data:
                    continue
                for m in (data.get("memories") or [])[:20]:
                    _put_memory(slug, m.get("subject") or "", m.get("topic") or "",
                                m.get("view") or "", m.get("aliases") or [], ch["path"])
                    n_mem += 1
                for e in (data.get("events") or [])[:20]:
                    _put_event(slug, e.get("subject") or "", e.get("text") or "",
                               e.get("tick") or "", ch["name"], ch["path"])
                    n_ev += 1
            source = "model"
        except Exception:
            source = "world-engine"
    # 结构化的事实（世界引擎里的实体/事实/时间线）**无论如何都要进记忆**。
    # 以前只在"模型一条都没抽出来"时才走这条路：模型只要挤出哪怕一条，
    # 用户手填的设定就整批从记忆里消失 —— 设定页里写着"沉默"，写正文时却查不到。
    n0, e0 = _from_world_engine(slug)
    n_mem += n0
    n_ev += e0
    _index(slug)
    return {"ok": True, "slug": slug, "memories": n_mem, "events": n_ev,
            "chapters": len(chapters), "source": source,
            "structured": {"memories": n0, "events": e0}, "at": now_ms()}


def _json_of(raw: str) -> dict:
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except Exception:
        return {}


def _put_memory(slug: str, subject: str, topic: str, view: str, aliases, source: str) -> None:
    subject = (subject or "").strip()
    topic = (topic or "").strip()
    if not subject or not topic:
        return
    d = dbm.db()
    d.execute(
        "INSERT INTO memory(slug,subject,topic,view_text,aliases_json,source_path,created_at)"
        " VALUES(?,?,?,?,?,?,?) ON CONFLICT(slug,subject,topic) DO UPDATE SET"
        " view_text=excluded.view_text, aliases_json=excluded.aliases_json,"
        " source_path=excluded.source_path, created_at=excluded.created_at",
        (slug, subject, topic, view[:200], json.dumps(list(aliases)[:6], ensure_ascii=False),
         source, now_ms()))


def _put_event(slug: str, subject: str, text: str, tick: str, time_text: str, source: str) -> None:
    if not subject or not text:
        return
    dbm.db().execute(
        "INSERT INTO memory_event(slug,subject,text,tick,time_text,source_path,created_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (slug, subject.strip(), text[:200], tick, time_text, source, now_ms()))


def _from_world_engine(slug: str) -> tuple[int, int]:
    """没有模型时：把世界引擎里已登记的实体/事实/事件搬成记忆。"""
    from .world import entity_list, facts_of, list_moments
    d = dbm.db()
    n_mem = n_ev = 0
    for e in entity_list(slug):
        for k in ("身份", "目标", "阵营", "能力", "外貌", "性格", "所在地"):
            if e["data"].get(k):
                _put_memory(slug, e["name"], k, str(e["data"][k]), e["aliases"],
                            e["first_seen_path"] or "")
                n_mem += 1
        for f in facts_of(slug, e["id"]):
            _put_memory(slug, e["name"], f["key"], f["value"], [], f["source_path"] or "")
            n_mem += 1
    for m in list_moments(slug):
        for ep in d.query("SELECT * FROM episode WHERE slug=? AND moment_id=?", (slug, m["id"])):
            subj = (ep["title"] or ep["summary"] or "全书")[:20]
            _put_event(slug, subj, ep["summary"] or ep["title"], m["label"], m["time_text"],
                       ep["scene_path"] or "")
            n_ev += 1
    return n_mem, n_ev


def _index(slug: str) -> None:
    """重建检索索引（本地检索用；向量列留给后续接 embed 模型）。"""
    d = dbm.db()
    chapters = {c["path"]: c for c in chapter_files(slug)}
    for r in d.query("SELECT * FROM memory WHERE slug=?", (slug,)):
        blob = f"{r['subject']} {r['topic']} {r['view_text']}"
        d.execute(
            "INSERT INTO rag_index(slug,subject,source_path,search_text,content_hash,updated_at)"
            " VALUES(?,?,?,?,?,?) ON CONFLICT(slug,source_path,subject) DO UPDATE SET"
            " search_text=excluded.search_text, updated_at=excluded.updated_at",
            (slug, r["subject"], r["source_path"] or "", blob,
             str(abs(hash(blob)))[:12], now_ms()))


# ── 对外查询 ────────────────────────────────────────────────────────────────
def inspector(slug: str, limit: int = 200) -> dict:
    d = dbm.db()
    rows = d.query(
        "SELECT subject, COUNT(*) AS memoryCount, MAX(source_path) AS src FROM memory"
        " WHERE slug=? GROUP BY subject ORDER BY memoryCount DESC LIMIT ?", (slug, limit))
    subs = []
    for r in rows:
        subs.append({
            "subjectId": r["subject"], "subjectPath": r["subject"],
            "metadata": {"name": r["subject"], "kind": "character"},
            "memoryCount": r["memoryCount"],
            "eventCount": d.scalar("SELECT COUNT(*) FROM memory_event WHERE slug=? AND subject=?",
                                   (slug, r["subject"])) or 0,
        })
    other = d.query("SELECT subject, COUNT(*) c FROM memory_event WHERE slug=?"
                    " GROUP BY subject", (slug,))
    known = {s["subjectId"] for s in subs}
    for o in other:
        if o["subject"] not in known:
            subs.append({"subjectId": o["subject"], "subjectPath": o["subject"],
                         "metadata": {"name": o["subject"], "kind": "event"},
                         "memoryCount": 0, "eventCount": o["c"]})
    idx = d.one("SELECT COUNT(*) c, MAX(updated_at) at FROM rag_index WHERE slug=?", (slug,)) or {}
    return {"projectRoot": slug, "selectedSubjectPath": None,
            "sourceFilter": ["memory", "events"], "limit": limit,
            "embedding": {"enabled": False, "provider": "openai-compatible", "model": None,
                          "dimensions": None, "baseURLConfigured": False, "baseURLLabel": None,
                          "apiKeyConfigured": False},
            "index": {"dbExists": bool(idx.get("c")), "schemaVersion": 1,
                      "embeddingProvider": None, "embeddingModel": None,
                      "embeddingDimensions": None, "metaMatchesEffectiveConfig": True,
                      "readError": None, "sourceCount": idx.get("c") or 0,
                      "chunkCount": idx.get("c") or 0, "vectorCount": 0,
                      "updatedAt": idx.get("at")},
            "subjects": subs, "selectedSubject": None}


def subject_detail(slug: str, subject: str) -> dict:
    d = dbm.db()
    mems = []
    for m in d.query("SELECT * FROM memory WHERE slug=? AND subject=? ORDER BY topic", (slug, subject)):
        mems.append({"topic": m["topic"], "view": m["view_text"],
                     "aliases": d.jloads(m["aliases_json"], []),
                     "sourcePath": m["source_path"]})
    evs = [{"text": e["text"], "tick": e["tick"], "time": e["time_text"],
            "sourcePath": e["source_path"]}
           for e in d.query("SELECT * FROM memory_event WHERE slug=? AND subject=? ORDER BY id",
                            (slug, subject))]
    return {"subjectId": subject, "subjectPath": subject,
            "metadata": {"name": subject, "kind": "character"},
            "memories": mems, "events": evs}


def search(slug: str, subject: str, query: str, limit: int = 8) -> dict:
    """本地打分：词命中 + 主体匹配。够快够准，不依赖向量库。"""
    d = dbm.db()
    q = (query or "").strip()
    if not q:
        return {"candidates": []}
    rows = d.query("SELECT * FROM memory WHERE slug=?" + (" AND subject=?" if subject else ""),
                   (slug, subject) if subject else (slug,))
    scored = []
    for r in rows:
        text = f"{r['subject']} {r['topic']} {r['view_text']}"
        score = 0
        for ch in set(q):
            if ch.strip() and ch in text:
                score += 1
        if q in text:
            score += 6
        if subject and r["subject"] == subject:
            score += 2
        if score > 0:
            scored.append((score, r))
    scored.sort(key=lambda x: -x[0])
    out = []
    for i, (score, r) in enumerate(scored[:limit]):
        out.append({"rank": i + 1, "score": score, "subject": r["subject"],
                    "topic": r["topic"], "text": f"{r['topic']}：{r['view_text']}",
                    "source": r["source_path"]})
    return {"candidates": out, "query": q}


def forget(slug: str, subject: str, topic: str) -> dict:
    n = dbm.db().rowcount("DELETE FROM memory WHERE slug=? AND subject=? AND topic=?",
                          (slug, subject, topic))
    return {"ok": True, "removed": n}
