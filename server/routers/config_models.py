# -*- coding: utf-8 -*-
"""模型库与配置（工具页「模型」+ 预设页的后端表单）。

**密钥不出后端**：`config/snapshot` 里只回 `apiKeyConfigured: true/false`，
绝不把 key 发给前端（旧层把整串 key 回给浏览器，这是要改掉的）。
"""
from __future__ import annotations

import asyncio
import json
import re

import httpx
from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..config import CFG
from ..security import current_user
from ..store import now_ms


def _disp(m) -> str:
    """显示名带上渠道前缀（`[渠道]` `[次]` `[企]` 这种）。

    用户原话：「模型显示那里只显示它的具体名称，没有它的前缀，比如说渠道a、渠道b，
    有时候我不知道是哪个渠道的」。同一个模型在 渠道 渠道下按档位分成 渠道/B/E/F/G，
    库里 model_id 带前缀、name 不带，界面用 name —— 于是两个长得一样的名字其实是两个渠道，
    选错就 400 或"没有这个模型"。这里把前缀补回显示名，眼睛能分辨。
    """
    try:
        nm = str((m["name"] if m["name"] is not None else "") or "").strip() or str(m["model_id"] or "").strip()
        mid = str(m["model_id"] or "").strip()
        mm = re.match(r"(\[[^\]]{1,12}\])", mid)
        if mm and not nm.startswith(mm.group(1)):
            return mm.group(1) + nm
        return nm
    except Exception:
        return str(m["model_id"] or "")



router = APIRouter(tags=["config"])

# 可加供应商模板（我们自己的清单；baseUrl 是各家公开的 OpenAI 兼容地址）
TEMPLATES = [
    {"id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1",
     "defaultModelApi": "openai-responses", "models": []},
    {"id": "deepseek", "name": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1",
     "defaultModelApi": "openai-completions", "models": []},
    {"id": "moonshot", "name": "月之暗面 Kimi", "baseUrl": "https://api.moonshot.cn/v1",
     "defaultModelApi": "openai-completions", "models": []},
    {"id": "zhipu", "name": "智谱 GLM", "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
     "defaultModelApi": "openai-completions", "models": []},
    {"id": "dashscope", "name": "通义千问", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
     "defaultModelApi": "openai-completions", "models": []},
    {"id": "siliconflow", "name": "硅基流动", "baseUrl": "https://api.siliconflow.cn/v1",
     "defaultModelApi": "openai-completions", "models": []},
    {"id": "ollama", "name": "本机 Ollama", "baseUrl": "http://127.0.0.1:11434/v1",
     "defaultModelApi": "openai-completions", "models": []},
    {"id": "custom", "name": "自定义（OpenAI 兼容）", "baseUrl": "",
     "defaultModelApi": "openai-completions", "models": []},
]


def providers_doc(*, with_secrets: bool = False) -> dict:
    d = dbm.db()
    out = {}
    # 一次把模型全取回来按 provider 分组：以前每读一个 provider 就再查一次它的模型
    # （N+1，7 个 provider = 8 次查询）。这个接口 /config/snapshot 每次开设定页都调，
    # 手机上更不该白跑这么多次。
    by_provider: dict = {}
    for m in d.query("SELECT * FROM provider_model ORDER BY id"):
        by_provider.setdefault(m["provider_id"], []).append(m)
    for p in d.query("SELECT * FROM provider ORDER BY sort, id"):
        models = {}
        for m in by_provider.get(p["id"], []):
            models[m["model_id"]] = {
                "id": m["model_id"], "name": _disp(m),
                "group": m["grp"] or p["grp"], "enabled": bool(m["enabled"]),
                "reasoning": bool(m["reasoning"]),
                "contextWindowTokens": m["context_window"], "maxTokens": m["max_tokens"],
                "cost": d.jloads(m["cost_json"], {}),
            }
        opts = d.jloads(p["options_json"], {})
        opts["baseURL"] = p["base_url"]
        opts["apiKeyConfigured"] = bool(p["api_key"])
        if with_secrets:
            opts["apiKey"] = p["api_key"]
        out[p["grp"] or p["name"]] = {"id": p["id"],          # 删改时要靠它认人
                                      "name": p["name"], "enabled": bool(p["enabled"]),
                                      "modelApi": p["model_api"], "options": opts,
                                      "models": models}
    return out



