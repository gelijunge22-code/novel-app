# -*- coding: utf-8 -*-
"""模型渠道客户端。

支持两类 API（本机在用的两类）：
* `openai-completions` —— POST {base}/chat/completions
* `openai-responses`   —— POST {base}/responses

对外只暴露 `stream_chat()`：一个异步生成器，吐 `{"type": "delta"|"usage"|"reasoning"|"done"}`。
密钥只在这里被使用，**不打印、不返回给前端**。
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import AsyncIterator

import httpx

TIMEOUT = httpx.Timeout(600.0, connect=15.0, read=600.0)

# 首字看门狗：渠道**通了但不吐字**（排队卡住 / 中转挂了）时，绝不能让用户对着
# 「回复中…」干等 —— 这正是此处指出「AI 聊天输出之后出不了字」的体感。
# 第一个字之前给 FIRST_TOKEN_S（**只当安全网**：界面自己在 30 秒时就会写一句"还在等模型"，
# 让用户继续等；这里只兜底"再也不会回来了"的那种），出字之后每个字之间给 IDLE_TOKEN_S。
FIRST_TOKEN_S = float(os.environ.get("LLM_FIRST_TOKEN_S") or 300.0)
IDLE_TOKEN_S = float(os.environ.get("LLM_IDLE_TOKEN_S") or 120.0)


class LLMError(RuntimeError):
    pass


async def _sleep_a_bit() -> None:
    """换形状重试之间让一下，别让两次请求挤在一起（也方便日志看清先后）。"""
    await asyncio.sleep(0.05)


class LLMStall(LLMError):
    """渠道连上了，但规定时间内一个字都没吐 —— 跟"报错"是两回事，单独一类。"""


RESPONSES_SHAPES = ("openai-responses", "responses")


def _is_responses(api: str) -> bool:
    a = (api or "").lower()
    return a in RESPONSES_SHAPES


def other_shape(api: str) -> str:
    """另一种"流式形状"：声明 /responses 的换 /chat/completions，反之亦然。

    为什么要它（2026-09-21 实测，有日志）：
      · 本机中转（`某渠道-shim`，声明 `openai-responses`）的 `/responses` **流式只回一个
        `data: [DONE]`、正文一个字不给**，而**同一个中转的 `/chat/completions` 流式逐字吐得好好的**；
      · 老代码只按声明的形状试一次，零分片就退回**非流式** —— 字还是出得来，但**是一次蹦出来的**，
        用户在界面实测里看到的就是 `streamed:false`、字数 `0,0,…,4`（"没有流式"）。
    所以：**声明的形状一个分片都没给，就换另一种形状再流一次**，再不行才退回非流式。
    """
    return "openai-completions" if _is_responses(api) else "openai-responses"


def stream_shapes(api: str) -> list:
    """这一轮流式要按顺序试的形状。判据钩子：`LLM_NOSTREAM_RETRY=1` 只试声明的那一种
    （用来证明"换形状再流"这一步真的在干活 —— 关掉它，流式判据必须报红）。"""
    first = (api or "openai-completions").lower()
    if os.environ.get("LLM_NOSTREAM_RETRY") or os.environ.get("LLM_NOFALLBACK"):
        return [first]
    alt = other_shape(first)
    return [first] if alt == first else [first, alt]


def _headers(provider: dict) -> dict:
    key = provider.get("api_key") or ""
    h = {"content-type": "application/json"}
    if key:
        h["authorization"] = "Bearer " + key
    for k, v in (provider.get("options_json") and
                 json.loads(provider["options_json"]).get("headers") or {}).items():
        h[k] = str(v)
    return h


def _base(provider: dict) -> str:
    b = (provider.get("base_url") or "").strip().rstrip("/")
    if not b:
        raise LLMError("这个渠道还没配 base_url")
    return b


async def stream_chat(provider: dict, model_id: str, messages: list[dict], *,
                      temperature: float | None = None, max_tokens: int | None = None,
                      system: str | None = None,
                      stream: bool | None = None,
                      first_token_s: float | None = None,
                      idle_s: float | None = None) -> AsyncIterator[dict]:
    """流式对话。**保证不会"什么都不吐、也不报错"**（此处要求"出不了字"就是这么来的）。

    第 27 轮加的两道保险（原来是"零分片、零错误、静默结束"）：
      · 流式跑完一个 delta 都没有 → **自动回退非流式**（先按声明的 API，再试 chat/completions）；
      · 回退也拿不到正文 → 吐一条**说人话的错误**（带上渠道、状态码、响应头几行），
        界面就能把原因显示出来，而不是干等。
    """
    api = (provider.get("model_api") or "openai-completions").lower()
    base = _base(provider)
    diag: dict = {"api": api, "base": base, "status": 0, "ctype": "", "head": "", "events": 0,
                  "stream": stream}
    got_delta = False
    got_error = ""
    stalled = False
    # stream=False = 用户/设置明确要"一次性出整段"（非流式）：直接走非流式那条路，
    # 不再先试 SSE —— 这也是两条路**同一份解析**的原因（不是两套实现）。
    if os.environ.get("LLM_FORCE_STREAM"):        # 判据用的钩子：假装"没看见 stream=False"
        stream = None
    if stream is False:
        fb, fb_err = await _fallback_nonstream(provider, model_id, messages,
                                               temperature=temperature, max_tokens=max_tokens,
                                               system=system, diag=diag)
        if fb:
            yield {"type": "delta", "delta": fb}
            yield {"type": "done", "stopReason": "nonstream"}
            return
        yield {"type": "error", "error": "模型没有返回内容（非流式：" + (fb_err or "空响应") + "）"}
        return
    shapes = stream_shapes(api)
    for shape in shapes:
        shape_provider = provider if shape == api else dict(provider, model_api=shape)
        diag["shape"] = shape
        try:
            async for ev in _stream_once(shape_provider, model_id, messages, temperature=temperature,
                                         max_tokens=max_tokens, system=system, diag=diag,
                                         first_token_s=first_token_s, idle_s=idle_s):
                if ev["type"] == "delta":
                    got_delta = True
                elif ev["type"] == "error":
                    got_error = ev.get("error") or "模型返回了错误"
                yield ev
        except LLMStall as e:                   # 连得上但不吐字：**不白等回退**（一样会卡）
            stalled = True
            got_error = str(e)
        except LLMError as e:                   # 渠道级错误（4xx 正文里的话最有用）
            got_error = str(e)
        except httpx.TimeoutException:
            got_error = f"连模型超时（{base}，{TIMEOUT.read:g} 秒没回应）"
        except httpx.RequestError as e:
            got_error = f"连不上模型服务（{base}）：{type(e).__name__}"
        except Exception as e:                  # 别的意外也别让流断在半路
            got_error = f"调用模型出错了：{str(e)[:200]}"

        if got_delta or stalled:
            break
        # 这一种形状一个字都没吐（HTTP 也通）→ 换另一种形状再流一次
        if shape != shapes[-1]:
            diag["shape_retry"] = shape + "→" + shapes[shapes.index(shape) + 1]
            await _sleep_a_bit()
    if got_delta:
        diag["streamed"] = True
        if got_error:
            yield {"type": "error", "error": got_error}
        return

    if stalled:                                # 卡住：直接把原因说出来，别让用户继续等
        yield {"type": "error", "error": got_error}
        return

    # ── 流式一个字的正文都没有：先自动回退非流式 ───────────────────────────
    # 两个**只在判据里用**的开关（生产上永远不设）：
    #   LLM_NOFALLBACK=1 → 关掉"自动回退"，用来证明这条回退路子真的在干活（关了就红）；
    #   LLM_SILENT=1     → 连错误也不吐（老爷行为），用来证明"静默无输出"确实会被判红。
    if os.environ.get("LLM_NOFALLBACK"):
        if got_error:
            yield {"type": "error", "error": got_error}
            return
        if not os.environ.get("LLM_SILENT"):
            yield {"type": "error", "error": "模型没有返回内容（回退被 LLM_NOFALLBACK 关掉了）"}
        return
    fb, fb_err = await _fallback_nonstream(provider, model_id, messages,
                                           temperature=temperature, max_tokens=max_tokens,
                                           system=system, diag=diag)
    if fb:
        if stream is True:
            # 用户在图省事里明确点了"流式（逐字出）"，这个渠道两种形状都不给分片 ——
            # 字照样给，但**得说一声**为什么是整段蹦出来的（不说 = 用户以为又坏了）。
            yield {"type": "notice",
                   "notice": "这个渠道不给逐字的分片（%s 两种接口都试过了），这次整段给你" % base}
        yield {"type": "delta", "delta": fb}
        yield {"type": "done", "stopReason": "fallback-nonstream"}
        return

    if got_error:
        yield {"type": "error", "error": got_error}
        return
    # 到这儿说明：HTTP 通了、也没报错、就是一个字没有 —— 必须让用户看见原因
    inner = [str(base), str(diag.get("api") or "?")]
    if diag.get("status"):
        inner.append("HTTP %s" % diag["status"])
    if diag.get("ctype"):
        inner.append(str(diag["ctype"]).split(";")[0])
    inner.append("收到 %s 个数据块" % diag.get("events", 0))
    bits = ["模型没有返回内容（" + "，".join(inner) + "）"]
    tail = (diag.get("head") or "").strip().replace("\n", " ")
    if fb_err:
        bits.append("；回退非流式也不行：" + fb_err[:120])
    if tail:
        bits.append("；响应开头：" + tail[:160])
    yield {"type": "error", "error": "".join(bits)}


async def _stream_once(provider: dict, model_id: str, messages: list[dict], *,
                       temperature: float | None, max_tokens: int | None, system: str | None,
                       diag: dict, first_token_s: float | None = None,
                       idle_s: float | None = None) -> AsyncIterator[dict]:
    """真正发一次流式请求（原始实现，抽出来是为了让上面的"回退"能复用同一份解析）。"""
    api = (provider.get("model_api") or "openai-completions").lower()
    base = _base(provider)
    h = _headers(provider)
    if api.startswith("openai-responses") or api == "responses":
        url = base + "/responses"
        payload = {"model": model_id, "stream": True,
                   "input": [{"role": m["role"], "content": m["content"]} for m in messages]}
        if system:
            payload["instructions"] = system
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens:
            payload["max_output_tokens"] = max_tokens
    else:
        url = base + "/chat/completions"
        msgs = ([{"role": "system", "content": system}] if system else []) + messages
        payload = {"model": model_id, "stream": True, "messages": msgs}
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens:
            payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=TIMEOUT) as cli:
        async with cli.stream("POST", url, headers=h, json=payload) as r:
            diag["status"] = r.status_code
            diag["ctype"] = r.headers.get("content-type", "")
            if r.status_code >= 400:
                body = (await r.aread()).decode("utf-8", "replace")[:300]
                diag["head"] = body
                raise LLMError(f"模型返回 {r.status_code}：{body}")
            buf = ""
            raw_head = ""
            ait = r.aiter_text()
            # 绝对截止时刻：**第一个字之前**是 FIRST_TOKEN_S，**出字之后**每次收到字
            # 就续到 IDLE_TOKEN_S —— 于是"一直不吐字"最多等 FIRST_TOKEN_S 就被中止，
            # 而不是像老代码那样按 httpx 的 read=600 秒干等十分钟。
            first_s = FIRST_TOKEN_S if first_token_s is None else float(first_token_s)
            idle_s_v = IDLE_TOKEN_S if idle_s is None else float(idle_s)
            deadline = time.monotonic() + first_s
            while True:
                try:
                    chunk = await asyncio.wait_for(ait.__anext__(),
                                                   timeout=max(0.5, deadline - time.monotonic()))
                except StopAsyncIteration:
                    break
                except (asyncio.TimeoutError, TimeoutError):
                    raise LLMStall(
                        "模型 %d 秒没有第一个字（渠道 %s 连得上但不吐字：排队卡住／中转挂了／"
                        "这个模型不可用），已经替你中止" % (int(first_s), base))
                if len(raw_head) < 220:
                    raw_head += chunk[:220 - len(raw_head)]
                buf += chunk
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line or line.startswith(":") or line.startswith("event:"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        yield {"type": "done"}
                        return
                    try:
                        obj = json.loads(data)
                    except Exception:
                        continue
                    diag["events"] = diag.get("events", 0) + 1
                    for ev in _extract(obj, api):
                        # "有动静"就算在干活：正文或思考流都算（有些模型先吐一大段思考，
                        # 正文要等几十秒 —— 那也是**看得见的进度**，不能当中断处理）。
                        if ev.get("type") in ("delta", "reasoning"):
                            deadline = time.monotonic() + idle_s_v
                        yield ev
            diag["head"] = raw_head
            # 有的渠道 stream=true 也回一个**整包 JSON**（不是 SSE）—— 这里兜住它
            txt, _usage = _text_of_json(_maybe_json(raw_head + buf), api)
            if txt:
                diag["events"] = diag.get("events", 0) + 1
                yield {"type": "delta", "delta": txt}


def _maybe_json(s: str):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except Exception:
        return None


def _text_of_json(obj, api: str = "") -> tuple[str, dict]:
    """从**非流式**响应里把正文抠出来（completions 与 responses 两种形状都认）。"""
    if not isinstance(obj, dict):
        return "", {}
    usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
    if isinstance(obj.get("output_text"), str) and obj["output_text"].strip():
        return obj["output_text"], usage
    if isinstance(obj.get("response"), dict):        # response.completed 包了一层
        t, u = _text_of_json(obj["response"], api)
        return t, (u or usage)
    parts = []
    for out in (obj.get("output") or []):
        for c in ((out or {}).get("content") or []):
            t = (c or {}).get("text")
            if isinstance(t, str) and t:
                parts.append(t)
    if parts:
        return "".join(parts), usage
    for ch in (obj.get("choices") or []):
        m = (ch or {}).get("message") or {}
        if isinstance(m.get("content"), str) and m["content"]:
            return m["content"], usage
        d = (ch or {}).get("delta") or {}
        if isinstance(d.get("content"), str) and d["content"]:
            return d["content"], usage
    return "", usage


async def _fallback_nonstream(provider: dict, model_id: str, messages: list[dict], *,
                              temperature: float | None, max_tokens: int | None,
                              system: str | None, diag: dict) -> tuple[str, str]:
    """流式没出字时的兜底：按顺序试「声明的 API（非流式）」→「chat/completions（非流式）」。

    返回 (正文, 错误说明)。两条都失败时正文是空串、错误说明里带上最有用的一句话。
    """
    api = (provider.get("model_api") or "openai-completions").lower()
    tries = ["responses" if (api.startswith("openai-responses") or api == "responses")
             else "completions", "completions"]
    seen, err = [], ""
    for kind in tries:
        if kind in seen:
            continue
        seen.append(kind)
        try:
            txt = await _post_nonstream(provider, model_id, messages, kind=kind,
                                        temperature=temperature, max_tokens=max_tokens,
                                        system=system, diag=diag)
            if txt.strip():
                return txt, ""
            err = err or f"{kind} 也没正文"
        except Exception as e:
            err = f"{kind}: {str(e)[:140]}"
    return "", err


async def _post_nonstream(provider: dict, model_id: str, messages: list[dict], *, kind: str,
                          temperature: float | None, max_tokens: int | None, system: str | None,
                          diag: dict) -> str:
    base = _base(provider)
    h = _headers(provider)
    if kind == "responses":
        url = base + "/responses"
        payload = {"model": model_id, "stream": False,
                   "input": [{"role": m["role"], "content": m["content"]} for m in messages]}
        if system:
            payload["instructions"] = system
        if max_tokens:
            payload["max_output_tokens"] = max_tokens
    else:
        url = base + "/chat/completions"
        msgs = ([{"role": "system", "content": system}] if system else []) + messages
        payload = {"model": model_id, "stream": False, "messages": msgs}
        if max_tokens:
            payload["max_tokens"] = max_tokens
    if temperature is not None:
        payload["temperature"] = temperature
    async with httpx.AsyncClient(timeout=TIMEOUT) as cli:
        r = await cli.post(url, headers=h, json=payload)
        body = r.text
        diag["fallback_%s_status" % kind] = r.status_code
        if r.status_code >= 400:
            diag["head"] = diag.get("head") or body[:220]
            raise LLMError(f"HTTP {r.status_code}：{body[:200]}")
        txt, _u = _text_of_json(_maybe_json(body), kind)
        if not txt:
            diag["head"] = diag.get("head") or body[:220]
        return txt


def _extract(obj: dict, api: str):
    """把不同 API 的增量统一成 {type: delta|reasoning|usage|done}。"""
    out = []
    if "usage" in obj and isinstance(obj["usage"], dict):
        u = obj["usage"]
        out.append({"type": "usage", "usage": {
            "input": u.get("prompt_tokens") or u.get("input_tokens") or 0,
            "output": u.get("completion_tokens") or u.get("output_tokens") or 0,
            "cacheRead": (u.get("prompt_tokens_details") or {}).get("cached_tokens")
            or u.get("cache_read_input_tokens") or 0,
            "cacheWrite": u.get("cache_creation_input_tokens") or 0}})
    if api.startswith("openai-responses") or api == "responses":
        t = obj.get("type")
        if t == "response.output_text.delta" and obj.get("delta"):
            out.append({"type": "delta", "delta": obj["delta"]})
        elif t == "response.reasoning_summary_text.delta" and obj.get("delta"):
            out.append({"type": "reasoning", "delta": obj["delta"]})
        elif t == "response.completed":
            out.append({"type": "done"})
        elif t == "response.failed":
            out.append({"type": "error", "error": json.dumps(obj.get("response", {}).get("error") or obj)[:200]})
        return out
    for ch in (obj.get("choices") or []):
        d = ch.get("delta") or {}
        if d.get("content"):
            out.append({"type": "delta", "delta": d["content"]})
        if d.get("reasoning_content"):
            out.append({"type": "reasoning", "delta": d["reasoning_content"]})
        if ch.get("finish_reason"):
            out.append({"type": "done", "stopReason": ch["finish_reason"]})
    if obj.get("error"):
        out.append({"type": "error", "error": json.dumps(obj["error"], ensure_ascii=False)[:200]})
    return out


def fallback_model_key(primary_key: str) -> str:
    """备用模型（`models.fallback`）。跟主模型一样就不算备用。"""
    try:
        from .. import db as dbm
        v = dbm.db().scalar("SELECT value_json FROM setting WHERE key='models.fallback'")
        key = (v or "").strip('"')
        return key if key and key != primary_key else ""
    except Exception:
        return ""


async def stream_with_fallback(provider: dict, model_id: str, messages: list[dict], *,
                              primary_key: str = "", temperature: float | None = None,
                              max_tokens: int | None = None, system: str | None = None,
                              stream: bool | None = None) -> AsyncIterator[dict]:
    """先走主模型；**这一轮一个字都没出**（挂了/空响应）就自动换备用模型再来一次。

    为什么要它：用户要"能选默认 / 备用模型（主模型挂了自动换）"。挂掉的那种情形
    第 27 轮已经复现过 —— 渠道只回 `data: [DONE]`、正文一个字没有。
    这里只在"一个字都没出"时才换人，**已经出了字就不动**（不许把用户的半截回复弄丢）。
    """
    spoke = False
    err = ""
    async for ev in stream_chat(provider, model_id, messages, temperature=temperature,
                                max_tokens=max_tokens, system=system, stream=stream):
        if ev["type"] == "delta":
            spoke = True
        elif ev["type"] == "error":
            err = ev.get("error") or ""
        yield ev
    if spoke:
        return
    key = fallback_model_key(primary_key)
    if not key:
        return
    try:
        fb_provider, fb_mid = provider_of(key)
    except LLMError:
        return
    # 这一条是给界面看的：让用户知道"刚刚换了个人来答"，而不是莫名其妙换了口风
    yield {"type": "notice", "notice": "主模型这一轮没出内容（%s），已自动换备用模型 %s 再试"
           % ((err or "没有说明")[:60], key)}
    async for ev in stream_chat(fb_provider, fb_mid, messages, temperature=temperature,
                                max_tokens=max_tokens, system=system, stream=stream):
        yield ev


async def complete(provider: dict, model_id: str, messages: list[dict], *,
                   system: str | None = None, temperature: float | None = None,
                   max_tokens: int | None = None) -> str:
    """非流式（短任务用，例如生成标题、摘要、质检）。"""
    text = []
    async for ev in stream_chat(provider, model_id, messages, temperature=temperature,
                                max_tokens=max_tokens, system=system):
        if ev["type"] == "delta":
            text.append(ev["delta"])
        elif ev["type"] == "error":
            raise LLMError(ev["error"])
    return "".join(text)


def provider_of(model_key: str) -> tuple[dict, str]:
    """`group/model` → (provider 行, 模型 id)。"""
    from .. import db as dbm
    if not model_key or "/" not in model_key:
        raise LLMError("没选模型")
    grp, mid = model_key.split("/", 1)
    rows = dbm.db().query("SELECT * FROM provider WHERE enabled=1 ORDER BY sort, id")
    for r in rows:
        if grp in (r["grp"], r["name"]) and dbm.db().one(
                "SELECT id FROM provider_model WHERE provider_id=? AND model_id=? AND enabled=1",
                (r["id"], mid)):
            return r, mid
    for r in rows:                                # 退一步：只要模型存在就用
        if dbm.db().one("SELECT id FROM provider_model WHERE provider_id=? AND model_id=? AND enabled=1",
                        (r["id"], mid)):
            return r, mid
    raise LLMError(f"没有这个模型：{model_key}")
