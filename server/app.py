#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""小说 App · 自研后端（入口）。

跑起来：`server/venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8899`
（生产用 systemd user 服务 `novelapp.service`，见 deploy/novelapp.service）

设计要点：
* **一个进程一个端口**，同时提供静态前端与全部接口（见 docs/决策记录 D4）。
* **没有"项目未打开"状态**：任何 book slug 随时可用，不会 409（见 docs/设计方案 §5）。
* `api/...` 与 `nb/api/...` 挂的是**同一批 router 对象**，实现只有一份。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi import Response
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

# 允许 `python server/app.py` 与 `-m uvicorn server.app:app` 两种跑法
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import db as dbm                      # noqa: E402
from server.config import CFG                      # noqa: E402
from server.security import hash_password          # noqa: E402
from server.store import P, now_ms                 # noqa: E402

VERSION = "1.0.0"

# ── 数值参数的边界（第 8 遍打磨加的）────────────────────────────────────────
# 为什么要有：SQLite 的 INTEGER 是 64 位，`?limit=99999999999999999999` 会一路走到
# sqlite3 里炸成 `Python int too large to convert to SQLite INTEGER` → **HTTP 500**。
# 前端不可能发这种数，但书签/收藏里的老链接、或者别人手敲地址栏都能发出来。
# "参数不对"就该是 400，不该是 500 —— 后者会让人以为服务坏了。
MAX_INT = 2 ** 53 - 1                      # JS 能精确表示的上限，比 SQLite 的 2^63-1 更严
_TRUE = {"1", "true", "yes", "on", "t", "y"}
_FALSE = {"0", "false", "no", "off", "f", "n", ""}


async def _check_query_numbers(request: Request) -> None:
    """在**进入业务代码之前**把数值型 query 参数校验一遍（一条判据管全部路由，新加的也自动管）。

    FastAPI 自己会拦"不是数字"，但拦不住"数字大到溢出 SQLite" —— 那正是 500 的来源。
    """
    route = request.scope.get("route")
    dep = getattr(route, "dependant", None)
    if dep is None:
        return
    qp = request.query_params
    for field in getattr(dep, "query_params", []):
        name = getattr(field, "name", "")
        if not name or name not in qp:
            continue
        ann = getattr(getattr(field, "field_info", None), "annotation", None)
        raw = qp.get(name)
        if ann is bool:
            if raw.strip().lower() not in (_TRUE | _FALSE):
                raise HTTPException(400, f"参数 {name} 要填是/否（收到 {raw[:20]!r}）")
            continue
        if ann not in (int, float):
            continue
        try:
            val = int(raw) if ann is int else float(raw)
        except (TypeError, ValueError):
            raise HTTPException(400, f"参数 {name} 要是数字（收到 {raw[:20]!r}）")
        if val != val or val in (float("inf"), float("-inf")):     # NaN / inf
            raise HTTPException(400, f"参数 {name} 超出范围（收到 {raw[:20]!r}）")
        if abs(val) > MAX_INT:
            raise HTTPException(400, f"参数 {name} 超出范围（最大 {MAX_INT}，收到 {raw[:20]!r}）")


app = FastAPI(title="小说 App 自研后端", version=VERSION, docs_url=None, redoc_url=None,
              openapi_url=None, dependencies=[Depends(_check_query_numbers)])

# ── 路由（同一个 router 挂两套前缀：老前端用 api/，工具页用 nb/api/）────────
from server.routers import (agent, appearance, authoring, backup, books, config_models, core,  # noqa: E402
                            export as export_r,
                            files, lint as lint_r, lore, misc, model_sets, notes, peer, plot,
                            pacing, presets as presets_r, prompts as prompts_r, rag, refs, stats, sync,
                            tts, voice, workflows, world, write)

ROUTERS = [core.router, books.router, lore.router, presets_r.router, files.router,
           tts.router, agent.router, config_models.router, rag.router,
           world.router, plot.router, write.router, lint_r.router, stats.router,
           export_r.router, misc.router, backup.router, prompts_r.router,
           notes.router, model_sets.router, sync.router, workflows.router, voice.router,
           pacing.router, refs.router, peer.router, authoring.router, appearance.router]

for r in ROUTERS:
    app.include_router(r, prefix="/api")
    app.include_router(r, prefix="/nb/api")


# ── 请求日志（一行一条 JSON；**不打印密钥**）────────────────────────────────
LOG_FILE = P.logs / "server.jsonl"


LOG_MAX_BYTES = int(os.environ.get("NOVELAPP_LOG_MAX_BYTES") or 4 * 1024 * 1024)
LOG_KEEP = 3                        # 留几个滚动文件（server.1.jsonl / .2 / .3）
# 上限可以用环境变量压小（自测用：tools/test_engine.py 的 H 段就是靠它证明真会滚）
_log_state = {"size": None, "writes": 0}


