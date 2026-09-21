#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设备模拟回归：**拿 APK 里那一份代码**（不是仓库里的 server/）在本机把后端跑起来，
走一遍用户真正会做的事 —— 翻书 / 看设定 / 扫 AI 味 / 看统计 / 建章改章 / 导出 / 备份。

为什么要在桌面上模拟：这台机器没有 KVM，起不了安卓模拟器（见 DONE.md 已知问题）。
所以这里用**尽可能接近真机的方式**验：
  * 代码用的是 `apk/src/main/python/`（APK 里那份 .pyc 的源），入口也是 App 里调的那个 `main.start`
  * 前端用的是 APK 里的 `assets/www`
  * 首启快照用的是 APK 里的 `assets/seed.zip`，解包方式跟 Java 那边同一套规则
  * 数据目录是干净的临时目录，模拟"刚装上 App 的手机"
  * 外网全部走死代理（http_proxy 指向 127.0.0.1:1）—— 等于飞行模式：只有 127.0.0.1 活着

跑法：server/venv/bin/python tools/ondevice_sim.py
产出：docs/设备模拟实测.json
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APK_DIR = ROOT / "apk"
PKG = APK_DIR / "src" / "main" / "python"        # APK 里那份后端源码
WWW = APK_DIR / "assets" / "www"                 # APK 里那份前端
SEED_ZIP = APK_DIR / "assets" / "seed.zip"
PY = ROOT / "server" / "venv" / "bin" / "python"
WORK = Path("/tmp/ondevice-sim")
results: list[tuple[str, bool, str]] = []


def check(name: str, ok, why: str = "") -> None:
    results.append((name, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:220]))


def u(v) -> str:
    return urllib.request.quote(str(v), safe="")


class C:
    """只连本机的客户端。外网被死代理挡住 —— 跟飞行模式一个效果。"""

    def __init__(self, port: int, token: str = ""):
        self.base = "http://127.0.0.1:%d" % port
        self.token = token
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def call(self, path, method="GET", body=None, timeout=90):
        req = urllib.request.Request(self.base + path, method=method)
        d = None
        if body is not None:
            d = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, d, timeout=timeout) as r:
                t = r.read().decode("utf-8", "replace")
                try:
                    return r.status, json.loads(t)
                except Exception:
                    return r.status, t
        except urllib.error.HTTPError as e:
            t = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(t)
            except Exception:
                return e.code, t
        except Exception as e:                       # 连不上/超时也要说清楚
            return 0, repr(e)

    def call_text(self, path, timeout=90):
        req = urllib.request.Request(self.base + path)
        try:
            with self.op.open(req, timeout=timeout) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            return 0, repr(e)


def start_backend(root: Path, seed_dir: Path, port: int = 0) -> dict:
    """起"手机上的"后端：入口就是 App 里调的 main.start。"""
    # 起完之后必须**让这个进程活着**：uvicorn 跑在守护线程上，Python 进程一退服务就没了。
    # 真机上不用管这一步 —— App 的 Java 进程会一直活着，Python 解释器跟着活。
    code = (
        "import sys, json, time;"
        "sys.path.insert(0, %r);"
        "import main;"
        "print('RESULT=' + main.start(%r, %r, %r, %d), flush=True);"
        "time.sleep(10 ** 7)"
        % (str(PKG), str(root), str(root / "www"), str(seed_dir), port)
    )
    env = dict(os.environ)
    env.update({
        "PYTHONUTF8": "1",
        "PYTHONPATH": str(PKG),
        # 死代理 = 外网断掉；本机走 no_proxy
        "http_proxy": "http://127.0.0.1:1", "https_proxy": "http://127.0.0.1:1",
        "HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1",
        "no_proxy": "127.0.0.1,localhost", "NO_PROXY": "127.0.0.1,localhost",
    })
    env.pop("NOVELAPP_CONFIG", None)
    p = subprocess.Popen([str(PY), "-c", code], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, env=env, cwd=str(ROOT))
    # 起完接着读日志，免得管道写满把服务卡住（uvicorn 的告警也在这里）
    logbuf: list[str] = []

    def drain():
        for ln in p.stdout:                       # type: ignore[union-attr]
            logbuf.append(ln)
            if len(logbuf) > 500:
                del logbuf[:200]

    threading.Thread(target=drain, daemon=True).start()
    info = None
    t0 = time.time()
    while time.time() - t0 < 90:
        if logbuf:
            for ln in list(logbuf):
                if ln.startswith("RESULT="):
                    info = json.loads(ln[len("RESULT="):].strip())
                    break
        if info is not None:
            break
        if p.poll() is not None and not logbuf:
            break
        time.sleep(0.2)
    if info is None:
        raise RuntimeError("后端起不来：%s" % "".join(logbuf)[-1500:])
    return {"proc": p, "info": info}


def listener(port: int) -> str:
    """看这个端口只绑在 127.0.0.1 上（不是 0.0.0.0）。"""
    try:
        out = subprocess.run(["ss", "-ltnH"], capture_output=True, text=True, timeout=10).stdout
    except Exception as e:
        return "ss 用不了：%r" % e
    for ln in out.splitlines():
        if ":%d " % port in ln or ln.strip().endswith(":%d" % port):
            return ln.split()[3] if len(ln.split()) > 3 else ln
    return ""


