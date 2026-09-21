# -*- coding: utf-8 -*-
"""写作引擎：生成 / 续写 / 改写 / 细纲 / 润色 / 摘要 / 行内 AI。

约定（跟旧平台和后端其余部分一致）：
* 设定**自动注入**：写哪一章就把这一章的细纲、前情结尾、相关角色事实、
  未兑现的伏笔一起塞进系统提示（`llm/prompts.py` 负责拼）。
* 模型产出的文字要落盘时，`origin="model"` —— 它会进「改动」收件箱等用户点头，
  **不会**悄悄改掉用户的原稿（`store.write_text` 的规矩）。
* 流式：`stream=true` 时返回 SSE（`data: {...}`），字段与 agent 会话的 delta 一致。
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import StreamingResponse

from .. import db as dbm
from ..args import num
from ..llm import LLMError
from ..llm.prompts import DEFAULT_PROFILE, book_context, build_system, preset_values, profile_of
from ..llm.providers import provider_of, stream_chat
from ..security import current_user
from ..store import hanzi, now_ms, read_text, write_text

router = APIRouter(tags=["write"])

MODES = {
    "chapter": "把这一章的正文写出来。",
    "scene": "把这一段场景写出来。",
    "continue": "接着上文往下写。",
    "rewrite": "按下面的要求改这段文字。",
    "polish": "润色这段文字：删掉水词和解释句，把抽象换成具体的动作和感官，不改变原意。",
    "outline": "给这一章写细纲。",
    "summary": "给这一章写一段两句话的摘要。",
}


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _default_model(slug: str) -> str:
    d = dbm.db()
    row = d.one("SELECT value_json FROM setting WHERE key='models.default'")
    if row:
        v = d.jloads(row["value_json"], None)
        if isinstance(v, str) and v:
            return v
    r = d.one("SELECT * FROM book WHERE slug=?", (slug,))
    if r and r["settings_json"]:
        v = d.jloads(r["settings_json"], {}).get("modelKey")
        if v:
            return str(v)
    return ""


# 哪个用途用哪个模型：规划（细纲/大纲）用聪明的大模型，润色/改写用快的，杂活用最便宜的。
# 这张表同时被 /write/status 和 /model-sets/resolve 拿去解释「这次会落到哪个模型」。
PURPOSE_OF_MODE = {"chapter": "writer", "scene": "writer", "continue": "writer",
                   "outline": "planner", "summary": "fast",
                   "rewrite": "polish", "polish": "polish"}


def _preset_model(slug: str, pk: str = "") -> str:
    """预设（这本书 / 全局）里为这个档案选的模型。"""
    pk = pk or DEFAULT_PROFILE
    d = dbm.db()
    for scope, s in (("book", slug), ("global", "")):
        row = d.one("SELECT * FROM preset WHERE scope=? AND slug=? AND profile_key=?",
                    (scope, s, pk))
        if row:
            m = d.jloads(row["model_json"], {}).get("modelKey")
            if m:
                return str(m)
    return ""


def _purpose_model(slug: str, purpose: str) -> str:
    """启用中的「模型组」为这个用途指定的模型（没启用就返回空串）。"""
    try:
        from .model_sets import purpose_model
        return purpose_model(slug, purpose)
    except Exception:
        return ""


def _resolve_model(slug: str, payload: dict, mode: str = "") -> str:
    """优先级：本次点名 > 模型组（按用途）> 预设 > 全局默认。

    模型组只有**启用**了才参与（`/api/model-sets/activate`），所以不启用时行为跟以前一模一样。
    """
    mk = str(payload.get("modelKey") or "").strip()
    if mk:
        return mk
    purpose = PURPOSE_OF_MODE.get(str(mode or payload.get("mode") or ""), "writer")
    pm = _purpose_model(slug, purpose)
    if pm:
        return pm
    pm = _preset_model(slug, str(payload.get("profileKey") or ""))
    if pm:
        return pm
    return _default_model(slug)


def _tail(slug: str, path: str, chars: int = 1500) -> str:
    try:
        return read_text(slug, path)[-chars:]
    except Exception:
        return ""


def _chapter_outline(slug: str, path: str) -> str:
    rows = dbm.db().query(
        "SELECT body, level, approved FROM outline WHERE slug=? AND chapter_path=?"
        " ORDER BY approved DESC, id", (slug, path))
    if not rows:
        return ""
    return "\n".join(f"[{r['level']}] {r['body'][:800]}" for r in rows[:6])


def _neighbours(slug: str, path: str) -> tuple[str, str]:
    from ..store import chapter_files
    files = [c["path"] for c in chapter_files(slug)]
    if path not in files:
        return "", ""
    i = files.index(path)
    return (files[i - 1] if i > 0 else ""), (files[i + 1] if i + 1 < len(files) else "")


def _chapter_cast(slug: str, path: str) -> str:
    """这一章挂了哪些角色、要发生哪些事件 —— 用户亲手填的东西，写作时必须真喂进去。

    以前这张表只在前端显示了「出场 N 人」，写正文时一个字都没带 —— 等于白填。
    """
    row = dbm.db().one("SELECT cast_json, events_json FROM chapter_meta WHERE slug=? AND path=?",
                       (slug, path))
    if not row:
        return ""
    cast = dbm.Database.jloads(row["cast_json"], []) or []
    events = dbm.Database.jloads(row["events_json"], []) or []
    bits = []
    if cast:
        bits.append("出场角色（这一章必须写到的人）：" + "、".join(str(c) for c in cast))
    if events:
        bits.append("这一章要发生的事：\n" + "\n".join("- " + str(e) for e in events))
    return "\n".join(bits)


def _cast_facts(slug: str, path: str, limit: int = 4) -> str:
    """出场角色在世界引擎里的事实（性格、称呼、能力…），一并喂进去。"""
    row = dbm.db().one("SELECT cast_json FROM chapter_meta WHERE slug=? AND path=?",
                       (slug, path))
    if not row:
        return ""
    cast = dbm.Database.jloads(row["cast_json"], []) or []
    if not cast:
        return ""
    from ..engine import world as W
    lines = []
    for name in cast[:limit]:
        try:
            st = W.state_of_entity(slug, str(name))
        except Exception:
            continue
        kv = "；".join(f"{k}={v}" for k, v in list((st.get("state") or {}).items())[:6])
        if kv:
            lines.append(f"- {name}：{kv}")
    return "\n".join(lines)


def _cast_names(slug: str, path: str) -> list[str]:
    """这一章挂了谁（前端填的）；没填就退回"世界里有声音档案的人"。"""
    names: list[str] = []
    if path:
        row = dbm.db().one("SELECT cast_json FROM chapter_meta WHERE slug=? AND path=?",
                           (slug, path))
        if row:
            names = [str(x) for x in (dbm.Database.jloads(row["cast_json"], []) or []) if str(x).strip()]
    if names:
        return names
    try:
        from ..engine import voice as V
        return [p["name"] for p in V.all_profiles(slug) if p.get("voice")][:6]
    except Exception:
        return []


def _voice_bits(slug: str, path: str) -> str:
    """出场角色的说话方式 —— 「所有角色一个腔」是 AI 味里最典型的一种，
    但 568 条质检规则一条都管不到它（它们看不出"这句台词像不像这个人"）。
    这里把档案喂给写手，写对话时才有依据。"""
    try:
        from ..engine import voice as V
        return V.voice_brief(slug, _cast_names(slug, path))
    except Exception:
        return ""


def _memory_bits(slug: str, path: str, instruction: str, limit: int = 6) -> str:
    """记忆注入**写作链路**（以前只有对话页吃记忆，写正文时记忆等于不存在）。"""
    from ..engine.memory import search as mem_search
    from ..store import chapter_files
    seeds = []
    if path:
        try:
            row = dbm.db().one("SELECT cast_json FROM chapter_meta WHERE slug=? AND path=?",
                               (slug, path))
            seeds += dbm.Database.jloads(row["cast_json"], []) if row else []
        except Exception:
            # 读「这一章挂了谁」失败 = 这次少一个提示词种子，不该让整次生写作废。
            pass
        stem = path.rsplit("/", 1)[-1]
        seeds.append(stem.rsplit(".", 1)[0])
        try:
            files = [c["path"] for c in chapter_files(slug)]
            if path in files and files.index(path) > 0:
                seeds.append(files[files.index(path) - 1].rsplit("/", 1)[-1].rsplit(".", 1)[0])
        except Exception:
            # 同上：取上一章名字只是给 AI 一点上下文，取不到就少给一点。
            pass
    if instruction:
        seeds.append(instruction[:60])
    seen, lines = set(), []
    for subj in seeds:
        if not str(subj).strip():
            continue
        try:
            hits = mem_search(slug, "", str(subj)) or {}
        except Exception:
            continue
        for it in (hits.get("candidates") or [])[:3]:
            key = (it.get("subject"), it.get("topic"))
            if key in seen:
                continue
            seen.add(key)
            src = f"（来自 {it['source']}）" if it.get("source") else ""
            lines.append(f"- {it.get('subject')}／{it.get('topic')}："
                         f"{str(it.get('text') or '')[:160]}{src}")
            if len(lines) >= limit:
                return "\n".join(lines)
    return "\n".join(lines)


def build_prompt(slug: str, payload: dict) -> tuple[str, list[dict]]:
    """返回 (system, messages)。前端「看看到底喂了什么」也调它。"""
    mode = str(payload.get("mode") or "chapter")
    if mode not in MODES:
        raise HTTPException(400, f"不认识的模式：{mode}")
    path = str(payload.get("path") or "")
    profile_key = payload.get("profileKey") or ("inline.editor" if mode in ("rewrite", "polish")
                                                else "writer")
    values = preset_values(slug)
    # 写作链是一次成稿，不给它工具协议（要走工具的那条路是「对话」页的 Agent）
    system = build_system(profile_key, slug, values, with_tools=False)
    bits: list[str] = []
    if path:
        bits.append(f"【当前章节】{path}")
        out = _chapter_outline(slug, path)
        if out:
            bits.append("【这一章的细纲】\n" + out)
        cast_bits = _chapter_cast(slug, path)
        if cast_bits:
            bits.append("【这一章挂的角色与事件】\n" + cast_bits)
        cast_facts = _cast_facts(slug, path)
        if cast_facts:
            bits.append("【出场角色的既有设定（别写反）】\n" + cast_facts)
        voice_bits = _voice_bits(slug, path)
        if voice_bits:
            bits.append(voice_bits)
        prev, nxt = _neighbours(slug, path)
        if prev:
            bits.append(f"【上一章 {prev} 的结尾】\n" + _tail(slug, prev, 1200))
        if mode in ("continue", "rewrite", "polish"):
            bits.append("【这一章已写的内容】\n" + _tail(slug, path, 2500))
        if nxt:
            bits.append(f"【下一章是 {nxt}（别把下一章的内容提前写掉）】")
    else:
        bits.append("【全书现状】\n" + book_context(slug, tail_chars=800))
    if mode == "outline":
        bits.append("【要求】只输出细纲本身：分 6~12 条，每条一行，写清「谁、在哪、做了什么、"
                    "结果如何、留下什么钩子」。不要写成正文，不要解释。")
    elif mode == "summary":
        bits.append("【要求】只输出摘要本身，两句话以内，不要小标题。")
    target = payload.get("targetWords")
    if target and mode in ("chapter", "scene", "continue", "outline"):
        bits.append(f"【篇幅】大约 {int(target)} 字。")
    inst = str(payload.get("instruction") or payload.get("prompt") or "").strip()
    if inst:
        bits.append("【用户这次的要求】\n" + inst)
    mem = _memory_bits(slug, path, inst)
    if mem:
        bits.append("【相关记忆（写过的事，别自相矛盾）】\n" + mem)
    ref_ids = payload.get("refs") or []
    if ref_ids:
        rows = []
        try:
            ids = [int(x) for x in ref_ids if str(x).strip().isdigit()][:4]
            if ids:
                qs = ",".join("?" * len(ids))
                rows = dbm.db().query(
                    f"SELECT title,source,text,kind,file FROM reference WHERE slug=? AND id IN ({qs})",
                    (slug, *ids))
        except Exception:
            rows = []
        if rows:
            bits.append("【参考写法（你自己挑的范文：学它的手法与节奏，**不要抄句子**）】\n" +
                        "\n\n".join(_ref_bit(r) for r in rows))
    selection = str(payload.get("selection") or "").strip()
    if selection:
        bits.append("【需要处理的文字】\n" + selection)
    if mode in ("chapter", "scene", "continue"):
        bits.append("【输出】直接给正文，不要小标题、不要「好的」「以下是」，不要解释你的写法。")
    messages = [{"role": "user", "content": "\n\n".join(bits)}]
    return system, messages


def _record_trace(slug: str, mode: str, model: str, usage: dict, started: float,
                  stop: str, text: str) -> None:
    dbm.db().execute(
        "INSERT INTO trace(session_id,invocation_id,slug,provider,model,kind,stop_reason,"
        "input_tokens,output_tokens,cache_read,cache_write,ttft_ms,duration_ms,created_at)"
        " VALUES('',?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (mode, slug, "", model, "write." + mode, stop,
         int(usage.get("input") or 0), int(usage.get("output") or 0),
         int(usage.get("cacheRead") or 0), int(usage.get("cacheWrite") or 0),
         int(usage.get("ttft") or 0), int(usage.get("ms") or 0), now_ms()))


def _strip_echo(old: str, new: str) -> str:
    """模型续写时爱把上文抄一遍。把重复的开头削掉，只留真正新写的部分。"""
    new = new.strip()
    if not old or not new:
        return new
    cap = min(len(new), len(old), 1500)
    for n in range(cap, 19, -1):
        if old.endswith(new[:n]):
            return new[n:].lstrip()
    return new


def _strip_head(text: str) -> str:
    """去掉模型顺手加的 `# 标题` 行。"""
    lines = text.splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("#")):
        lines.pop(0)
    return "\n".join(lines).strip()


def _apply(slug: str, path: str, text: str, payload: dict, note: str) -> dict:
    if not payload.get("apply"):
        return {"applied": False}
    if not path:
        raise HTTPException(400, "要落盘就得给 path（哪一章）")
    if payload.get("mode") == "continue" or payload.get("append"):
        try:
            old = read_text(slug, path)
        except FileNotFoundError:
            old = ""
        text = _strip_echo(old, _strip_head(text))
        if not text:
            return {"applied": False, "hint": "模型没写出新内容"}
        sep = "" if (not old or old.endswith("\n")) else "\n\n"
        out = write_text(slug, path, old + sep + text, origin="model", note=note)
    else:
        out = write_text(slug, path, text, origin="model", note=note)
    from .books import sync_book
    sync_book(slug)
    return {"applied": True, "mtimeMs": out["mtimeMs"], "words": out["words"],
            "pending": True, "hint": "已写进「改动」收件箱，去那儿接受或退回"}


def _other_models(tried: list[str]) -> list[str]:
    """主模型挂了时，按「推荐顺序」挑下一个能用的（已经试过的排除掉）。"""
    try:
        from .books import model_options
        opts = model_options()
    except Exception:
        return []
    return [m["key"] for m in opts["models"] if m["key"] and m["key"] not in tried]


async def _run(slug: str, payload: dict, mode: str):
    """核心：调模型，边收边吐。

    一个关键容错：**一个字的正文都还没吐出来就挂了**（key 过期、渠道抽风、超时），
    就自动换下一个可用模型重试一次，并明确告诉用户「换过了」——
    以前这里是直接报错收场，用户只能自己摸去模型页换一个。
    """
    model_key = _resolve_model(slug, payload, mode)
    if not model_key:
        raise HTTPException(400, "还没配模型：去「工具 → 模型」里加一个，或在预设里选一个")
    system, messages = build_prompt(slug, {**payload, "mode": mode})
    allow_fallback = payload.get("allowFallback") is not False
    tried: list[str] = []
    while True:
        provider, mid = provider_of(model_key)
        tried.append(model_key)
        usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        buf: list[str] = []
        stop = "completed"
        err: str | None = None
        t0 = now_ms()
        try:
            async for ev in stream_chat(provider, mid, messages, system=system,
                                       temperature=num(payload.get("temperature"), 0.85,
                                                       kind=float, lo=0, hi=2, name="温度"),
                                       max_tokens=num(payload.get("maxTokens"), 0, lo=0,
                                                      name="最大 token") or None):
                if ev["type"] == "delta":
                    if not usage.get("ttft"):
                        usage["ttft"] = now_ms() - t0
                    buf.append(ev["delta"])
                    yield {"type": "delta", "delta": ev["delta"]}
                elif ev["type"] == "reasoning":
                    yield {"type": "reasoning", "delta": ev["delta"]}
                elif ev["type"] == "usage":
                    for k in usage:
                        usage[k] = usage.get(k, 0) + int(ev["usage"].get(k) or 0)
                    usage["ttft"] = usage.get("ttft") or 0
                elif ev["type"] == "error":
                    stop = "error"
                    err = str(ev["error"])
        except (HTTPException, LLMError) as e:
            # 渠道报错（key 过期、4xx…）也当成「这次失败」，能换就换
            stop = "error"
            err = e.detail if isinstance(e, HTTPException) else str(e)
        except Exception as e:                  # 兜底：不许把半截流甩给前端
            stop = "error"
            err = f"调用模型出错了：{str(e)[:200]}"
        if err:
            usage["ms"] = now_ms() - t0
            alts = _other_models(tried)[:1] if (allow_fallback and not buf) else []
            if alts:
                # 这一次失败也记一笔（统计页要能看出「哪个模型老挂」）
                _record_trace(slug, mode, model_key, usage, t0 / 1000.0, "error", "")
                yield {"type": "notice",
                       "notice": "%s 没连上（%s），已自动换 %s 重试" % (mid or model_key, err[:120], alts[0])}
                model_key = alts[0]
                continue
            yield {"type": "error", "error": err}
        usage["ms"] = now_ms() - t0
        text = "".join(buf).strip()
        if not usage.get("input") and not usage.get("output") and text:
            # 有些渠道不回 usage。用字面量估一个（标 estimated，不让统计页假装精确）
            prompt_chars = len(system) + sum(len(m["content"]) for m in messages)
            usage["input"] = int(prompt_chars / 1.6)
            usage["output"] = int(len(text) / 1.6)
            usage["estimated"] = True
        _record_trace(slug, mode, model_key, usage, t0 / 1000.0, stop, text)
        yield {"type": "done", "stopReason": stop, "text": text, "words": hanzi(text),
               "usage": usage, "model": model_key}
        return


async def _respond(slug: str, payload: dict, mode: str):
    note = str(payload.get("note") or ("AI " + {"chapter": "写正文", "continue": "续写",
                                                "rewrite": "改写", "polish": "润色",
                                                "outline": "写细纲", "summary": "写摘要",
                                                "scene": "写场景"}.get(mode, mode)))
    if payload.get("stream"):
        async def gen():
            text = ""
            try:
                async for ev in _run(slug, payload, mode):
                    if ev["type"] == "done":
                        text = ev["text"]
                        ev = {**ev, **_apply(slug, str(payload.get("path") or ""), text,
                                             payload, note)}
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
            except (HTTPException, LLMError) as e:
                msg = e.detail if isinstance(e, HTTPException) else str(e)
                yield "data: " + json.dumps({"type": "error", "error": msg},
                                            ensure_ascii=False) + "\n\n"
            except Exception as e:                       # 兜底：不留一个断掉的流
                yield "data: " + json.dumps({"type": "error", "error": f"出错了：{e}"[:300]},
                                            ensure_ascii=False) + "\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache",
                                          "x-accel-buffering": "no"})
    text = ""
    final: dict = {}
    try:
        async for ev in _run(slug, payload, mode):
            if ev["type"] == "delta":
                text += ev["delta"]
            elif ev["type"] == "done":
                final = ev
            elif ev["type"] == "error":
                raise HTTPException(502, ev["error"])
    except LLMError as e:
        raise HTTPException(502, str(e))
    out = {**final, **_apply(slug, str(payload.get("path") or ""), text, payload, note)}
    return out


def _ref_bit(r: dict) -> str:
    """一条参考进提示词长什么样。

    文字类：老样子（标题／来源 + 正文）。
    图片/文件类：**只有说明文字和文件名能进模型**（纯文本模型看不到图）——
    所以这里写成「【参考图】文件名」+ 用户写的那段说明，并在没写说明时明说"用户没写说明"，
    免得模型对着一个空标题自己编。
    """
    title = r["title"] or "参考"
    src = ("／" + r["source"]) if r.get("source") else ""
    kind = (r.get("kind") or "excerpt")
    text = (r["text"] or "").strip()
    if kind in ("image", "file"):
        fn = r.get("file") or ""
        what = "参考图" if kind == "image" else "参考文件"
        head = "—— 【%s】%s%s%s" % (what, title, ("（%s）" % fn) if fn else "", src)
        if not text:
            return head + "\n（用户放了这个文件但还没写说明；不要假装你看得到它，按标题理解即可。）"
        return head + "\n" + text[:1200]
    return "—— 《%s》%s\n%s" % (title, src, text[:1200])


@router.get("/write/context")
async def write_context(request: Request, slug: str, path: str = "", mode: str = "chapter"):
    """「这次会喂给它什么」—— 把注入的上下文摊开给用户看，不神秘。"""
    current_user(request)
    s = _slug(slug)
    system, messages = build_prompt(s, {"path": path, "mode": mode})
    return {"system": system, "messages": messages,
            "chars": len(system) + sum(len(m["content"]) for m in messages),
            "modelKey": _resolve_model(s, {}, mode),
            "purpose": PURPOSE_OF_MODE.get(mode, "writer"),
            "profile": profile_of("writer" if mode not in ("rewrite", "polish") else "inline.editor")}


@router.post("/write/preview")
async def write_preview(request: Request, payload: dict = Body(...)):
    """**不调模型**，把这次会喂进去的 system + messages 原样吐出来。

    用户挑的参考范文、出场角色的说话方式、记忆……到底进没进去，一眼可见。
    界面上「看看到底喂了什么」点一下就是它。
    """
    current_user(request)
    s = _slug(payload.get("slug") or "")
    system, messages = build_prompt(s, payload)
    text = "\n\n".join(str(m.get("content") or "") for m in messages)
    return {"system": system, "messages": messages, "chars": len(system) + len(text),
            "hasRefs": "参考写法" in text, "hasVoice": "说话方式" in text}


@router.get("/write/status")
async def write_status(request: Request, slug: str):
    """写作台开屏用：有没有模型、这本书写到哪了。"""
    current_user(request)
    s = _slug(slug)
    from ..store import chapter_files
    files = chapter_files(s)
    mk = _resolve_model(s, {})
    ok, why = True, ""
    if not mk:
        ok, why = False, "还没有选模型"
    else:
        try:
            provider_of(mk)
        except LLMError as e:
            ok, why = False, str(e)
    # 每种用途会落到哪个模型 —— 写作台开屏就写清楚，不让人猜
    from .model_sets import PURPOSE_KEYS
    purposes = {p: _resolve_model(s, {}, "outline" if p == "planner" else
                                 "polish" if p == "polish" else
                                 "summary" if p == "fast" else "chapter")
                for p in PURPOSE_KEYS}
    return {"modelKey": mk, "ready": ok, "why": why,
            "chapters": len(files), "words": sum(c["words"] for c in files),
            "lastChapter": files[-1]["path"] if files else "",
            "purposes": purposes, "modes": list(MODES.keys())}


@router.post("/write/generate")
async def write_generate(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    return await _respond(s, payload, str(payload.get("mode") or "chapter"))


@router.post("/write/continue")
async def write_continue(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    if not payload.get("path"):
        raise HTTPException(400, "续写得知道是哪一章")
    return await _respond(s, {**payload, "append": True}, "continue")


@router.post("/write/rewrite")
async def write_rewrite(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    if not (payload.get("selection") or payload.get("path")):
        raise HTTPException(400, "要改哪段？给 selection 或者 path")
    return await _respond(s, payload, "rewrite")


@router.post("/write/polish")
async def write_polish(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    return await _respond(s, payload, "polish")


@router.post("/write/inline")
async def write_inline(request: Request, payload: dict = Body(...)):
    """行内 AI：改一段选中的文字，只回文本，不落盘、不占主会话。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    return await _respond(s, {**payload, "apply": False},
                          str(payload.get("mode") or "rewrite"))


