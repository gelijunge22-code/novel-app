#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""包内版本一致性实测：**打在 APK 里的那套 Python 包，我们到底测过没有？**

为什么要有这一段（第 9 遍打磨加的）：以前打包时只给 pip `--find-links apk/libs`，
pip 还会顺手去 PyPI 挑**更新**的版本 —— 实测装进包的是 fastapi 0.125 / aiohttp 3.10.10 /
propcache 这些东西，而仓库里所有测试跑的是 venv 里那套（fastapi 0.141 / pydantic 2.13）。
**手机上跑的和你测的不是一套**，这句话本身就是个隐患：测全绿也可能装机就崩。

现在两件事一起做：
  1. 打包 `--no-index`，只认 apk/libs（版本钉死）；
  2. 这个脚本用 **APK 里那套纯 Python 依赖 + Python 3.11** 建一个 venv，
     把整份后端跑起来，真打一遍接口（书架/章节/质检/世界/统计/导出）。

能在本机验证的：所有纯 Python 包 + 服务器全部代码路径。
**不能**在本机验证的（如实写进报告）：aiohttp / multidict / yarl / frozenlist 是 Android 原生轮子，
x86_64 的 Linux 上装不了 —— 它们只影响"听书"这条链路，脚本会检查三种 ABI 的轮子都在、
且 APK 里确实带上了对应 .so。

用法：server/venv/bin/python tools/verify_pkg_stack.py
产出：docs/包内版本一致性实测.json
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIBS = ROOT / "apk" / "libs"
APK = ROOT / "apk" / "手机写作台.apk"
OUT = ROOT / "docs/包内版本一致性实测.json"
VENV = Path(tempfile.gettempdir()) / "novelapp-pkgparity"
BUILD_PY = "/home/ubuntu/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11"
ABIS = ("arm64_v8a", "armeabi_v7a", "x86_64")
NATIVE = ("aiohttp", "multidict", "yarl", "frozenlist")
PIN = ["fastapi==0.115.6", "starlette==0.41.3", "uvicorn==0.32.1", "httpx==0.28.1",
       "httpcore==1.0.7", "h11==0.14.0", "anyio==4.7.0", "sniffio==1.3.1", "idna==3.10",
       "certifi==2024.8.30", "click==8.1.7", "typing_extensions==4.12.2",
       "python-multipart==0.0.20", "tabulate==0.9.0", "attrs==24.2.0",
       "aiosignal==1.3.1", "async-timeout==4.0.3", "pydantic==1.10.18"]

rows: list[dict] = []


def rec(name: str, ok: bool, why: str = "") -> None:
    rows.append({"name": name, "ok": bool(ok), "why": str(why)[:400]})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:220]))


