#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针：把线上反代层（127.0.0.1:8890）每条接口的真实返回结构抓下来。

用途：新后端要「形状照旧」，这份 golden 样本就是比对基准。
只做**只读**调用；会改数据的接口只记录它的入参形状，不真的调用。
密钥从本机配置读，不打印。
"""
import json, sys, time, urllib.parse, urllib.request, http.cookiejar
from pathlib import Path

BASE = "http://127.0.0.1:8890"
CFG = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
OUT = Path("/home/ubuntu/novel-app/ref/golden")
OUT.mkdir(parents=True, exist_ok=True)

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def call(path, method="GET", body=None, raw=False, timeout=60):
    url = BASE + "/" + path.lstrip("/")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    t0 = time.time()
    try:
        with op.open(req, timeout=timeout) as r:
            b = r.read()
            ct = r.headers.get("content-type", "")
            ms = int((time.time() - t0) * 1000)
            if raw or "json" not in ct:
                return {"__status": r.status, "__ctype": ct, "__bytes": len(b), "__ms": ms}
            return {"__status": r.status, "__ms": ms, "__data": json.loads(b.decode("utf-8"))}
    except urllib.error.HTTPError as e:
        b = e.read()
        return {"__status": e.code, "__error": b.decode("utf-8", "replace")[:300]}
    except Exception as e:
        return {"__error": repr(e)[:300]}

def shape(v, depth=0):
    """把返回压成「结构指纹」：字段名 + 类型，去掉具体内容。"""
    if depth > 6:
        return "..."
    if isinstance(v, dict):
        return {k: shape(x, depth + 1) for k, x in v.items()}
    if isinstance(v, list):
        return [shape(v[0], depth + 1)] if v else []
    if isinstance(v, str):
        return "str(%d)" % len(v)
    return type(v).__name__

call("api/app/login", "POST", {"password": str(CFG["app_password"])})

_shelf = call("api/shelf")
SLUG = ((_shelf.get("__data") or {}).get("projects") or [{}])[0].get("slug")
if not SLUG:
    print("no project!", flush=True); sys.exit(1)
CHAPTER = {"path": None}
_proj = call("nb/api/projects")
print("slug =", SLUG, flush=True)

PLAN = []
q = urllib.parse.quote

def add(name, path, method="GET", body=None):
    PLAN.append((name, path, method, body))

# 先找一章真实存在的正文，后面所有跟章节有关的探针都用它
_tree = call("nb/api/workspace-files/tree?projectRoot=" + q(SLUG))
_nodes = ((_tree.get("__data") or {}).get("nodes") or [])
CHAPTER = next((n["path"] for n in _nodes
                if isinstance(n, dict) and str(n.get("path", "")).startswith("manuscript/")
                and str(n.get("path", "")).endswith(".md") and not n.get("isDirectory")), None)
LORE = next((n["path"] for n in _nodes
             if isinstance(n, dict) and str(n.get("path", "")).startswith("lorebook/")
             and str(n.get("path", "")).endswith(".md")), None)
print("chapter =", CHAPTER, "lore =", LORE, flush=True)

add("app_info", "api/app/info")
add("app_status", "api/app/status")
add("auth_me", "nb/api/auth/me")
add("app_version", "nb/api/app/version")
add("app_logs_status", "nb/api/app/logs/status")
add("models", "api/models")
add("models_q", "api/models?q=gemini")
add("shelf", "api/shelf")
add("projects", "nb/api/projects")
add("book", "api/book?slug=" + q(SLUG))
add("chapter", "api/chapter?slug=" + q(SLUG) + "&path=" + q(CHAPTER))
add("lore_tree", "api/lore/tree?slug=" + q(SLUG))
add("lore_search", "api/lore/search?slug=" + q(SLUG) + "&q=" + q("魂"))
add("presets", "api/presets?scope=global")
add("presets_proj", "api/presets?scope=project&slug=" + q(SLUG))
add("tts_voices", "api/tts/voices")
add("tts_segments", "api/tts/segments?slug=" + q(SLUG) + "&path=" + q(CHAPTER))
add("search", "api/search?slug=" + q(SLUG) + "&q=" + q("的") + "&limit=3")
add("inbox", "api/inbox?slug=" + q(SLUG))
add("files_tree", "nb/api/workspace-files/tree?projectRoot=" + q(SLUG))
add("files_read", "nb/api/workspace-files/read?projectRoot=" + q(SLUG) + "&path=" + q(CHAPTER))
add("files_download", "nb/api/workspace-files/download?projectRoot=" + q(SLUG) + "&path=" + q(CHAPTER))
add("history_inbox", "nb/api/workspace-history/inbox?projectRoot=" + q(SLUG))
add("agent_sessions", "nb/api/agent/sessions?scope=project&projectRoot=" + q(SLUG) + "&limit=50")
add("agent_profiles_catalog", "nb/api/agent/profiles/catalog")
add("agent_profiles_settings_g", "nb/api/agent/profiles/settings?workspaceKind=user-assets&scope=global")
add("agent_profiles_settings_p", "nb/api/agent/profiles/settings?workspaceKind=novel&projectRoot=" + q(SLUG) + "&scope=project")
add("agent_profiles_build_status", "nb/api/agent/profiles/build-status")
add("agent_skills", "nb/api/agent/skills")
add("agent_jobs", "nb/api/agent/jobs")
add("agent_traces", "nb/api/agent/traces/recent?limit=5")
add("config_models_library", "nb/api/config/models/library")
add("config_models_provider_templates", "nb/api/config/models/provider-templates")
add("config_snapshot", "nb/api/config/snapshot?workspaceKind=user-assets")
add("passport_status", "nb/api/passport/status")
add("passport_backups", "nb/api/passport/backups")
add("passport_backup_keys", "nb/api/passport/backup-keys")
add("admin_users", "nb/api/admin/users")
add("rag_memories", "nb/api/projects/rag/memories?projectRoot=" + q(SLUG))
add("rag_inspector", "nb/api/projects/rag/inspector?projectRoot=" + q(SLUG))
add("rag_subject", "nb/api/projects/rag/subject?projectRoot=" + q(SLUG) + "&subject=" + q("林诺"))
add("rag_search", "nb/api/projects/rag/search?projectRoot=" + q(SLUG) + "&q=" + q("雪"))
add("rag_debug", "nb/api/projects/rag/debug?projectRoot=" + q(SLUG))
add("profiles_source", "nb/api/agent/profiles/source?profileKey=writer")
add("logs_download", "nb/api/app/logs/download")
add("cover", "api/cover?slug=" + q(SLUG))

res = {"__slug": SLUG, "__chapter": CHAPTER, "__lore": LORE, "probes": {}}
for name, path, method, body in PLAN:
    r = call(path, method, body)
    res["probes"][name] = {
        "path": path, "method": method,
        "shape": (shape(r.get("__data")) if ("__data" in r or r.get("__bytes") is not None) and "__error" not in r
                  else {"bytes": r.get("__bytes"), "ctype": r.get("__ctype")}),
        "status": r.get("__status") or ("ERR" if "__error" in r else "?"),
        "error": (r.get("__error") or "")[:200],
        "sample": (json.dumps(r.get("__data"), ensure_ascii=False)[:1500] if "__data" in r else None),
    }
    print(name, res["probes"][name]["status"], flush=True)

(OUT / "legacy-shapes.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print("saved", OUT / "legacy-shapes.json")