@router.post("/write/outline")
async def write_outline(request: Request, payload: dict = Body(...)):
    """生成细纲并直接存进大纲表（approved=0，等人点头）。

    注意：这两个「要落库」的接口必须拿到成稿文本，所以**只走非流式**——
    以前带上 stream 就会拿到一个 StreamingResponse，然后 `.get("text")` 直接炸
    （报的还是「服务器内部错误」，用户完全看不懂）。
    """
    current_user(request)
    s = _slug(payload.get("slug"))
    out = await _respond(s, {**payload, "apply": False, "stream": False}, "outline")
    path = str(payload.get("path") or "")
    if out.get("text") and payload.get("save", True):
        oid = dbm.db().execute(
            "INSERT INTO outline(slug,chapter_path,level,body,approved,updated_at)"
            " VALUES(?,?,?,?,0,?)", (s, path, "detail", out["text"], now_ms()))
        out["outlineId"] = oid
    return out


@router.post("/write/summary")
async def write_summary(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    out = await _respond(s, {**payload, "apply": False, "stream": False}, "summary")
    path = str(payload.get("path") or "")
    if out.get("text") and path:
        dbm.db().execute("UPDATE chapter SET summary=?, updated_at=? WHERE slug=? AND path=?",
                         (out["text"].strip(), now_ms(), s, path))
    return out


@router.get("/write/history")
async def write_history(request: Request, slug: str, path: str = "", limit: int = 40):
    """这一章被改过多少次、每次是谁改的（用户还是 AI）。"""
    current_user(request)
    s = _slug(slug)
    if path:
        rows = dbm.db().query(
            "SELECT id,path,rev,kind,actor_kind,status,created_at,"
            "LENGTH(before_text) AS before_len, LENGTH(after_text) AS after_len"
            " FROM revision WHERE slug=? AND path=? ORDER BY created_at DESC LIMIT ?",
            (s, path, limit))
    else:
        rows = dbm.db().query(
            "SELECT id,path,rev,kind,actor_kind,status,created_at,"
            "LENGTH(before_text) AS before_len, LENGTH(after_text) AS after_len"
            " FROM revision WHERE slug=? ORDER BY created_at DESC LIMIT ?", (s, limit))
    return {"items": rows}
