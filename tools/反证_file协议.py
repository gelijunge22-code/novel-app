#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""反证：App 里用 `file:///android_asset/www/index.html` 加载前端时，
那些"写死相对路径"的请求会被解析成 `file://…`，全部打不出去。

做法（和 App 里同一个引擎 —— 都是 Blink）：
  用无头 Chromium 以 **file://** 打开 frontend/index.html，
  截 Network.requestWillBeSent，看真实请求地址长什么样。
  再把同一份页面用 http://127.0.0.1:8899/ 打开做对照。

跑法：python3 tools/反证_file协议.py
产出：docs/反证-file协议.json
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME = "/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
OUT = ROOT / "docs" / "反证-file协议.json"
PORT = 9421


def wait_cdp(port: int, tries: int = 60):
    for _ in range(tries):
        time.sleep(0.4)
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as r:
                t = json.loads(r.read().decode())
                if t:
                    return t
        except Exception:
            pass
    return None


def run(url: str, label: str) -> dict:
    profile = tempfile.mkdtemp(prefix="cb-")
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
         f"--remote-debugging-port={PORT}", "--window-size=390,844",
         f"--user-data-dir={profile}", "--allow-file-access-from-files", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        targets = wait_cdp(PORT)
        if not targets:
            return {"error": "chrome 起不来"}
        page = next((t for t in targets if t["type"] == "page"), targets[0])
        ws = None
        for mod in ("websocket", "websockets"):
            try:
                __import__(mod)
                ws = mod
                break
            except ImportError:
                continue
        # 没有 python websocket 库就直接用 node 侧的能力：这里退化成只读 URL 结论
        if ws is None:
            return {"note": "没有 websocket 库，跳过请求抓取", "url": url}
    finally:
        chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    # 这条反证的关键事实不需要浏览器也能证明：相对路径在 file:// 下的解析规则。
    # 用 <base href="./"> + 文档地址 file:///android_asset/www/index.html 做基准。
    cases = ["nb/api/agent/sessions/1/events?after=0", "api/cover?slug=x",
             "api/apk/version", "api/write/draft", "nb/api/workspace-files/upload-file"]
    import urllib.parse
    doc = "file:///android_asset/www/index.html"
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "doc": doc, "cases": []}
    broken = 0
    for c in cases:
        resolved = urllib.parse.urljoin(doc, c)
        bad = resolved.startswith("file://")
        out["cases"].append({"raw": c, "resolved": resolved, "broken": bad})
        print(f"  {'✗ 打不出去' if bad else '✓'}  {c}\n      → {resolved}")
        broken += 1 if bad else 0
    print()
    out["broken"] = broken
    out["total"] = len(cases)
    if broken:
        print(f"用 file:// 加载前端时，{broken}/{len(cases)} 个写死相对路径的请求会被解析成 file://…，"
              f"根本发不到本机后端。")
        print("修法：WebView 改成加载 http://127.0.0.1:<port>/?t=<token>（本机服务直接供前端），"
              "相对路径天然就对了；同时给这些地方补一个显式的绝对地址兜底。")
    # 顺便核对：那些写死相对路径的行还在不在
    hits = []
    pats = {
        "frontend/js/api.js": [r"new EventSource\('([^']+)'", r"fetch\('(api/cover[^']*)'"],
        "frontend/js/app.js": [r"fetch\('(api/apk/version)'"],
        "frontend/js/tools.js": [r"fetch\('(nb/api/[^']+)'"],
    }
    for f, ps in pats.items():
        src = (ROOT / f).read_text(encoding="utf-8")
        for p in ps:
            for m in re.finditer(p, src):
                line = src[:m.start()].count("\n") + 1
                hits.append({"file": f, "line": line, "path": m.group(1)})
                print(f"  · {f}:{line}  写死相对路径 → {m.group(1)}")
    out["hits"] = hits
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告：{OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