def main() -> int:
    print("== 1. apk/libs 里的轮子齐不齐（三种 ABI）==")
    if not LIBS.exists() or not list(LIBS.glob("*.whl")):
        print("  apk/libs 是空的 → 先跑 tools/make_apk_libs.py")
        subprocess.run([sys.executable, str(ROOT / "tools" / "make_apk_libs.py")], check=True)
    names = [p.name for p in LIBS.glob("*.whl")]
    for pkg in NATIVE:
        for abi in ABIS:
            hit = [n for n in names if n.startswith(pkg + "-") and n.endswith(abi + ".whl")]
            rec(f"轮子 {pkg} · {abi}", bool(hit), "缺这个 ABI 的轮子（32 位手机会缺功能）")
    rec("纯 Python 轮子（任何 ABI 都能用）", any("py3-none-any" in n for n in names),
        "一个 py3-none-any 都没有？")

    print("\n== 2. 建一个「和 APK 同一套版本」的 venv（Python 3.11）==")
    if VENV.exists():
        shutil.rmtree(VENV, ignore_errors=True)
    subprocess.run([BUILD_PY, "-m", "venv", str(VENV)], check=True)
    pip = VENV / "bin" / "python"
    # `--no-deps`：aiosignal 声明要 frozenlist，而 frozenlist 只有 Android 原生轮子
    # （x86_64 Linux 装不了）。PIN 里已经把该装的纯 Python 包列全了，所以跳过依赖解析。
    r = subprocess.run([str(pip), "-m", "pip", "install", "-q", "--no-index", "--no-deps",
                        "--find-links", str(LIBS), *PIN],
                       capture_output=True, text=True)
    rec("按 APK 的版本清单装得上（--no-index，只用 apk/libs）", r.returncode == 0,
        (r.stdout + r.stderr)[-300:])
    if r.returncode != 0:
        return write(1)
    got = subprocess.run([str(pip), "-m", "pip", "list", "--format=json"],
                         capture_output=True, text=True).stdout
    # pip list 报的名字可能带下划线（typing_extensions），也可能带连字符（typing-extensions）。
    # 两套写法都要归一化，否则会出现"装进去了却报实际 None"的假红（第 9 遍实测踩到）。
    def _key(n: str) -> str:
        return re.sub(r"[-_.]+", "-", n).lower()
    installed = {_key(p["name"]): p["version"] for p in json.loads(got or "[]")}
    for spec in PIN:
        name, _, ver = spec.partition("==")
        key = _key(name)
        ok = installed.get(key) == ver
        rec(f"装出来的版本对得上：{spec}", ok, f"实际 {installed.get(key)}")
    rec("pydantic 是 1.x（Android 上跑不了 2.x 的编译内核）",
        str(installed.get("pydantic", "")).startswith("1."), installed.get("pydantic"))

    print("\n== 3. 用这套版本把整份后端跑起来，真打一遍接口 ==")
    root = Path(tempfile.mkdtemp(prefix="pkgstack-"))
    (root / "seed").mkdir()
    # 注意：主线程不能就这么结束 —— 后端跑在守护线程里，`-c` 脚本一跑完进程就退了，
    # 端口随即没人听，后面所有请求都是 Connection refused（第 9 遍实测踩到：3 条假红）。
    code = f'''
import sys, json, time
sys.path.insert(0, {str(ROOT)!r})
from server import ondevice
print(ondevice.start(root={str(root)!r}, frontend={str(ROOT / "frontend")!r},
                     seed_dir={str(root / "seed")!r}, port=0), flush=True)
time.sleep(3600)
'''
    proc = subprocess.Popen([str(pip), "-c", code], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, cwd=str(ROOT))
    info, t0, buf = None, time.time(), []
    while time.time() - t0 < 60:
        ln = proc.stdout.readline()          # type: ignore[union-attr]
        if not ln:
            break
        buf.append(ln.strip())
        # 启动信息是一行 JSON；但 stdout 上还可能有别的花括号内容（比如调试输出）。
        # 判据要"这行是个 dict 且有 port"，不能只看它以 { 开头就往下 json.loads 失败当没起来。
        line = ln.strip()
        if line.startswith("{"):
            try:
                cand = json.loads(line)
                if isinstance(cand, dict) and "port" in cand:
                    info = cand
                    break
            except Exception:
                pass
    if not info:
        rec("后端在这套版本下起得来", False, "".join(buf)[-300:] or "60 秒没起来")
        return write(1)
    rec("后端在这套版本下起得来", True, f"python {info.get('python')} port {info.get('port')}")
    port, tok = info["port"], info["token"]
    base = f"http://127.0.0.1:{port}"

    def call(method: str, path: str, body=None, cookie: str = ""):
        req = urllib.request.Request(base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
        if cookie:
            req.add_header("cookie", cookie)
        try:
            r = urllib.request.urlopen(req, timeout=40)
            raw = r.read().decode("utf-8", "ignore")
            try:
                return r.status, json.loads(raw or "{}"), (r.headers.get("set-cookie") or "")
            except Exception:
                return r.status, {"_text": raw[:120]}, (r.headers.get("set-cookie") or "")
        except urllib.error.HTTPError as e:
            return e.code, {"_err": e.read().decode("utf-8", "ignore")[:160]}, ""
        except Exception as e:
            return 0, {"_err": repr(e)}, ""

    st, _, _ = call("GET", "/api/health")
    rec("health", st == 200, st)
    st, b, ck = call("POST", "/api/app/login", {"token": tok})
    rec("本地口令登录（App 里那一步握手）", st == 200 and (b or {}).get("ok"), str(b)[:120])
    st, b, _ = call("POST", "/api/projects", {"title": "包内版本一致性", "kind": "novel"}, ck)
    slug = (b or {}).get("slug") if isinstance(b, dict) else ""
    rec("建书", st == 200 and bool(slug), str(b)[:120])
    if not slug:
        return write(1)
    st, b, _ = call("POST", "/api/import/text",
                    {"slug": slug, "name": "001-第001章-测.md",
                     "text": "他推开门。屋里没有人。\n\n“走。”沈岩说。\n" * 8,
                     "prefix": "manuscript"}, ck)
    rec("导入一章", st == 200, str(b)[:120])
    q = urllib.parse.quote(slug)
    st, b, _ = call("GET", f"/api/book?slug={q}", cookie=ck)
    rec("读回书目", st == 200 and len((b or {}).get("chapters") or []) >= 1, str(b)[:120])
    st, b, _ = call("GET", f"/api/lint/report?slug={q}", cookie=ck)
    rec("质检报告（本地跑规则，不联网）", st == 200 and "book" in (b or {}), str(b)[:120])
    st, b, _ = call("GET", "/api/lint/rules", cookie=ck)
    rec("规则表读得到（≥300 条）", st == 200 and int((b or {}).get("count") or 0) >= 300,
        str((b or {}).get("count")))
    st, b, _ = call("GET", "/api/stats/book?slug=" + q, cookie=ck)
    rec("统计", st == 200, str(b)[:120])
    st, b, _ = call("GET", f"/api/world/overview?slug={q}", cookie=ck)
    rec("世界引擎", st == 200, str(b)[:120])
    st, b, raw = call("GET", f"/api/export/markdown?slug={q}", cookie=ck)
    rec("导出 Markdown", st == 200, str(b)[:80])
    st, b, _ = call("GET", "/api/app/version", cookie=ck)
    rec("版本接口", st == 200, str(b)[:120])

    print("\n== 4. APK 里带了三种 ABI 的 .so 吗（有包才查）==")
    if APK.exists():
        import zipfile
        with zipfile.ZipFile(APK) as z:
            libs = [n for n in z.namelist() if n.startswith("lib/")]
        for abi in ABIS:
            n = len([x for x in libs if x.startswith("lib/" + abi + "/")])
            rec(f"APK 里有 lib/{abi}/（{n} 个 .so）", n > 0, "这个 ABI 没打进去")
    else:
        rec("APK 存在（跳过 .so 检查）", False, str(APK))

    proc.terminate()
    shutil.rmtree(root, ignore_errors=True)
    return write(0)


def write(rc: int) -> int:
    ok = sum(1 for r in rows if r["ok"])
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(rows), "passed": ok,
        "failed": len(rows) - ok,
        "note": "本机验证不了 aiohttp/multidict/yarl/frozenlist（Android 原生轮子，x86_64 Linux 装不了）；"
                "它们只影响听书链路，脚本已验证三种 ABI 的轮子齐全且打进了 APK",
        "items": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 包内版本一致性：{ok}/{len(rows)} ===")
    print("报告：docs/包内版本一致性实测.json")
    return rc if ok == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
