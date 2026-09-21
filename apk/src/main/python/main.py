# -*- coding: utf-8 -*-
"""手机内 Python 的入口。Chaquopy 从 `main` 模块进来，Java 调 start()。"""
from server import ondevice


def start(root: str, frontend: str, seed: str, port: int = 0) -> str:
    return ondevice.start(root=root, frontend=frontend, seed_dir=seed, port=port)


def status() -> str:
    return ondevice.status()


def token() -> str:
    return ondevice.token()


def port() -> int:
    return ondevice.port()


def bridge(method: str, path: str, body: str = "") -> str:
    """Java 的 @JavascriptInterface 调这个：进程内跑接口，不走 HTTP、不开端口。"""
    return ondevice.bridge(method, path, body)


def mediaToken() -> str:
    """给 <img>/<audio> 这类必须走字节流的请求用的口令（跨源拿不到 cookie）。"""
    return ondevice.media_token()
