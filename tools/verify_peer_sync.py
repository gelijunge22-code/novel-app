#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对端同步实测（GOAL C2 剩下那半）——**两个真实例**之间跑，不 mock。

布局：
    「服务器」  起在 127.0.0.1:8898，自己的数据目录（= 电脑上那台）
    「手机」    就是本机这套服务（127.0.0.1:8899）+ 它自己的数据目录（= App 里那份后端）
两端跑的是**同一套后端代码**，协议就是 `/api/sync/*`（那套已经有 18 条冲突实测）。

验的事：
  ① 手机上没有这本书 → 从服务器拉下来（章节真的落了盘）
  ② 增量：再拉一次，没变的东西不重复拉
  ③ 手机上改一章 → 推给服务器 → 服务器上真的是新版
  ④ 两边都改同一章 → 推上去报 conflict，**服务器一个字节没动**，两份正文都在手机里
  ⑤ 「两边都改」时拉下来也报 conflict（不是硬盖）
  ⑥ 挑「用服务器那版」→ 手机变成服务器那版，然后能推回去
  ⑦ 挑「我合并的」→ 手机变成合并稿，推回去服务器也变
  ⑧ 全程留痕：peer_log 有记录、peer_state 有"同步到哪儿了"
  ⑨ 断网（对端地址不通）时给中文人话，不是 500 堆栈

跑法：server/venv/bin/python tools/verify_peer_sync.py
产出：docs/对端同步实测.json
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path("/home/ubuntu/novel-app")
PKG = ROOT / "apk" / "src" / "main" / "python"   # APK 里那份后端源码（和 ondevice_sim 同一份）
PY = ROOT / "server" / "venv" / "bin" / "python"
OUT = ROOT / "docs/对端同步实测.json"
LOCAL = "http://127.0.0.1:8899"
PEER_PORT = 8898
rows: list[dict] = []


def check(name, ok, why=""):
    rows.append({"name": name, "ok": bool(ok), "why": str(why)[:400]})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:220]))
    return bool(ok)


def pw() -> str:
    return json.loads(Path("/home/ubuntu/nbapp/config.json").read_text())["app_password"]


class C:
    """极简客户端（带 cookie 会话）。"""

    def __init__(self, base: str):
        self.base = base
        self.cookie = ""

    def call(self, path, method="GET", body=None, timeout=60):
        # 踩过的坑：urllib 的请求行按 ascii 编码，路径里带中文（书名 slug）会直接
        # UnicodeEncodeError（不是服务端的锅）。这里统一转义一次。
        url = self.base + urllib.parse.quote(path, safe="/?&=%:")
        data = json.dumps(body).encode() if body is not None else None
        h = {"accept": "application/json"}
        if data:
            h["content-type"] = "application/json"
        if self.cookie:
            h["cookie"] = self.cookie
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
                sc = r.headers.get_all("set-cookie") or []
                if sc:
                    self.cookie = "; ".join(c.split(";")[0] for c in sc)
                return r.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"detail": raw[:200]}
        except Exception as e:
            return 0, {"detail": repr(e)}


def start_peer(root: Path, seed: Path, port: int) -> dict:
    code = ("import sys, json, time;sys.path.insert(0, %r);import main;"
            "print('RESULT=' + main.start(%r, %r, %r, %d), flush=True);time.sleep(10**7)"
            % (str(PKG), str(root), str(root / "www"), str(seed), port))
    env = dict(os.environ)
    env.update({"PYTHONUTF8": "1", "PYTHONPATH": str(PKG),
                # 这台"服务器"的管理员口令就用本机那串，方便手机这边用口令登录（真机上就是用户填的口令）
                "NOVELAPP_INIT_PASSWORD": pw()})
    env.pop("NOVELAPP_CONFIG", None)
    p = subprocess.Popen([str(PY), "-c", code], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, env=env, cwd=str(ROOT))
    buf: list[str] = []

    def drain():
        for ln in p.stdout:            # type: ignore[union-attr]
            buf.append(ln)

    threading.Thread(target=drain, daemon=True).start()
    info, t0 = None, time.time()
    while time.time() - t0 < 90:
        for ln in list(buf):
            if ln.startswith("RESULT="):
                info = json.loads(ln[7:].strip())
                break
        if info:
            break
        time.sleep(0.2)
    if not info:
        raise RuntimeError("对端起不来：" + "".join(buf)[-800:])
    return {"proc": p, "info": info, "log": buf}