@router.get("/config/models/library")
async def models_library(request: Request):
    current_user(request)
    d = dbm.db()
    by_provider: dict = {}
    for m in d.query("SELECT * FROM provider_model WHERE enabled=1 ORDER BY id"):
        by_provider.setdefault(m["provider_id"], []).append(m)
    out = []
    for p in d.query("SELECT * FROM provider WHERE enabled=1 ORDER BY sort, id"):
        for m in by_provider.get(p["id"], []):
            out.append({"id": m["model_id"], "name": _disp(m),
                        "source": p["name"], "reasoning": bool(m["reasoning"]),
                        "thinkingLevelMap": None, "input": ["text"],
                        "contextWindowTokens": m["context_window"], "maxTokens": m["max_tokens"]})
    return {"models": out}


@router.post("/config/models/model")
async def model_settings_save(request: Request, payload: dict = Body(default={})):
    """保存**单个模型**的参数 —— 模型列表每行右上角那个「⋯」面板。

    为什么要有：不同渠道的同一个模型能吃多长上下文、一次最多出多少、是不是推理模型
    都不一样（1M / 256K / 128K…）；还有些渠道要显式告诉它"开思考、给多少预算"，
    这些都得让用户自己填，不能让平台替他猜。

    字段：
      · contextWindowTokens —— 上下文上限（token）
      · maxTokens           —— 单次最多出多少
      · reasoning           —— 是不是推理模型（有些渠道要显式声明）
      · optionsJson         —— **高级参数**，一段 JSON，原样并进请求体
                               （例：{"thinking": {"type": "enabled", "budget_tokens": 8192}}）
                               按 (渠道, 模型) 分开存，互不干扰。
    """
    current_user(request)
    d = dbm.db()
    p = payload or {}
    source = str(p.get("source") or "").strip()
    mid = str(p.get("id") or "").strip()
    if not mid:
        raise HTTPException(400, "缺 model id")

    prov = None
    for row in d.query("SELECT * FROM provider ORDER BY sort, id"):
        if source and source in (row["name"] or "", row["grp"] or ""):
            prov = row
            break
    if prov is None:
        raise HTTPException(404, "找不到这个渠道")
    mrow = d.one("SELECT * FROM provider_model WHERE provider_id=? AND model_id=?",
                 (prov["id"], mid))
    if mrow is None:
        raise HTTPException(404, "找不到这个模型")

    def _num(v, fallback):
        try:
            return int(str(v).strip()) if str(v).strip() not in ("", "None") else fallback
        except Exception:
            return fallback

    cw = _num(p.get("contextWindowTokens"), mrow["context_window"])
    mt = _num(p.get("maxTokens"), mrow["max_tokens"])
    rs = mrow["reasoning"]
    if p.get("reasoning") is not None:
        rs = 1 if p.get("reasoning") else 0
    d.execute("UPDATE provider_model SET context_window=?, max_tokens=?, reasoning=?,"
              " updated_at=? WHERE id=?",
              (cw, mt, rs, now_ms(), mrow["id"]))

    opts = d.jloads(prov["options_json"], {}) or {}
    if not isinstance(opts, dict):
        opts = {}
    if "optionsJson" in p:
        raw = str(p.get("optionsJson") or "").strip()
        if raw:
            try:
                extra = json.loads(raw)
                if not isinstance(extra, dict):
                    raise ValueError("要是一个 JSON 对象，比如 {\"thinking\": {\"type\": \"enabled\"}}")
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(400, "高级参数不是合法 JSON：%s" % e)
        else:
            extra = {}
        bym = opts.get("modelParams")
        if not isinstance(bym, dict):
            bym = {}
        if extra:
            bym[mid] = extra
        else:
            bym.pop(mid, None)
        opts["modelParams"] = bym
        d.execute("UPDATE provider SET options_json=?, updated_at=? WHERE id=?",
                  (d.jdumps(opts), now_ms(), prov["id"]))
    return {"ok": True, "source": prov["name"], "id": mid,
            "contextWindowTokens": cw, "maxTokens": mt, "reasoning": bool(rs)}