def _roll_if_needed() -> None:
    """日志滚动：后端现在也跑在**手机里**，一个只涨不缩的文件迟早把存储吃光。

    （第 9 遍打磨补的：`logs/server.jsonl` 以前没有上限，开发期就长到 950KB；
    手机上装一年、错误日志攒起来没人清，用户会先发现"空间不够了"。）
    """
    try:
        sz = LOG_FILE.stat().st_size if LOG_FILE.exists() else 0
    except OSError:
        return
    if sz < LOG_MAX_BYTES:
        _log_state["size"] = sz
        return
    try:
        for i in range(LOG_KEEP, 1, -1):           # .2 → .3 …（最老的丢掉）
            src, dst = LOG_FILE.with_suffix(f".{i - 1}.jsonl"), LOG_FILE.with_suffix(f".{i}.jsonl")
            if src.exists():
                os.replace(src, dst)
        os.replace(LOG_FILE, LOG_FILE.with_suffix(".1.jsonl"))
        _log_state["size"] = 0
    except OSError:
        pass                                        # 滚不动也绝不能影响请求


def log_line(rec: dict) -> None:
    try:
        # 攒够 200 条才 stat 一次：每条请求都 stat 一遍没必要（手机上尤其浪费）
        _log_state["writes"] += 1
        if _log_state["writes"] % 200 == 1 or _log_state["size"] is None:
            _roll_if_needed()
        elif (_log_state["size"] or 0) > LOG_MAX_BYTES:
            _roll_if_needed()
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        _log_state["size"] = (_log_state["size"] or 0) + 200
    except Exception:
        # 记请求日志失败（磁盘满 / 权限 / 被别处挪走了）不该让用户的请求跟着失败 ——
        # 日志是附带的，正文和数据才是正事。
        pass


@app.middleware("http")
async def _observe(request: Request, call_next):
    t0 = time.time()
    try:
        resp = await call_next(request)
    except Exception as e:                       # 兜底：绝不让异常变成 HTML 500 页
        # 记**堆栈**，不只记一行 repr —— 只有一句 "int too large" 的话，排查等于盲猜
        import traceback
        tb = traceback.format_exc()
        log_line({"at": now_ms(), "level": "error", "path": request.url.path,
                  "query": dict(request.query_params),
                  "error": repr(e)[:300],
                  "traceback": tb[-2000:] if isinstance(tb, str) else tb})
        if os.environ.get("NOVELAPP_DEBUG_TRACE"):
            return JSONResponse({"detail": str(e)[:200], "traceback": tb[-4000:]},
                                status_code=500)
        return JSONResponse({"detail": "服务器内部错误：%s" % (str(e)[:120] or "未知")},
                            status_code=500)
    ms = int((time.time() - t0) * 1000)
    p = request.url.path
    if not p.startswith(("/api/", "/nb/api/")):
        # 前端资源一律不缓存：WebView 缓存很顽固，改了 JS 手机上还看旧的
        if p.endswith((".html", ".css", ".js", ".webmanifest")) or p in ("/", ""):
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    if p.startswith(("/api/", "/nb/api/")):
        # 接口一律不许缓存：WebView 缓存很顽固 —— 不打招呼就给你端出上一回的书目/登录态，
        # 表现就是「明明改了，手机上还是旧的」，断网时还会假装联网成功。
        resp.headers["Cache-Control"] = "no-store"
    if p.startswith(("/api/", "/nb/api/")) and (resp.status_code >= 400 or ms > 1500):
        log_line({"at": now_ms(), "level": "warn" if resp.status_code < 500 else "error",
                  "method": request.method, "path": p, "status": resp.status_code, "ms": ms})
    return resp


# ── 跨源（App 的界面是从安装包里加载的，来源是 file://）────────────────────
# 为什么需要：App 里前端是**内嵌**的（file:///android_asset/www/index.html），
# 而后端在服务器上 —— 两个不同的来源。**JSON 接口不用管**（App 里走安卓的 JS 桥，
# 由 Java 代发，压根没有跨源这回事）；但有三样东西死活得让浏览器自己去发：
#   · EventSource（AI 流式输出 / 多 Agent 进度）
#   · 上传（选文件、选图片）
#   · 流式下载
# 这些在 file:// 下会带 Origin: null 来问，服务器得回话。
# 安全性：会话 cookie 是 SameSite=Lax + httponly，跨站请求本来就不会带上它；
# 上面那几样都靠 URL 上的 ?token= 认证（会话口令，见 security.token_from）。
# 所以这里只是"允许跨源读返回体"，没有放松认证。
@app.middleware("http")
async def _cors(request: Request, call_next):
    origin = request.headers.get("origin", "")
    if request.method == "OPTIONS" and request.headers.get("access-control-request-method"):
        resp = Response(status_code=204)
    else:
        resp = await call_next(request)
    if origin:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
        resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = (
            request.headers.get("access-control-request-headers") or "content-type,x-token")
        resp.headers["Access-Control-Expose-Headers"] = "content-disposition,content-length,content-type"
        resp.headers["Access-Control-Max-Age"] = "600"
        try:
            resp.headers.add_vary_header("Origin")
        except Exception:
            resp.headers["Vary"] = "Origin"
    return resp