def make_chapters(c: C, slug: str, pairs):
    for name, text in pairs:
        st, d = c.call("/api/import/text", "POST", {"slug": slug, "name": name, "text": text})
        if st != 200:
            print("    （建章失败 HTTP %s %s）" % (st, str(d)[:120]))


def main() -> int:
    # 对端"服务器"跑的是**包内那份后端副本**（apk/src/main/python/server）。
    # 不先刷新它，测的就是"上次打包那一刻"的代码 —— 第 9 遍打磨真被这条坑过：
    # 改了 store.py 没打包，对端还是旧模板，于是"同一章两边内容不同"这种假红冒出来。
    rc = subprocess.call([str(PY), str(ROOT / "tools/sync_pkg.py"), "--backend"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    print("刷新包内后端副本：%s" % ("ok" if rc == 0 else "失败(rc=%d)" % rc))
    seed = Path(tempfile.mkdtemp(prefix="peer-seed-"))
    server_dir = Path(tempfile.mkdtemp(prefix="peer-server-"))
    (seed / "empty").mkdir(parents=True, exist_ok=True)
    print("起「服务器」（127.0.0.1:%d，自己的数据目录）…" % PEER_PORT)
    srv = start_peer(server_dir, seed, PEER_PORT)
    srv_c = C("http://127.0.0.1:%d" % PEER_PORT)
    # 新起的那台实例用它自己的本地口令登录（= App 首次启动时前端做的那次握手）
    st_l, _ = srv_c.call("/api/app/login", "POST", {"token": srv["info"]["token"]})
    print("  （对端登录 HTTP %s，本地口令 %s）" % (st_l, "有" if srv["info"].get("token") else "无"))
    machine = C(LOCAL)
    machine.call("/api/app/login", "POST", {"password": pw()})

    TITLE = "对端同步自测-" + str(int(time.time()))[-6:]
    st, born = srv_c.call("/api/projects", "POST", {"title": TITLE, "summary": "对端同步用", "kind": "novel"})
    slug = (born or {}).get("projectRoot") or (born or {}).get("slug")
    check("① 准备：服务器上先有这本书", st == 200 and bool(slug), f"HTTP {st} {slug}")
    make_chapters(srv_c, slug, [("第001章-服务器写的", "服务器版第一章。\n" * 20),
                                ("第002章-服务器写的", "服务器版第二章。\n" * 20)])
    srv_ch = [c["path"] for c in (srv_c.call("/api/book?slug=" + str(slug), "GET")[1] or {}).get("chapters", [])]
    # 建书时后端会自动给一章「第001章-未命名」（用户点进去就能写），所以这里是 2+1=3 章
    check("①b 服务器上有 2 章正文 + 自带的空白章",
          len([x for x in srv_ch if "服务器写的" in x]) == 2 and len(srv_ch) == 3, srv_ch)

    # ① 拉下来
    st, r = machine.call("/api/peer/sync", "POST",
                         {"slug": slug, "base": "http://127.0.0.1:%d" % PEER_PORT,
                          "password": pw(), "direction": "pull"})
    got = machine.call("/api/book?slug=" + slug, "GET")[1] or {}
    mine = [c["name"] for c in (got.get("chapters") or [])]
    check("② 手机上还没有这本书 → 先照服务器建一本，再把章节拉下来（真的落盘）",
          st == 200 and len(mine) == 3 and any("服务器写的" in n for n in mine),
          json.dumps({"http": st, "chapters": mine, "r": r}, ensure_ascii=False)[:260])
    # 这条以前是假绿：本地建书时会自带一个空白章（和第001章-未命名 同名），
    # 那条 path 的 `&since=` 带上了本地 mtime —— 而 mtime_ms 当时返回 float，
    # 服务器收到 "1789830488685.0" 判 422，于是"1 章没取到"，而断言只看章节数，正好漏过。
    pl = (r.get("pull") or {})
    if pl.get("conflicts"):
        # 有冲突就把"到底是哪一条"一起打出来（第 9 遍打磨：只报个数字排查起来要命）
        cf = machine.call("/api/peer/conflicts?slug=" + urllib.parse.quote(str(slug)), "GET")[1]
        pl["conflictPaths"] = [x.get("path") for x in ((cf or {}).get("items") or [])]
    check("②b 一章都没漏（拉下 + 本来就一样 = 服务器上的章数，且 0 错误 0 冲突）",
          pl.get("errors") == 0 and pl.get("conflicts") == 0
          and (pl.get("pulled", 0) + pl.get("unchanged", 0)) == pl.get("serverHas"),
          json.dumps(pl, ensure_ascii=False)[:500])

    # ② 增量
    st, r2 = machine.call("/api/peer/sync", "POST",
                          {"slug": slug, "base": "http://127.0.0.1:%d" % PEER_PORT,
                           "password": pw(), "direction": "pull"})
    check("③ 再拉一次是增量的（没变的不重复拉）",
          st == 200 and (r2.get("pull") or {}).get("pulled") == 0,
          json.dumps((r2 or {}).get("pull"), ensure_ascii=False)[:200])

    p1 = (got.get("chapters") or [{}])[0].get("path")
    # ③ 手机改了推上去
    machine.call("/api/chapter", "PUT", {"slug": slug, "path": p1,
                                         "content": "手机改过的第一章。\n" * 30})
    st, r3 = machine.call("/api/peer/sync", "POST",
                          {"slug": slug, "base": "http://127.0.0.1:%d" % PEER_PORT,
                           "password": pw(), "direction": "push"})
    srv_txt = (srv_c.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    check("④ 手机上改一章 → 推给服务器 → 服务器上确实是新版",
          st == 200 and "手机改过" in srv_txt, json.dumps(r3, ensure_ascii=False)[:200])

    # ④ 两边都改 → 冲突（推）
    machine.call("/api/chapter", "PUT", {"slug": slug, "path": p1,
                                         "content": "手机又改了一版。\n" * 30})
    srv_c.call("/api/chapter", "PUT", {"slug": slug, "path": p1,
                                       "content": "服务器也改了。\n" * 30})
    before = (srv_c.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    st, r4 = machine.call("/api/peer/sync", "POST",
                          {"slug": slug, "base": "http://127.0.0.1:%d" % PEER_PORT,
                           "password": pw(), "direction": "push"})
    after = (srv_c.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    check("⑤ 两边都改过 → 报冲突，服务器那版一个字节没动",
          st == 200 and (r4.get("push") or {}).get("conflicts", 0) >= 1 and before == after,
          json.dumps({"conflicts": (r4.get("push") or {}).get("conflicts"),
                      "serverUnchanged": before == after}, ensure_ascii=False))

    st, cl = machine.call("/api/peer/conflicts?slug=" + slug, "GET")
    items = (cl or {}).get("items") or []
    check("⑤b 冲突列在手机这边（能点进去看两版）", len(items) >= 1, json.dumps(items)[:200])
    cid = items[0]["id"] if items else 0
    st, detail = machine.call("/api/peer/conflict?id=%d" % cid, "GET")
    check("⑤c 冲突详情：两版正文都在",
          st == 200 and len((detail or {}).get("localText") or "") > 0
          and len((detail or {}).get("serverText") or "") > 0,
          f"local {len((detail or {}).get('localText') or '')} 字 / server {(detail or {}).get('serverText') and len(detail['serverText'])} 字")

    # ⑤ 拉的时候也报冲突
    srv_c.call("/api/chapter", "PUT", {"slug": slug, "path": p1, "content": "服务器第三次改。\n" * 20})
    st, r5 = machine.call("/api/peer/sync", "POST",
                          {"slug": slug, "base": "http://127.0.0.1:%d" % PEER_PORT,
                           "password": pw(), "direction": "pull"})
    check("⑥ 两边都改过时**拉**也报冲突（不硬盖手机上的改动）",
          st == 200 and (r5.get("pull") or {}).get("conflicts", 0) >= 1,
          json.dumps((r5 or {}).get("pull"), ensure_ascii=False)[:200])

    # ⑥ 挑服务器那版
    # 注意（这里踩过一次坑）：同一条 path 在 ⑤/⑥ 里**造过不止一条**冲突 ——
    # 只挑 items[0] 会漏掉另一条，那条作废的正文还留在服务器上，
    # 后面 ⑧ 断言"服务器 == 合并稿"就会红。所以先按 path 把这一章的冲突**全部**挑完。
    st, rc = machine.call("/api/peer/conflicts?slug=" + slug, "GET")
    cand2 = [c for c in ((rc or {}).get("items") or []) if c.get("path") == p1]
    st, res = 0, {}
    for c in cand2:
        st, res = machine.call("/api/peer/resolve", "POST",
                               {"id": c["id"], "pick": "server",
                                "base": "http://127.0.0.1:%d" % PEER_PORT, "password": pw()})
    local_after = (machine.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    srv_now = (srv_c.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    check("⑦ 挑「用服务器那版」→ 手机变成服务器那版（逐字节一样），并推了回去",
          st == 200 and local_after == srv_now and "服务器第三次改" in local_after,
          json.dumps({"res": res, "same": local_after == srv_now,
                      "条数": len(cand2)}, ensure_ascii=False)[:260])

    # ⑦ 挑合并稿
    machine.call("/api/chapter", "PUT", {"slug": slug, "path": p1, "content": "手机这版\n" * 20})
    srv_c.call("/api/chapter", "PUT", {"slug": slug, "path": p1, "content": "服务器这版\n" * 20})
    machine.call("/api/peer/sync", "POST", {"slug": slug, "base": "http://127.0.0.1:%d" % PEER_PORT,
                                           "password": pw(), "direction": "push"})
    st, rc = machine.call("/api/peer/conflicts?slug=" + slug, "GET")
    cand = [c for c in ((rc or {}).get("items") or []) if c.get("path") == p1]
    merged = "合并稿：手机的先，服务器的话在后。\n" * 10
    st, res3 = 0, {}
    for c in cand:                      # 同一条 path 有几条就挑几条（⑦ 已经把上一步的清干净了）
        st, res3 = machine.call("/api/peer/resolve", "POST",
                                {"id": c["id"], "pick": "merged", "text": merged,
                                 "base": "http://127.0.0.1:%d" % PEER_PORT, "password": pw()})
    local_m = (machine.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    srv_m = (srv_c.call("/api/chapter?slug=%s&path=%s" % (slug, p1), "GET")[1] or {}).get("content", "")
    check("⑧ 挑「我合并的」→ 手机是合并稿，服务器也跟着变了",
          st == 200 and len(cand) >= 1 and local_m == merged and srv_m == merged,
          json.dumps({"条数": len(cand), "same": local_m == merged, "serverSame": srv_m == merged},
                     ensure_ascii=False))

    st, state = machine.call("/api/peer/state?slug=" + slug, "GET")
    check("⑨ 留痕：记着「跟谁同步到哪儿了」",
          st == 200 and (state or {}).get("last_time", 0) > 0 and "推上" in ((state or {}).get("last_result") or ""),
          json.dumps(state, ensure_ascii=False)[:200])

    # ⑨ 对端不可达 → 中文人话
    st, bad = machine.call("/api/peer/sync", "POST",
                           {"slug": slug, "base": "http://127.0.0.1:9", "password": pw(),
                            "direction": "pull"})
    check("⑩ 服务器地址不通 → 中文人话（不是 500 堆栈）",
          st == 502 and "连不上" in str((bad or {}).get("detail")),
          f"HTTP {st} {str((bad or {}).get('detail'))[:120]}")

    # ── 从没同步过就点「推」：服务器那版**不许被静默盖掉** ──
    # 场景：换机 / 两边各建过同名书 —— 本机这条从来没有"基准"（base=0）。
    # 服务端的判据是 `not force and base and cur and abs(cur-base)>2`：base=0 直接短路，
    # 于是**服务器上的正文会被本机这版覆盖**，两边的稿子都丢了。
    T2 = "同步前推自测-" + str(int(time.time()))[-6:]
    st_p, born_p = machine.call("/api/projects", "POST", {"title": T2, "summary": "两边各建过", "kind": "novel"})
    st_s, born_s = srv_c.call("/api/projects", "POST", {"title": T2, "summary": "两边各建过", "kind": "novel"})
    slug2 = (born_p or {}).get("slug") or (born_p or {}).get("projectRoot")
    slug_s2 = (born_s or {}).get("slug") or (born_s or {}).get("projectRoot")
    same_slug = bool(slug2) and slug2 == slug_s2
    pth2 = "manuscript/第001章-未命名.md"
    srv_c.call("/api/chapter", "PUT", {"slug": slug_s2, "path": pth2,
                                       "content": "服务器这边先写好的。\n" * 20})
    machine.call("/api/chapter", "PUT", {"slug": slug2, "path": pth2,
                                         "content": "手机上这边写的。\n" * 20})
    st, r6 = machine.call("/api/peer/sync", "POST",
                          {"slug": slug2, "base": "http://127.0.0.1:%d" % PEER_PORT,
                           "password": pw(), "direction": "push"})
    srv_after2 = (srv_c.call("/api/chapter?slug=%s&path=%s" % (slug_s2, pth2), "GET")[1] or {}).get("content", "")
    check("⑯ 从没同步过就点「推」→ 服务器那版没被静默盖掉（报冲突，两份都留）",
          same_slug and st == 200 and (r6.get("push") or {}).get("conflicts", 0) >= 1
          and (r6.get("push") or {}).get("preflight", 0) == 1
          and "服务器这边先写好的" in srv_after2,
          json.dumps({"slug 相同": same_slug, "http": st,
                      "push": {k: v for k, v in (r6.get("push") or {}).items() if k != "results"},
                      "服务器还是原文": "服务器这边先写好的" in srv_after2}, ensure_ascii=False)[:320])
    machine.call("/api/projects/item?projectRoot=" + str(slug2), "DELETE")
    srv_c.call("/api/projects/item?projectRoot=" + str(slug_s2), "DELETE")

    # ── 反方向：手机上有、服务器上没有 → 点「推」应该把整本书建到服务器上 ──
    # （`/api/sync/push` 第一步就是 `require_book`，服务器上没这本书直接 404 ——
    #  用户心里的模型是"我在手机上写的书，推上去"，不是"服务器上得先有它"。）
    T3 = "整本推自测-" + str(int(time.time()))[-6:]
    st_p3, born_p3 = machine.call("/api/projects", "POST", {"title": T3, "summary": "整本推", "kind": "novel"})
    slug3 = (born_p3 or {}).get("slug") or (born_p3 or {}).get("projectRoot")
    make_chapters(machine, slug3,
                  [("第%03d章-整本推" % i, ("手机上写的第 %d 章。" + chr(10)) * 20)
                   for i in range(1, 4)])
    st_gone, _ = srv_c.call("/api/book?slug=" + str(slug3), "GET")
    st, r7 = machine.call("/api/peer/sync", "POST",
                          {"slug": slug3, "base": "http://127.0.0.1:%d" % PEER_PORT,
                           "password": pw(), "direction": "push"})
    srv_bk = srv_c.call("/api/book?slug=" + str(slug3), "GET")[1] or {}
    srv_paths3 = [c["path"] for c in (srv_bk.get("chapters") or [])]
    bodies = [(srv_c.call("/api/chapter?slug=%s&path=%s" % (slug3, pth), "GET")[1] or {}).get("content", "")
              for pth in srv_paths3]
    check("⑰ 手机上有、服务器上没有 → 点「推」把整本书建到服务器上，正文真的在",
          st_gone in (404, 400) and st == 200 and len(srv_paths3) == 4
          and sum(1 for b in bodies if "手机上写的第" in b) == 3
          # 4 章里那章"服务器自动生成的空白章"两边内容一样 → 服务端回 unchanged，算正常
          and ((r7.get("push") or {}).get("pushed", 0)
               + (r7.get("push") or {}).get("unchanged", 0)) == 4,
          json.dumps({"服务器原先": st_gone, "http": st, "服务器现在几章": len(srv_paths3),
                      "push": {k: v for k, v in (r7.get("push") or {}).items() if k != "results"}},
                     ensure_ascii=False)[:300])
    machine.call("/api/projects/item?projectRoot=" + str(slug3), "DELETE")
    srv_c.call("/api/projects/item?projectRoot=" + str(slug3), "DELETE")

    # ── 长书：超过"一趟最多处理多少章"的上限，剩下的**必须下次还能拉到** ──
    # 旧写法一趟只处理 50 条，却把 last_time 直接推到服务器当前时间 ——
    # 多出来的章 mtime 比它小，下次 `mtime_ms > since` 再也筛不到：**静默丢章**。
    BIG = "对端长书自测-" + str(int(time.time()))[-6:]
    st, born2 = srv_c.call("/api/projects", "POST", {"title": BIG, "summary": "长书", "kind": "novel"})
    big = (born2 or {}).get("projectRoot") or (born2 or {}).get("slug")
    make_chapters(srv_c, big, [("第%03d章-长书" % i, ("第 %d 章正文。\n" % i) * 30)
                               for i in range(1, 71)])          # 70 章 + 自带的空白章 = 71
    t_pull = time.time()
    st, rbig = machine.call("/api/peer/sync", "POST",
                            {"slug": big, "base": "http://127.0.0.1:%d" % PEER_PORT,
                             "password": pw(), "direction": "pull"})
    pull_secs = round(time.time() - t_pull, 2)
    got_big = machine.call("/api/book?slug=" + str(big), "GET")[1] or {}
    names_big = [c["name"] for c in (got_big.get("chapters") or [])]
    srv_names = [c["path"] for c in (srv_c.call("/api/book?slug=" + str(big), "GET")[1] or {}).get("chapters", [])]
    check("⑫ 长书（71 章）一次对账全拉到本机（超上限的不会静默丢），且耗时在谱上",
          st == 200 and len(names_big) == len(srv_names)
          and (rbig.get("pull") or {}).get("more", 0) == 0 and pull_secs < 60,
          json.dumps({"http": st, "本机": len(names_big), "服务器": len(srv_names),
                      "耗时秒": pull_secs, "pull": (rbig.get("pull") or {})},
                     ensure_ascii=False)[:300])

    # 再点一次：不该重复拉（增量），也不该重复报同一批冲突
    st, rbig2 = machine.call("/api/peer/sync", "POST",
                             {"slug": big, "base": "http://127.0.0.1:%d" % PEER_PORT,
                              "password": pw(), "direction": "pull"})
    check("⑬ 再对一次是增量的（长书也一样：0 章要拉）",
          st == 200 and (rbig2.get("pull") or {}).get("pulled") == 0,
          json.dumps((rbig2 or {}).get("pull"), ensure_ascii=False)[:240])

    # ── 同一条冲突不该越点越多 ──
    # 两边都改第 1 章 → 报 1 条冲突；不改任何东西再点两次 → 还是 1 条。
    pth = names_big and (got_big.get("chapters") or [{}])[0].get("path")
    machine.call("/api/chapter", "PUT", {"slug": big, "path": pth, "content": "本机改的。\n" * 20})
    srv_c.call("/api/chapter", "PUT", {"slug": big, "path": pth, "content": "服务器改的。\n" * 20})
    for _ in range(3):
        machine.call("/api/peer/sync", "POST",
                     {"slug": big, "base": "http://127.0.0.1:%d" % PEER_PORT,
                      "password": pw(), "direction": "pull"})
    st, cl3 = machine.call("/api/peer/conflicts?slug=" + str(big), "GET")
    same_path = [c for c in ((cl3 or {}).get("items") or []) if c.get("path") == pth]
    check("⑭ 同一条章反复对账 → 只留 1 条待挑的冲突（不是每点一次多一条）",
          len(same_path) == 1, json.dumps((cl3 or {}).get("items"), ensure_ascii=False)[:260])

    # ── 推：70 章一起推（服务器一个请求只收 50 条 → 必须分批） ──
    for i, ch in enumerate(got_big.get("chapters") or []):
        machine.call("/api/chapter", "PUT", {"slug": big, "path": ch["path"],
                                             "content": ("手机上改的第 %d 章。\n" % i) * 20})
    st, rpush = machine.call("/api/peer/sync", "POST",
                             {"slug": big, "base": "http://127.0.0.1:%d" % PEER_PORT,
                              "password": pw(), "direction": "push"})
    srv_txt_ok = 0
    for ch in (srv_c.call("/api/book?slug=" + str(big), "GET")[1] or {}).get("chapters", []):
        body = (srv_c.call("/api/sync/chapter?slug=%s&path=%s"
                           % (big, ch["path"]), "GET")[1] or {}).get("content", "")
        if "手机上改的" in body:
            srv_txt_ok += 1
    # 第 1 章正在冲突（⑭ 里两边都改过、还没挑），它**本来就不该被推**，所以期望是"其余全变"
    stc, clx = machine.call("/api/peer/conflicts?slug=" + str(big), "GET")
    conflict_paths = {c.get("path") for c in ((clx or {}).get("items") or [])}
    expect_push = len([c for c in (got_big.get("chapters") or []) if c["path"] not in conflict_paths])
    check("⑮ 70 章一起推 → 服务器那边真的全变了（服务器一个请求只收 50 条，得自己分批）",
          st == 200 and srv_txt_ok == expect_push,
          json.dumps({"http": st, "服务器上变了的章数": srv_txt_ok, "期望": expect_push,
                      "冲突章（故意没推）": sorted(conflict_paths),
                      "本机章数": len(got_big.get("chapters") or []),
                      "push": {k: v for k, v in (rpush.get("push") or {}).items() if k != "results"}},
                     ensure_ascii=False)[:300])
    machine.call("/api/projects/item?projectRoot=" + str(big), "DELETE")
    srv_c.call("/api/projects/item?projectRoot=" + str(big), "DELETE")

    # 收尾：两边的测试书都清掉（走回收站，不硬删）
    machine.call("/api/projects/item?projectRoot=" + slug, "DELETE")
    srv_c.call("/api/projects/item?projectRoot=" + slug, "DELETE")
    gone = machine.call("/api/book?slug=" + slug, "GET")[0] in (404, 400, 422)
    check("⑪ 收尾：两边的自测书都清掉了（手机这边确认没了）", gone, "")

    ok = sum(1 for r in rows if r["ok"])
    OUT.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"),
                               "server": "http://127.0.0.1:%d" % PEER_PORT, "phone": LOCAL,
                               "total": len(rows), "ok": ok, "fail": len(rows) - ok,
                               "items": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n=== 对端同步 %d/%d ===" % (ok, len(rows)))
    print("报告：docs/对端同步实测.json")
    try:
        srv["proc"].kill()
    except Exception:
        pass
    shutil.rmtree(seed, ignore_errors=True)
    shutil.rmtree(server_dir, ignore_errors=True)
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