@router.get("/config/models/provider-templates")
async def provider_templates(request: Request):
    current_user(request)
    return {"templates": TEMPLATES}


@router.get("/config/snapshot")
async def config_snapshot(request: Request, workspaceKind: str = "", projectRoot: str = ""):
    current_user(request)
    d = dbm.db()
    default = d.scalar("SELECT value_json FROM setting WHERE key='models.default'")
    doc = {"version": "1.0", "effective": {
        "models": {"defaultModelKey": (default or "").strip('"') or None,
                   "providers": providers_doc()}},
        "meta": {"workspaceKind": workspaceKind or "user-assets",
                 "projectRoot": projectRoot, "generatedAt": now_ms(),
                 "app": CFG.get("app_name", "小说")}}
    if projectRoot:
        row = d.one("SELECT settings_json FROM book WHERE slug=?", (projectRoot,))
        doc["project"] = d.jloads(row["settings_json"], {}) if row else {}
    return doc


@router.get("/config/global")
async def config_global(request: Request):
    current_user(request)
    row = dbm.db().one("SELECT value_json FROM setting WHERE key='config.global'")
    return {"agent": {"profiles": _profiles_doc("global", "")},
            "config": dbm.db().jloads(row["value_json"], {}) if row else {}}


@router.put("/config/global")
async def config_global_put(request: Request, payload: dict = Body(default={})):
    current_user(request)
    _apply_profiles("global", "", (payload or {}).get("agent") or {})
    return {"ok": True}


@router.get("/config/project")
async def config_project(request: Request, projectRoot: str = "", workspaceKind: str = ""):
    current_user(request)
    profiles = _profiles_doc("book", projectRoot)
    return {"agent": {"profiles": profiles}, "config": {"agent": {"profiles": profiles}},
            "project": {"projectRoot": projectRoot}}


@router.put("/config/project")
async def config_project_put(request: Request, projectRoot: str = "",
                             payload: dict = Body(default={})):
    current_user(request)
    _apply_profiles("book", projectRoot, (payload or {}).get("agent") or {})
    return {"ok": True}


@router.get("/config/editor-snapshot")
async def editor_snapshot(request: Request, workspaceKind: str = "", projectRoot: str = ""):
    current_user(request)
    return {"global": {"agent": {"profiles": _profiles_doc("global", "")}},
            "project": ({"agent": {"profiles": _profiles_doc("book", projectRoot)}}
                        if projectRoot else {})}


def _profiles_doc(scope: str, slug: str) -> dict:
    rows = dbm.db().query("SELECT * FROM preset WHERE scope=? AND slug=?", (scope, slug))
    out = {}
    for r in rows:
        out[r["profile_key"]] = {"settings": dbm.db().jloads(r["values_json"], {}),
                                 "model": dbm.db().jloads(r["model_json"], {})}
    return out


def _apply_profiles(scope: str, slug: str, agent: dict) -> None:
    profiles = (agent or {}).get("profiles") or {}
    d = dbm.db()
    for key, prof in profiles.items():
        d.execute(
            "INSERT INTO preset(scope,slug,profile_key,values_json,model_json,updated_at)"
            " VALUES(?,?,?,?,?,?) ON CONFLICT(scope,slug,profile_key) DO UPDATE SET"
            " values_json=excluded.values_json, model_json=excluded.model_json,"
            " updated_at=excluded.updated_at",
            (scope, slug, key, d.jdumps(prof.get("settings") or {}),
             d.jdumps(prof.get("model") or {}), now_ms()))


