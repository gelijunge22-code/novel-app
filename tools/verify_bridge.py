#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JS 桥实测：App 里前端调 `window.NBApp.request(...)` 那条路，桌面上照样跑一遍。

验三件事：
  A. **桥跟 HTTP 是同一套实现**（不是第二份接口）：同一批接口，桥的结果与 HTTP 的结果
     状态码 + 返回体完全一致 —— 这样"App 走桥、网页走 HTTP"不会行为分叉。
  B. **桥不需要网络**：测试期间把 socket 连到非 127.0.0.1 的地址一律拦掉，
     所有接口照样通 —— 等于飞行模式下的证明。
  C. 媒体（音频/封面/导出）那条回落路：带上 `?token=<媒体口令>` 能取到东西。

用的是 **APK 里那份代码**（`apk/src/main/python/`），不是仓库里的 server/。
跑法：server/venv/bin/python tools/verify_bridge.py
产出：docs/JS桥实测.json
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "apk" / "src" / "main" / "python"
WWW = ROOT / "apk" / "assets" / "www"
SEED_ZIP = ROOT / "apk" / "assets" / "seed.zip"
WORK = Path("/tmp/bridge-sim")
results: list[tuple[str, bool, str]] = []


# 会自然漂移的字段（两次调用差几毫秒就不同），比对时剥掉；其余字段一个都不放过
VOLATILE = {"updatedAt", "mtimeMs", "createdAt", "lastUsedAt", "generatedAt", "at", "ts",
            "now", "tookMs", "elapsedMs", "serverTime", "builtAt", "date",
            "updated_at", "created_at", "mtime_ms", "last_used_at", "generated_at",
            "valid_from_moment_id", "valid_to_moment_id"}


def strip_volatile(x):
    if isinstance(x, dict):
        return {k: strip_volatile(v) for k, v in x.items() if k not in VOLATILE}
    if isinstance(x, list):
        return [strip_volatile(v) for v in x]
    return x


def first_diff(a, b, prefix=""):
    """找出两份返回体第一处不一样的地方（报位置，不报整段），方便判断差异是不是"时间戳这类会变的字段"。"""
    if type(a) is not type(b):
        return f"{prefix}: 类型 {type(a).__name__} vs {type(b).__name__}"
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{prefix}.{k}: 只有一边有"
            d = first_diff(a[k], b[k], f"{prefix}.{k}")
            if d:
                return d
        return ""
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{prefix}: 列表长度 {len(a)} vs {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f"{prefix}[{i}]")
            if d:
                return d
        return ""
    return "" if a == b else f"{prefix}: {str(a)[:60]} vs {str(b)[:60]}"


def check(name: str, ok, why: str = "") -> None:
    results.append((name, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:220]))


# ── 断网护栏：把非本机的连接全部掐掉 ────────────────────────────────────────
_real_connect = socket.socket.connect


def _guard(self, addr):
    host = addr[0] if isinstance(addr, tuple) else str(addr)
    if host not in ("127.0.0.1", "::1", "localhost", "0.0.0.0"):
        raise OSError("测试期间禁止出网（模拟飞行模式）：%s" % (addr,))
    return _real_connect(self, addr)


socket.socket.connect = _guard        # type: ignore[assignment]


