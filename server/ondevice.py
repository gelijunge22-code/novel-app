# -*- coding: utf-8 -*-
"""把**整份后端**跑在手机里（Chaquopy 嵌入式 CPython）。

为什么这么做（docs/决策记录 D10）：用户要的是"一个完整的 App"，不是"套着别人后端的网页壳"。
所以后端不能只在服务器上 —— 它得在手机里也能起：飞行模式下 App 打开、翻书、看设定、
扫 AI 味、看统计、建章改章、导出、备份，全都走**这台手机上的**服务；只有"调模型写正文"
这一步需要联网（没网时明确告诉用户，而不是转圈或报错糊过去）。

这一份代码**服务器上也在用**（`systemd` 那份是靠 uvicorn 命令行起的），
所以这里不复制任何业务逻辑，只负责：

1. 把数据目录 / 前端目录 / 配置文件指到 App 私有目录（`filesDir/…`）；
2. 起一个只监听 127.0.0.1 的 HTTP 服务（端口由系统挑，写进返回值）；
3. 生成一个**每台机器一份**的本地口令（`local_token`），WebView 带着它自动登录 ——
   这样手机上不需要用户输密码，同时别的 App 也没法随便读你的稿子。

Java 那边（MainActivity）拿到 `{"port":…, "token":…}` 后直接把 WebView 指到
`http://127.0.0.1:<port>/?t=<token>`。
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
import threading
import time
from pathlib import Path

# Chaquopy 里 Python 的 stdout 默认被吞掉；写日志文件更靠谱（排错全靠它）
_LOG_LOCK = threading.Lock()


def _log(root: Path, msg: str) -> None:
    try:
        with _LOG_LOCK:
            with (root / "ondevice.log").open("a", encoding="utf-8") as f:
                f.write("%.3f %s\n" % (time.time(), msg))
    except Exception:
        # 桥的日志写不进去不该影响桥本身的调用（手机上文件权限更乱）。
        pass


STATE: dict = {"port": 0, "token": "", "error": "", "root": "", "startedAt": 0.0}


def free_port(preferred: int = 0) -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", preferred or 0))
    p = s.getsockname()[1]
    s.close()
    return p


def write_config(root: Path, frontend: Path, port: int, token: str) -> Path:
    """写 App 自己的 config.json（数据/日志/前端目录全在 App 私有目录里）。"""
    cfg = {
        "app_name": "小说",
        "host": "127.0.0.1",
        "port": port,
        "data_root": str(root / "data"),
        "log_dir": str(root / "logs"),
        "frontend_dir": str(frontend),
        "apk_dir": str(root),            # 手机上不打包，这一项只是路径占位
        "log_level": "warning",
        "local_trust": True,             # 允许用 local_token 自动登录（只在 127.0.0.1 上）
        "local_token": token,
        "token_ttl_days": 3650,          # 手机是自己的，别老让人重新登录
    }
    path = root / "config.json"
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def seed_if_empty(root: Path, seed_dir: Path) -> dict:
    """首次启动把随包带的书稿快照铺进数据目录（**只铺一次，绝不覆盖已有数据**）。

    快照是打包时从仓库 `data/books/` 复制的（见 apk/build.sh）。用户在手机上写的新章
    一律不动：只要 `data/books/` 里已经有东西，这一步就整体跳过。
    """
    books = root / "data" / "books"
    marker = root / "seed.done"
    out = {"seeded": False, "books": 0, "reason": ""}
    try:
        if marker.exists():
            out["reason"] = "已经铺过"
            return out
        if books.exists() and any(p.is_dir() for p in books.iterdir()):
            out["reason"] = "本地已有书稿，不铺"
            marker.write_text("skip: local data exists\n", encoding="utf-8")
            return out
        if not seed_dir.is_dir():
            out["reason"] = "包里没有快照"
            return out
        import shutil
        books.mkdir(parents=True, exist_ok=True)
        n = 0
        for src in sorted(seed_dir.iterdir()):
            if src.is_dir():
                shutil.copytree(src, books / src.name, dirs_exist_ok=True)
                n += 1
        marker.write_text("seeded %d books at %d\n" % (n, int(time.time())),
                          encoding="utf-8")
        out.update(seeded=True, books=n)
        return out
    except Exception as e:                      # 铺不进去也不能拦住启动
        out["reason"] = repr(e)[:200]
        return out


def _import_app(root: Path, frontend: Path, port: int, token: str):
    """把配置塞进环境变量，再 import 后端本体（config.py 在 import 时就读它）。"""
    cfg = write_config(root, frontend, port, token)
    os.environ["NOVELAPP_CONFIG"] = str(cfg)
    os.environ.setdefault("NOVELAPP_INIT_PASSWORD", token)   # 首启建库时用它当口令
    # 手机上的 Python 在 APK 里是只读的，日志别往那边写
    os.environ.setdefault("PYTHONUTF8", "1")
    import server.app as app_mod
    from server import db as dbm
    from server.store import P
    dbm.init(P.db)
    app_mod.bootstrap_user()
    # 书稿在磁盘上是真相：首启用磁盘反建一次索引（这样快照进来的书立刻能读）
    try:
        from server.store import all_slugs
        from server.routers.books import sync_book
        for slug in all_slugs():
            try:
                sync_book(slug)
            except Exception as e:
                _log(root, "sync_book %s 失败：%r" % (slug, e))
    except Exception as e:
        _log(root, "重建索引失败：%r" % (e,))
    return app_mod.app


# ── JS 桥（不走 HTTP 的那条路）────────────────────────────────────────────
# App 里前端是从 assets 加载的（file:///android_asset/www/index.html），
# 所有 JSON 接口都通过 Java 的 @JavascriptInterface 直接调到这里 —— 进程内跑 ASGI，
# 不开端口、不过网卡、不等往返。媒体（音频/封面/导出下载）另说，见 bridge_base()。
_LOCAL: dict = {"app": None, "loop": None, "client": None}
_BRIDGE_LOCK = threading.Lock()


def init_app(root: Path, frontend: Path, token: str):
    """把后端本体加载起来（**不起 HTTP**）。JS 桥和 HTTP 服务共用同一个 app。"""
    if _LOCAL["app"] is not None:
        return _LOCAL["app"]
    app = _import_app(root, frontend, 0, token)
    _LOCAL["app"] = app
    _log(root, "app 已加载（JS 桥模式）")
    return app


def _run(coro, timeout: float = 300.0):
    return asyncio.run_coroutine_threadsafe(coro, _LOCAL["loop"]).result(timeout=timeout)


def _ensure_client(root: Path):
    """建一个"在进程里直连 ASGI"的客户端，并做一次本机自动登录。

    用 httpx 的 ASGITransport：请求根本不出进程，但走的是**和 HTTP 完全一样**的那套
    路由/中间件/鉴权，所以桥和网页版的行为天然一致（不需要维护第二份接口实现）。
    """
    if _LOCAL["client"] is not None:
        return _LOCAL["client"]
    with _BRIDGE_LOCK:
        if _LOCAL["client"] is not None:
            return _LOCAL["client"]
        app = _LOCAL["app"] or init_app(root, root / "www", STATE["token"])
        loop = asyncio.new_event_loop()
        threading.Thread(target=loop.run_forever, name="novelapp-asgi", daemon=True).start()
        _LOCAL["loop"] = loop
        import httpx
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                   base_url="http://ondevice",
                                   timeout=httpx.Timeout(600.0))
        _LOCAL["client"] = client
        try:                                     # 本机自动登录：拿 local_token 换会话 cookie
            r = _run(client.post("/api/app/login", json={"token": STATE["token"]}))
            _log(root, "桥内自动登录：%s" % r.status_code)
        except Exception as e:
            _log(root, "桥内自动登录失败：%r" % (e,))
        return client


def bridge_call(method: str = "GET", path: str = "", body: str = "") -> str:
    """Java 的 `@JavascriptInterface` 调这个函数。返回 JSON 字符串：

        {"status": 200, "body": "<接口原始返回体>", "error": ""}

    `status` 为 0 表示这次调用根本没跑起来（返回体里的 error 是人话）。
    """
    root = Path(STATE["root"] or ".")
    if not path:
        return json.dumps({"status": 0, "body": "", "error": "没给路径"}, ensure_ascii=False)
    p = path if path.startswith("/") else "/" + path
    try:
        client = _ensure_client(root)
        headers = {}
        content = None
        if body:
            content = body.encode("utf-8")
            headers["content-type"] = "application/json"
        r = _run(client.request(method.upper(), p, content=content, headers=headers))
        return json.dumps({"status": r.status_code, "body": r.text, "error": "",
                           "contentType": r.headers.get("content-type", "")},
                          ensure_ascii=False)
    except Exception as e:
        import traceback
        _log(root, "桥调用失败 %s %s：%r\n%s" % (method, p, e, traceback.format_exc()[:1500]))
        return json.dumps({"status": 0, "body": "", "error": str(e)[:300] or "未知错误"},
                          ensure_ascii=False)


def bridge_media_token() -> str:
    cached = STATE.get("mediaToken") or ""
    if cached:
        return cached
    """给 <img>/<audio> 这类**必须走字节流**的请求用的一次性口令。

    它们没法走 JS 桥（桥是同步的、返回字符串），所以仍然从本机 127.0.0.1 取；
    跨源（file:// → http://127.0.0.1）浏览器不带 cookie，就把口令带在 URL 上。
    """
    from server.security import issue_token
    from server import db as dbm
    try:
        d = dbm.db()
        row = d.one("SELECT id FROM user ORDER BY id LIMIT 1")
        if not row:
            return ""
        tok = issue_token(int(row["id"]), "ondevice-media")
        STATE["mediaToken"] = tok
        return tok
    except Exception as e:
        _log(Path(STATE["root"] or "."), "媒体口令签发失败：%r" % (e,))
        return ""


def wait_ready(port: int, timeout: float = 30.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def start(root: str = "", frontend: str = "", port: int = 0,
          seed_dir: str = "") -> str:
    """Java 调这个函数启动后端。返回 JSON 字符串（Java 那边不解析也行，主要是给日志看）。

    失败时 `error` 字段给出人话原因（前端会照着显示），绝不静默。
    """
    root_p = Path(root or os.environ.get("NOVELAPP_ROOT", ".")).resolve()
    front_p = Path(frontend or (root_p / "www")).resolve()
    seed_p = Path(seed_dir) if seed_dir else (root_p / "seed")
    root_p.mkdir(parents=True, exist_ok=True)
    (root_p / "logs").mkdir(parents=True, exist_ok=True)
    try:
        if STATE["port"]:
            return json.dumps({"port": STATE["port"], "token": STATE["token"],
                               "already": True})
        token = STATE["token"] or secrets.token_urlsafe(18)
        STATE.update(token=token, root=str(root_p))
        seeded = seed_if_empty(root_p, seed_p)
        _log(root_p, "seed: %s" % json.dumps(seeded, ensure_ascii=False))
        import uvicorn
        p = port or free_port()
        app = init_app(root_p, front_p, token)      # HTTP 与 JS 桥共用同一个 app
        cfg = uvicorn.Config(app, host="127.0.0.1", port=p, log_level="warning",
                             loop="asyncio", http="h11", access_log=False)
        srv = uvicorn.Server(cfg)
        t = threading.Thread(target=srv.run, name="novelapp-http", daemon=True)
        t.start()
        if not wait_ready(p, 40):
            raise RuntimeError("服务起来了但端口连不上（%d）" % p)
        STATE.update(port=p, startedAt=time.time())
        _log(root_p, "ready on %d（python %s）" % (p, sys.version.split()[0]))
        return json.dumps({"port": p, "token": token, "seeded": seeded,
                           "python": sys.version.split()[0], "root": str(root_p)})
    except Exception as e:
        import traceback
        STATE["error"] = str(e)[:300]
        _log(root_p, "启动失败：%r\n%s" % (e, traceback.format_exc()[:4000]))
        return json.dumps({"error": str(e)[:300]})


def bridge(method: str = "GET", path: str = "", body: str = "") -> str:
    """Java 侧 `ApiBridge` 的唯一入口（也是 App 里前端所有 JSON 接口的落点）。"""
    return bridge_call(method, path, body)


def media_token() -> str:
    return bridge_media_token()


def status() -> str:
    return json.dumps({k: STATE[k] for k in ("port", "token", "error")})


def token() -> str:
    return STATE["token"]


def port() -> int:
    return int(STATE["port"] or 0)