# ── 预设页要的那份表单（旧层的形状：agentProfiles[].settings.form/value）────
@router.get("/agent/profiles/settings")
async def profiles_settings(request: Request, workspaceKind: str = "user-assets",
                            scope: str = "global", projectRoot: str = ""):
    current_user(request)
    from .presets import build_presets
    p = build_presets("book" if scope == "project" else "global", projectRoot)
    profs = []
    for prof in p["profiles"]:
        profs.append({
            "profileKey": prof["profileKey"], "name": prof["name"],
            "settings": {"form": {"fields": prof["fields"]}, "value": prof["values"],
                         "issues": []},
            "model": prof["model"],
        })
    # 旧平台的形状：这一坨字段前端会读；我们照旧给全，值都是真的
    return {
        "agentProfiles": profs, "profileModelDefaults": p["modelDefaults"],
        "enabledModels": [m["key"] for m in p["models"]],
        "validationIssues": [],
        "harnessRuntimeDefaults": {},
        "profileRuntimeDefaults": {},
        "globalRuntimeDefaultsPatch": {"scope": "global"},
        "projectRuntimeDefaultsPatch": ({"scope": "project", "projectRoot": projectRoot}
                                        if projectRoot else {}),
    }


# ── 供应商增删改（新前端「模型」工具用）────────────────────────────────────
@router.post("/config/models/provider")
async def provider_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    d = dbm.db()
    pid = payload.get("id")
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "供应商名字不能空")
    grp = (payload.get("group") or name).strip()
    if pid:
        row = d.one("SELECT * FROM provider WHERE id=?", (pid,))
        if not row:
            raise HTTPException(404, "没有这个供应商")
        d.execute("UPDATE provider SET name=?, grp=?, model_api=?, base_url=?, enabled=?,"
                  " updated_at=? WHERE id=?",
                  (name, grp, payload.get("modelApi") or row["model_api"],
                   payload.get("baseUrl") or row["base_url"],
                   1 if payload.get("enabled", True) else 0, now_ms(), pid))
    else:
        pid = d.execute(
            "INSERT INTO provider(name,grp,model_api,base_url,api_key,enabled,options_json,"
            "sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (name, grp, payload.get("modelApi") or "openai-completions",
             payload.get("baseUrl") or "", payload.get("apiKey") or "",
             1 if payload.get("enabled", True) else 0, "{}", 99, now_ms(), now_ms()))
    if payload.get("apiKey"):
        d.execute("UPDATE provider SET api_key=? WHERE id=?", (payload["apiKey"], pid))
    for m in (payload.get("models") or []):
        mid = str(m.get("id") or "").strip()
        if not mid:
            continue
        d.execute(
            "INSERT INTO provider_model(provider_id,model_id,name,grp,enabled,reasoning,"
            "context_window,max_tokens,cost_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(provider_id,model_id) DO UPDATE SET name=excluded.name,"
            " enabled=excluded.enabled, reasoning=excluded.reasoning,"
            " context_window=excluded.context_window, max_tokens=excluded.max_tokens,"
            " updated_at=excluded.updated_at",
            (pid, mid, m.get("name") or mid, grp, 1 if m.get("enabled", True) else 0,
             1 if m.get("reasoning") else 0, int(m.get("contextWindowTokens") or 0),
             int(m.get("maxTokens") or 0), "{}", now_ms()))
    return {"ok": True, "id": pid}


@router.delete("/config/models/provider")
async def provider_delete(request: Request, id: int):
    current_user(request)
    dbm.db().execute("DELETE FROM provider WHERE id=?", (id,))
    return {"ok": True}