@app.exception_handler(Exception)
async def _any_error(request: Request, exc: Exception):
    import traceback
    log_line({"at": now_ms(), "level": "error", "path": request.url.path,
              "error": repr(exc)[:300], "traceback": traceback.format_exc()[-2000:]})
    return JSONResponse({"detail": str(exc)[:200] or "出错了"}, status_code=500)


# ── 启动 ────────────────────────────────────────────────────────────────────
def bootstrap_user() -> None:
    """第一次跑：建一个管理员账号。

    密码来源（按顺序）：环境变量 `NOVELAPP_INIT_PASSWORD` → 旧 App 的配置（用户已经记得的那个）
    → 随机生成并写到 `data/initial-password.txt`（0600，不进日志、不进 git）。
    """
    d = dbm.db()
    if (d.scalar("SELECT COUNT(*) FROM user") or 0) > 0:
        return
    pw = os.environ.get("NOVELAPP_INIT_PASSWORD", "").strip()
    # 旧配置的查找顺序（都能改，别写死一台机器）：
    #   ① 设了 NOVELAPP_LEGACY_CONFIG 就**只用它**（设成不存在的路径 = 强制走"随机生成口令"那条路）
    #   ② 没设 → 先看**仓库根目录的 config.json**（别人 clone 下来放这儿就认）
    #   ③ 都没有 → 再看老平台那份（只在这台机器上存在，别的机器上这一步自然跳过）
    cands = []
    _env = os.environ.get("NOVELAPP_LEGACY_CONFIG", "").strip()
    if _env:
        cands = [Path(_env)]
    else:
        cands = [Path(__file__).resolve().parents[1] / "config.json",
                 Path("/home/ubuntu/nbapp/config.json")]
    if not pw:
        for legacy in cands:
            try:
                if legacy.exists():
                    pw = str(json.loads(legacy.read_text("utf-8")).get("app_password") or "").strip()
                    if pw:
                        break
            except Exception:
                continue
    if not pw:
        import secrets
        pw = secrets.token_urlsafe(9)
        f = P.data / "initial-password.txt"
        f.write_text(pw + "\n", encoding="utf-8")
        os.chmod(f, 0o600)
    h, salt = hash_password(pw)
    n = now_ms()
    d.execute("INSERT INTO user(username,display_name,password_hash,salt,role,status,"
              "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
              ("admin", "管理员", h, salt, "admin", "active", n, n))


@app.on_event("startup")
async def _startup():
    dbm.init(P.db)
    bootstrap_user()
    try:
        from server.routers.books import heal_book_index
        gone = heal_book_index()         # 幽灵书（库里有行、磁盘上没目录）开机就清掉
        if gone:
            log_line({"at": now_ms(), "level": "warn", "event": "heal-book-index",
                      "gone": gone[:20], "count": len(gone)})
    except Exception as e:
        log_line({"at": now_ms(), "level": "error", "event": "heal-book-index",
                  "error": repr(e)[:200]})
    try:
        from server.security import prune_tokens
        n = prune_tokens()               # 过期/注销很久的登录口令：开机清一次，别让表无限长大
        if n:
            log_line({"at": now_ms(), "level": "info", "event": "prune-tokens", "gone": n})
    except Exception as e:
        log_line({"at": now_ms(), "level": "error", "event": "prune-tokens",
                  "error": repr(e)[:200]})
    log_line({"at": now_ms(), "level": "info", "event": "startup", "version": VERSION,
              "data": str(P.data), "frontend": str(P.frontend)})
    try:
        from server.routers.backup import start_auto_thread
        start_auto_thread()          # 自动备份：每 10 分钟看一眼，到点就打一份
    except Exception as e:
        log_line({"at": now_ms(), "level": "error", "event": "auto-backup-start",
                  "error": repr(e)[:200]})


@app.get("/api/version")
async def version():
    return {"version": VERSION, "name": CFG.get("app_name", "小说")}


# ── 静态前端（必须最后挂：Starlette 按注册顺序匹配）─────────────────────────
if P.frontend.is_dir():
    app.mount("/", StaticFiles(directory=str(P.frontend), html=True), name="frontend")
else:
    @app.get("/")
    async def _no_frontend():
        return PlainTextResponse("前端目录还没准备好：" + str(P.frontend), status_code=503)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=str(CFG.get("host", "127.0.0.1")), port=int(CFG.get("port", 8899)),
                log_level=str(CFG.get("log_level", "warning")))