def main() -> int:
    if not SEED_ZIP.exists():
        print("没有 %s：先跑 bash apk/build.sh" % SEED_ZIP)
        return 2
    if WORK.exists():
        shutil.rmtree(WORK)
    root = WORK / "files"                            # 相当于 App 的 filesDir
    (root / "www").parent.mkdir(parents=True, exist_ok=True)

    # 1) 前端：APK 里的 assets/www（Java 那边也是这么拷的）
    shutil.copytree(WWW, root / "www")
    # 2) 快照：APK 里的 seed.zip，按 Java 的规则解开（UTF-8 名、只建不覆盖）
    seed = root / "seed"
    with zipfile.ZipFile(SEED_ZIP) as z:
        z.extractall(seed)
    check("① 准备好「手机里的」目录（前端 18 个文件 + 快照）",
          len(list((root / "www").rglob("*"))) > 15 and any(seed.rglob("*")), "")

    srv = start_backend(root, seed)
    info = srv["info"]
    check("② APK 里那份代码能在本机起服务（App 里的同一入口 main.start）",
          bool(info.get("port")) and not info.get("error"), json.dumps(info, ensure_ascii=False)[:200])
    if not info.get("port"):
        return 1
    port, token = info["port"], info["token"]
    check("③ 快照铺开了（第一次启动才有）", (info.get("seeded") or {}).get("seeded") is True,
          json.dumps(info.get("seeded"), ensure_ascii=False)[:160])
    bind = listener(port)
    check("④ 服务只绑 127.0.0.1（别的 App / 外部连不进来）",
          bind.startswith("127.0.0.1:"), bind or "没在 ss 里看到这个端口")

    c = C(port, token)
    st, d = c.call("/api/app/login", "POST", {"token": token})
    check("⑤ 本机自动登录（手机上不用输密码）", st == 200, f"{st} {str(d)[:120]}")
    book = ""
    st, d = c.call("/api/shelf")
    items = (d or {}).get("projects") or (d or {}).get("items") or []   # /shelf 返回的是 projects
    book = items[0]["slug"] if items else ""
    check("⑥ 书架上有随包带进来的那本书（断网也有得看）", st == 200 and bool(book),
          f"{st} {str(d)[:160]}")

    st, d = c.call("/api/book?slug=%s" % u(book))
    files = (d or {}).get("chapters") or []
    ch = ""
    for f in files:
        pth = f.get("path") if isinstance(f, dict) else f
        if pth and ("manuscript/" in str(pth)):
            ch = str(pth)
            break
    st, d = c.call("/api/chapter?slug=%s&path=%s" % (u(book), u(ch)))
    body = (d or {}).get("content") or ""
    check("⑦ 翻书：中文路径的章节读得出来（正文 >1000 字）", st == 200 and len(body) > 1000,
          f"{st} {ch} {len(body)} 字")

    st, tr = c.call("/api/lore/tree?slug=%s" % u(book))
    n_lore = len(json.dumps(tr, ensure_ascii=False))
    check("⑧ 看设定：设定树读得出来", st == 200 and n_lore > 200, f"{st} {n_lore} 字节")

    st, d = c.call("/api/lint/scan-book", "POST", {"slug": book, "limit": 50})
    chs = (d or {}).get("chapters") or []
    check("⑨ 扫 AI 味：全书扫得出分数（本地规则，不联网不花钱）",
          st == 200 and bool(chs) and isinstance((d or {}).get("score"), int),
          f"{st} {[(x['name'], x['score']) for x in chs][:3]}")

    st, d = c.call("/api/stats/book?slug=%s" % u(book))
    check("⑩ 看统计：有字数/章节数", st == 200 and bool(d), f"{st} {str(d)[:140]}")

    new_ch = "manuscript/第006章-设备自测.md"
    st, d = c.call("/api/chapter/new", "POST",
                   {"slug": book, "path": new_ch, "content": "# 第006章\n\n这是设备模拟里新建的一章。\n"})
    check("⑪ 新建章节（中文文件名）", st == 200, f"{st} {str(d)[:140]}")
    st, d = c.call("/api/chapter", "PUT",
                   {"slug": book, "path": new_ch, "content": "# 第006章\n\n改过之后的内容，中文没问题。\n"})
    st2, d2 = c.call("/api/chapter?slug=%s&path=%s" % (u(book), u(new_ch)))
    check("⑫ 编辑章节：写进去、读回来一致", st == 200 and "改过之后" in ((d2 or {}).get("content") or ""),
          f"{st}/{st2}")

    st, txt = c.call_text("/api/export/text?slug=%s" % u(book))
    check("⑬ 导出整本 TXT（本地导出，不联网）", st == 200 and len(txt) > 3000, f"{st} {len(txt)} 字")
    st, d = c.call("/api/export/bundle?slug=%s" % u(book))
    check("⑭ 导出整包 bundle（备份用）", st == 200 and bool(d), f"{st} {str(d)[:120]}")

    st, d = c.call("/api/backup/create", "POST", {"slug": book})
    st2, l = c.call("/api/backup/list?slug=%s" % u(book))
    check("⑮ 备份：建一份 + 列表里看得到",
          st == 200 and st2 == 200 and bool((l or {}).get("items")), f"{st} {str(d)[:120]}")

    # 第 10 轮新加的四块（声音 / 节奏 / 体检 / 参考书架）都是纯本地统计，
    # 断网必须照样能用 —— 这正是"App 里飞行模式也是全功能"的一部分。
    st, d = c.call("/api/voice/report?slug=%s" % u(book))
    people = (d or {}).get("people") or []
    check("㉑ 扫人物声音：给得出分数与逐人指纹（本地算，不联网）",
          st == 200 and isinstance((d or {}).get("score"), int) and "advice" in (d or {}),
          f"{st} 评分 {(d or {}).get('score')} / 角色 {len(people)}")

    st, d = c.call("/api/pacing/curve?slug=%s" % u(book))
    pts = (d or {}).get("points") or []
    check("㉒ 看节奏曲线：每章一个点 + 走势报警（本地算）",
          st == 200 and len(pts) >= 1 and "arousal" in (pts[0] if pts else {}),
          f"{st} {len(pts)} 章")

    st, d = c.call("/api/consistency/report?slug=%s" % u(book))
    check("㉓ 角色一致性体检：读得出报告（本地算）",
          st == 200 and isinstance((d or {}).get("score"), int),
          f"{st} 评分 {(d or {}).get('score')} / 问题 {len((d or {}).get('issues') or [])}")

    st, d = c.call("/api/refs/item", "POST", {"slug": book, "title": "设备自测摘抄",
                                             "tags": "自测", "text": "断网也要能放参考。"})
    st2, l = c.call("/api/refs?slug=%s" % u(book))
    st3, d3 = c.call("/api/write/preview", "POST",
                     {"slug": book, "path": new_ch, "mode": "continue",
                      "refs": [(d or {}).get("id")]})
    check("㉔ 参考书架：放得进去、列得出来，而且能进写正文的预演提示词",
          st == 200 and st2 == 200 and bool((l or {}).get("items"))
          and st3 == 200 and (d3 or {}).get("hasRefs") is True,
          f"{st}/{st2}/{st3} hasRefs={(d3 or {}).get('hasRefs')}")

    # 断网时"要联网的那一步"必须说人话
    st, d = c.call("/api/write/status?slug=%s" % u(book))
    check("⑯ 没网也没配模型时，写作台开屏就说清楚为什么（不是转圈）",
          st == 200 and (d or {}).get("ready") is False and "模型" in str((d or {}).get("why", "")),
          f"{st} {json.dumps(d, ensure_ascii=False)[:160]}")

    st, d = c.call("/api/config/models/provider", "POST", {
        "name": "假渠道", "baseUrl": "http://127.0.0.1:1", "apiKey": "x",
        "models": [{"id": "dead-model", "name": "死的"}]})
    st2, d2 = c.call("/api/write/continue", "POST",
                     {"slug": book, "path": new_ch, "modelKey": "假渠道/dead-model",
                      "stream": False, "words": 100}, timeout=120)
    msg = json.dumps(d2, ensure_ascii=False)
    chinese = any("\u4e00" <= ch <= "\u9fa5" for ch in msg)
    check("⑰ 模型连不上时给的是中文人话（不是 500/英文栈）",
          st2 in (400, 502, 503) and chinese, f"{st}/{st2} {msg[:200]}")

    # 关掉再起一次：数据还在、快照不再铺
    srv["proc"].terminate()
    try:
        srv["proc"].wait(timeout=20)
    except Exception:
        srv["proc"].kill()
    time.sleep(0.6)
    srv2 = start_backend(root, seed)
    info2 = srv2["info"]
    c2 = C(info2["port"], info2["token"])
    c2.call("/api/app/login", "POST", {"token": info2["token"]})
    st, d = c2.call("/api/chapter?slug=%s&path=%s" % (u(book), u(new_ch)))
    check("⑱ 杀掉进程再起：手机里写的那一章还在（数据是手机上的，不是内存里的）",
          st == 200 and "改过之后" in ((d or {}).get("content") or ""), f"{st}")
    check("⑲ 第二次启动不再重铺快照（不许把用户改过的稿子盖回去）",
          (info2.get("seeded") or {}).get("seeded") is False,
          json.dumps(info2.get("seeded"), ensure_ascii=False)[:160])
    check("⑳ 本地口令每次启动都在（前端能自动登录）", bool(info2.get("token")), "")

    srv2["proc"].terminate()
    try:
        srv2["proc"].wait(timeout=20)
    except Exception:
        srv2["proc"].kill()

    ok = sum(1 for _, o, _ in results if o)
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results), "ok": ok,
           "fail": len(results) - ok, "python": info.get("python"),
           "port": port, "bind": bind,
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "设备模拟实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                    encoding="utf-8")
    print(f"\n=== 设备模拟共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/设备模拟实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