@router.post("/config/models/test")
async def model_test(request: Request, payload: dict = Body(default={})):
    """连通性自检：真发一句话出去，看回不回得来。"""
    current_user(request)
    from ..llm.providers import LLMError, provider_of, complete
    key = (payload or {}).get("modelKey") or ""
    if not key:
        d = dbm.db()
        key = (d.scalar("SELECT value_json FROM setting WHERE key='models.default'") or "").strip('"')
    if not key:
        raise HTTPException(400, "还没选模型")
    try:
        provider, mid = provider_of(key)
        t0 = now_ms()
        text = await complete(provider, mid, [{"role": "user", "content": "说一句「连通正常」就行"}],
                              max_tokens=32, temperature=0)
        return {"ok": True, "modelKey": key, "ms": now_ms() - t0, "reply": text[:120]}
    except LLMError as e:
        return {"ok": False, "modelKey": key, "error": str(e)}
    except Exception as e:
        return {"ok": False, "modelKey": key, "error": f"{e.__class__.__name__}: {e}"}


@router.get("/config/models/default")
async def model_default_get(request: Request):
    current_user(request)
    d = dbm.db()
    v = d.scalar("SELECT value_json FROM setting WHERE key='models.default'")
    return {"modelKey": (v or "").strip('"') or None}


@router.post("/config/models/default")
async def model_default_set(request: Request, payload: dict = Body(...)):
    current_user(request)
    key = (payload or {}).get("modelKey") or ""
    from ..llm.providers import provider_of, LLMError
    if key:
        try:
            provider_of(key)
        except LLMError as e:
            raise HTTPException(400, str(e))
    dbm.db().execute(
        "INSERT INTO setting(key,value_json,updated_at) VALUES('models.default',?,?)"
        " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
        " updated_at=excluded.updated_at", (dbm.db().jdumps(key), now_ms()))
    return {"ok": True, "modelKey": key}


@router.post("/config/models/recommended")
async def model_recommended_set(request: Request, payload: dict = Body(...)):
    current_user(request)
    keys = (payload or {}).get("keys") or []
    dbm.db().execute(
        "INSERT INTO setting(key,value_json,updated_at) VALUES('models.recommended',?,?)"
        " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
        " updated_at=excluded.updated_at", (dbm.db().jdumps(list(keys)), now_ms()))
    return {"ok": True, "keys": keys}


# ── 第 27 轮新增（只增不减）：自己加渠道 / 自己拉取模型 / 备用模型 / 按书选模型 ──────
def _setting_get(key: str) -> str:
    """读一条设置（`value_json` 是 JSON 编过一层的，先解一层再当字符串用）。

    以前是 `(v or "").strip('"')` —— 只对"没有内层引号的短字符串"成立；
    像 `web.sources` 这种 JSON 数组，存进去是 `"[{\"host\":…}]"`，
    剥掉外层引号还剩转义，`json.loads` 直接失败 → **用户加的站点读出来是空的**。
    """
    v = dbm.db().scalar("SELECT value_json FROM setting WHERE key=?", (key,))
    if v is None or not str(v).strip():
        return ""
    got = dbm.db().jloads(v, None)
    if isinstance(got, str):
        return got
    if got is None:
        return str(v)
    return json.dumps(got, ensure_ascii=False)


def _setting_set(key: str, value) -> None:
    d = dbm.db()
    d.execute("INSERT INTO setting(key,value_json,updated_at) VALUES(?,?,?)"
              " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
              " updated_at=excluded.updated_at", (key, d.jdumps(value), now_ms()))


@router.get("/config/models/providers")
async def providers_list(request: Request):
    """给「对话页 · 渠道」用的干净清单（不经过 /config/snapshot 那一大坨）。密钥只回"配没配"。"""
    current_user(request)
    d = dbm.db()
    out = []
    for p in d.query("SELECT * FROM provider ORDER BY sort, id"):
        n = d.scalar("SELECT COUNT(*) FROM provider_model WHERE provider_id=?", (p["id"],)) or 0
        out.append({"id": p["id"], "name": p["name"], "group": p["grp"],
                    "modelApi": p["model_api"], "baseUrl": p["base_url"],
                    "enabled": bool(p["enabled"]), "models": n,
                    "keyConfigured": bool(p["api_key"]),
                    "keyTail": ("…" + p["api_key"][-4:]) if p["api_key"] else ""})
    return {"providers": out,
            "default": _setting_get("models.default"),
            "fallback": _setting_get("models.fallback")}