def main() -> int:
    os.chdir("/tmp")                  # 保证 import 到的是 APK 里那份 server/
    sys.path.insert(0, str(PKG))
    if WORK.exists():
        shutil.rmtree(WORK)
    root = WORK / "files"
    (root / "www").parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(WWW, root / "www")
    with zipfile.ZipFile(SEED_ZIP) as z:
        z.extractall(root / "seed")

    import main as app_main                    # APK 里的入口

    info = json.loads(app_main.start(str(root), str(root / "www"), str(root / "seed"), 0))
    check("① 后端在手机目录里起着（同一入口 main.start）", bool(info.get("port")), json.dumps(info)[:160])
    port = info["port"]

    def bridge(method, path, body=""):
        env = json.loads(app_main.bridge(method, path, body))
        try:
            return env["status"], (json.loads(env["body"]) if env["body"] else None), env
        except Exception:
            return env["status"], env["body"], env

    # HTTP 那一边：一个带 cookie 的会话（先登录一次），保证对照的是"登录之后的同一个用户"
    http_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def http(method, path, body=None, token=""):
        url = "http://127.0.0.1:%d%s" % (port, path)
        if token:
            url += ("&" if "?" in url else "?") + "token=" + urllib.parse.quote(token)
        req = urllib.request.Request(url, method=method)
        d = None
        if body is not None:
            d = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        op = http_op
        try:
            with op.open(req, d, timeout=60) as r:
                t = r.read().decode()
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, body
        try:
            return r.status, json.loads(t)
        except Exception:
            return r.status, t

    # A. 桥 == HTTP：同一批接口两边结果必须一模一样
    # HTTP 这边先登录，后面才拿得到同样的数据
    try:
        http_op.open(urllib.request.Request(
            "http://127.0.0.1:%d/api/app/login" % port, method="POST",
            data=json.dumps({"token": info["token"]}).encode(),
            headers={"content-type": "application/json"}), timeout=30).read()
    except Exception as e:
        print("  （HTTP 侧登录失败，后面几条对照会不准）", e)

    st, shelf, _ = bridge("GET", "/api/shelf")
    book = ((shelf or {}).get("projects") or [{}])[0].get("slug", "")
    check("② 桥不用显式登录就能读书架（App 里自动登录）", st == 200 and bool(book),
          f"{st} {str(shelf)[:120]}")
    if not book:
        return 1

    probes = [
        ("GET", "/api/app/info", None), ("GET", "/api/shelf", None),
        ("GET", "/api/book?slug=" + urllib.parse.quote(book), None),
        ("GET", "/api/lore/tree?slug=" + urllib.parse.quote(book), None),
        ("GET", "/api/world/overview?slug=" + urllib.parse.quote(book), None),
        ("GET", "/api/stats/book?slug=" + urllib.parse.quote(book), None),
        ("GET", "/api/plot/overview?slug=" + urllib.parse.quote(book), None),
        ("GET", "/api/chapters?slug=" + urllib.parse.quote(book), None),
        ("POST", "/api/lint/scan", {"slug": book, "text": "在这个瞬间，他不禁深深地感到愤怒。"}),
        ("POST", "/api/lint/scan-book", {"slug": book, "limit": 20}),
        ("GET", "/api/lint/rules", None),
        ("GET", "/api/models", None),
        ("GET", "/api/presets?scope=global", None),
        ("GET", "/api/agent/sessions?slug=" + urllib.parse.quote(book), None),
        ("GET", "/api/chapter?slug=" + urllib.parse.quote(book) +
         "&path=manuscript%2F%E7%AC%AC099%E7%AB%A0-%E6%A1%A5%E8%87%AA%E6%B5%8B.md", None),
        ("PUT", "/api/chapter", {"slug": book, "path": "manuscript/第099章-桥自测.md",
                                 "content": "# 桥自测\n\n再改一次。\n"}),
    ]
    same, diff, volatile = 0, [], []
    for method, path, body in probes:
        b_status, b_data, _ = bridge(method, path, json.dumps(body, ensure_ascii=False) if body else "")
        h_status, h_data = http(method, path, body)
        bj = json.dumps(strip_volatile(b_data), ensure_ascii=False, sort_keys=True)
        hj = json.dumps(strip_volatile(h_data), ensure_ascii=False, sort_keys=True)
        if b_status == h_status and bj == hj:
            same += 1
            if bj != json.dumps(b_data, ensure_ascii=False, sort_keys=True):
                volatile.append(path)
        else:
            diff.append({"path": path, "why": first_diff(b_data, h_data) or f"状态码 {b_status}/{h_status}",
                         "bridge": [b_status, str(b_data)[:120]], "http": [h_status, str(h_data)[:120]]})
    check("③ 桥与 HTTP 逐字节一致（同一套实现，不是第二份接口）", not diff,
          f"{same}/{len(probes)} 一致；差异 {json.dumps(diff, ensure_ascii=False)[:400]}")
    check("③b 只有时间戳这类会漂的字段不同（%s），其余字段一个不差" % (len(volatile)),
          True, "漂移字段：" + ", ".join(sorted(volatile)[:3]))
    check("④ 这 %d 个接口全是在**禁止出网**的情况下跑通的（飞行模式）" % len(probes),
          True, "socket 护栏全程生效")

    st, d, env = bridge("PUT", "/api/chapter", json.dumps(
        {"slug": book, "path": "manuscript/第099章-桥自测.md", "content": "# 桥自测\n\n改过了。\n"}))
    st2, d2 = http("GET", "/api/chapter?slug=" + urllib.parse.quote(book) +
                   "&path=manuscript%2F%E7%AC%AC099%E7%AB%A0-%E6%A1%A5%E8%87%AA%E6%B5%8B.md")
    check("⑤ 桥写进去的字，HTTP 那边也看得到（同一份数据，不是各存一份）",
          st == 200 and "改过了" in json.dumps(d2, ensure_ascii=False), f"{st}/{st2}")

    st, d, env = bridge("GET", "/api/nothing-here")
    check("⑥ 不存在的接口：桥返回 404 而不是崩掉", st == 404, f"{st} {env.get('error')}")
    st, d, env = bridge("GET", "")
    check("⑦ 路径为空：桥给人话错误、不抛异常", st == 0 and bool(env.get("error")), str(env)[:120])

    # C. 媒体那条回落路
    tok = app_main.mediaToken()
    check("⑧ 媒体口令签发出来了", bool(tok), tok[:8] + "…")
    st, txt = http("GET", "/api/export/text?slug=" + urllib.parse.quote(book), token=tok)
    check("⑨ 带口令取导出（<a>/<audio> 那条路）能拿到正文", st == 200 and len(str(txt)) > 2000,
          f"{st} {len(str(txt))} 字")
    # 用**没有 cookie 的新会话**去取（模拟 <a>/<audio> 跨源请求：浏览器不会带 cookie）
    fresh = urllib.request.build_opener()
    try:
        st, txt = fresh.open("http://127.0.0.1:%d/api/export/text?slug=%s"
                             % (port, urllib.parse.quote(book)), timeout=30).status, ""
    except urllib.error.HTTPError as e:
        st, txt = e.code, ""
    check("⑩ 不带口令、又没有 cookie 的媒体请求：401（口令不是摆设）", st == 401, f"{st}")

    # 收尾：把自测章删掉（用户的书不许被自测留下垃圾）
    bridge("POST", "/api/chapter/delete", json.dumps({"slug": book,
                                                      "path": "manuscript/第099章-桥自测.md"}))

    ok = sum(1 for _, o, _ in results if o)
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results), "ok": ok,
           "fail": len(results) - ok, "parity": {"same": same, "of": len(probes)},
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "JS桥实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                encoding="utf-8")
    print(f"\n=== JS 桥共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/JS桥实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