@router.post("/config/models/pull")
async def models_pull(request: Request, payload: dict = Body(default={})):
    """**自己拉取**：拿这个渠道的 `/models` 把模型清单拉回来，写进库。

    用法：`{providerId: 3}` 用已存渠道；或 `{baseUrl, apiKey, modelApi}` 直接试（还没保存也能先拉）。
    失败一律说人话（地址不对 / 密钥不对 / 这家没有 /models 接口）。
    """
    current_user(request)
    d = dbm.db()
    pid = (payload or {}).get("providerId")
    row = None
    if pid:
        row = d.one("SELECT * FROM provider WHERE id=?", (int(pid),))
        if not row:
            raise HTTPException(404, "没有这个渠道")
    base = ((payload or {}).get("baseUrl") or (row or {}).get("base_url") or "").strip().rstrip("/")
    key = ((payload or {}).get("apiKey") or (row or {}).get("api_key") or "").strip()
    if not base:
        raise HTTPException(400, "还没填地址（base_url）")
    url = base + "/models"
    headers = {"content-type": "application/json"}
    if key:
        headers["authorization"] = "Bearer " + key
    try:
        with httpx.Client(timeout=httpx.Timeout(25.0, connect=8.0)) as cli:
            r = cli.get(url, headers=headers)
            code = r.status_code
            text = r.text
    except Exception as e:
        return {"ok": False, "url": url, "error": f"连不上这个地址：{type(e).__name__}",
                "hint": "检查地址写没写错（要以 /v1 结尾的多）／这台机器能不能出网"}
    if code >= 400:
        return {"ok": False, "url": url, "status": code, "error": f"{code}：{text[:200]}",
                "hint": "密钥不对或者这家不支持 /models（可以手填模型名）"}
    try:
        obj = json.loads(text)
    except Exception:
        return {"ok": False, "url": url, "status": code, "error": "返回的不是 JSON：%s" % text[:160],
                "hint": "这家可能不是 OpenAI 兼容接口"}
    items = obj.get("data") if isinstance(obj, dict) else None
    if items is None and isinstance(obj, dict):
        items = obj.get("models")
    if not isinstance(items, list):
        return {"ok": False, "url": url, "status": code, "error": "返回里没有模型清单",
                "hint": "这家可能不是 OpenAI 兼容接口（/models 里应该有 data[]）"}
    added, seen = 0, []
    for it in items:
        mid = str((it or {}).get("id") or (it or {}).get("name") or "").strip()
        if not mid:
            continue
        seen.append(mid)
        if not pid:
            continue
        d.execute(
            "INSERT INTO provider_model(provider_id,model_id,name,grp,enabled,reasoning,"
            "context_window,max_tokens,cost_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(provider_id,model_id) DO UPDATE SET name=excluded.name,"
            " updated_at=excluded.updated_at",
            (int(pid), mid, (it or {}).get("name") or mid,
             (row or {}).get("grp") or "custom", 1, 0,
             int((it or {}).get("context_window") or 0), int((it or {}).get("max_tokens") or 0),
             "{}", now_ms()))
        added += 1
    return {"ok": True, "url": url, "found": len(seen), "saved": added,
            "models": seen[:200], "savedToProvider": bool(pid),
            "note": "" if pid else "这次只是试用没存；先保存渠道再拉取，模型才会进库"}


@router.post("/config/models/fallback")
async def model_fallback_set(request: Request, payload: dict = Body(default={})):
    """备用模型：主模型这一轮挂掉时自动换它再试一次（用户要的"默认 + 备用"）。"""
    current_user(request)
    key = ((payload or {}).get("modelKey") or "").strip()
    if key:
        from ..llm.providers import provider_of, LLMError
        try:
            provider_of(key)
        except LLMError as e:
            raise HTTPException(400, str(e))
    _setting_set("models.fallback", key)
    return {"ok": True, "fallback": key}


@router.post("/config/models/book")
async def model_book_set(request: Request, payload: dict = Body(default={})):
    """按书存：这本书用哪个模型（`{slug, modelKey}`，modelKey 传空 = 取消这本书的指定）。"""
    current_user(request)
    slug = ((payload or {}).get("slug") or "").strip()
    if not slug:
        raise HTTPException(400, "没说是哪本书")
    key = ((payload or {}).get("modelKey") or "").strip()
    if key:
        from ..llm.providers import provider_of, LLMError
        try:
            provider_of(key)
        except LLMError as e:
            raise HTTPException(400, str(e))
    _setting_set("models.book:" + slug, key)
    return {"ok": True, "slug": slug, "modelKey": key}


@router.get("/config/models/book")
async def model_book_get(request: Request, slug: str = ""):
    current_user(request)
    slug = (slug or "").strip()
    return {"slug": slug, "modelKey": _setting_get("models.book:" + slug) if slug else ""}

# ── 联网搜索的设置（用户第 31 轮：「所有 AI 是可以开启联网搜索功能的」）────────────────
# 默认**关**。关着的时候 AI 手里那两个工具会直接回"没开"，**一个请求都不发**——
# "绝不偷偷联网"是判据里能报红的硬要求（tools/check_websearch.py）。
@router.get("/config/web")
async def web_config(request: Request):
    current_user(request)
    from ..engine import websearch as web
    return web.catalogue()


@router.post("/config/web")
async def web_config_set(request: Request, payload: dict = Body(default={})):
    """改联网设置：`{enabled?, openAny?, sources?}` —— 只动传进来的那几项。"""
    current_user(request)
    p = payload or {}
    if "enabled" in p:
        _setting_set("web.enabled", "1" if p.get("enabled") else "0")
    if "openAny" in p:
        _setting_set("web.open_any", "1" if p.get("openAny") else "0")
    if "sources" in p:
        arr = p.get("sources") or []
        if not isinstance(arr, list):
            raise HTTPException(400, "sources 要是数组")
        clean = []
        for x in arr:
            if isinstance(x, dict) and str(x.get("host") or "").strip():
                clean.append({"name": str(x.get("name") or x["host"]).strip()[:40],
                              "host": str(x["host"]).strip().lower()[:80],
                              "weight": int(x.get("weight") or 3),
                              # 搜索地址模板（含 `{q}` 才有用）：少存这一个字段，
                              # 用户改一次名字/权重就把自己站的搜索弄丢了
                              "search": str(x.get("search") or "").strip()[:300]})
        _setting_set("web.sources", json.dumps(clean, ensure_ascii=False))
    from ..engine import websearch as web
    return {"ok": True, **web.catalogue()}


@router.post("/config/web/test")
async def web_config_test(request: Request, payload: dict = Body(default={})):
    """「搜一句试试」：拿一个词真搜一次，把**结果或者原因**摆给用户看。

    为什么要这个接口：用户最担心的就是"它找不到太好的文本样品"。光有个开关，
    用户没法知道这个开关打开以后能搜到什么 —— 所以给他一个当场试的地方。
    **没开联网的时候这里照样一个请求都不发**（`websearch.search` 自己就把关）。
    只增：不改任何已有接口的行为。
    """
    current_user(request)
    from ..engine import websearch as web
    q = str((payload or {}).get("q") or "").strip()[:80]
    if not q:
        raise HTTPException(400, "要搜什么？（q）")
    r = await asyncio.to_thread(lambda: asyncio.run(web.search(q, 5)))
    return {
        "ok": bool(r.get("ok")), "enabled": bool(r.get("enabled")),
        "query": r.get("query") or q,
        "note": r.get("note") or "",
        "error": r.get("error") or "",
        "engines": r.get("engines") or [],
        "engineErrors": r.get("errors") or [],
        "results": [{"title": x["title"], "url": x["url"], "source": x.get("source") or "",
                     "snippet": (x.get("snippet") or "")[:200]} for x in (r.get("results") or [])],
        "dropped": (r.get("dropped") or [])[:5],
        "leads": (r.get("leads") or [])[:5],
    }
