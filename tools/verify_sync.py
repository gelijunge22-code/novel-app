#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冲突处理实测（docs/11 阶段 23.3「本地改了、服务器也改了怎么办」）。

测的就是用户最怕的那件事：手机上改了、电脑上也改了，会不会有一边被悄悄吃掉。
规矩是 **两边都留、让用户挑**。所以这里逐条验：

  ① 正常推一条 -> 落盘，回了新的 mtime
  ② 内容没变 -> 回 unchanged（不瞎写、不产生多余版本）
  ③ 两边都改过 -> 回 conflict，**服务器上的文件一个字节没动**，两份正文都在
  ④ 冲突落进 /sync/conflicts 清单，并给用户发了一条通知
  ⑤ 挑「用服务器那版」-> 文件变成服务器那版
  ⑥ 挑「我合并的」-> 文件变成合并稿
  ⑦ 章接口（/chapter PUT）带陈旧 expectedMtimeMs -> 409 且带服务器正文（不是一句干巴巴的报错）
  ⑧ 冲突处理完，清单里不再挂 open

用一本自建的一次性书做，跑完删干净；**不碰用户的任何一本书**。
跑法：server/venv/bin/python tools/verify_sync.py
"""
from __future__ import annotations

import json
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
BOOKS = ROOT / "data" / "books"
TRASH = ROOT / "data" / "trash"
STAMP = time.strftime("%m%d-%H%M%S")
SLUG = "zz-sync-%s" % STAMP
results: list[tuple[str, bool, str]] = []


def pw() -> str:
    try:
        return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
                   .get("app_password") or "")
    except Exception:
        return ""


class C:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def call(self, path, method="GET", body=None):
        req = urllib.request.Request(BASE + path, method=method)
        d = None
        if body is not None:
            d = json.dumps(body, ensure_ascii=False).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, d, timeout=120) as r:
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


def u(v) -> str:
    """URL 查询串里的中文（书名 slug 可能是中文）必须转义，否则 urllib 直接抛 UnicodeEncodeError。"""
    return urllib.request.quote(str(v), safe="")


def check(n, ok, why=""):
    results.append((n, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + n + ("" if ok else "   —— " + str(why)[:220]))


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1

    st, d = c.call("/api/book", "POST", {"title": "同步自测 " + STAMP})
    slug = (d or {}).get("slug") or ""
    check("① 建一本自测书", st == 200 and bool(slug), f"{st} {d}")
    if not slug:
        return 1
    path = "manuscript/冲突这一章.md"
    st, d = c.call("/api/chapter/new", "POST",
                   {"slug": slug, "path": path, "content": "第一版：手机上看到的"})
    check("② 建一章", st == 200, f"{st} {d}")
    st, doc = c.call("/api/chapter?slug=%s&path=%s" % (u(slug), u(path)))
    base_mtime = int((doc or {}).get("mtimeMs") or 0)
    check("③ 记住它现在的 mtime", st == 200 and base_mtime > 0, f"{st} {base_mtime}")

    # ① 正常推
    st, d = c.call("/api/sync/push", "POST", {"slug": slug, "items": [
        {"path": path, "content": "第一版：手机上看到的\n手机加了第二行", "baseMtimeMs": base_mtime}]})
    r0 = ((d or {}).get("results") or [{}])[0]
    check("④ 正常推一条：落盘", st == 200 and r0.get("status") == "ok",
          f"{st} {json.dumps(d, ensure_ascii=False)[:200]}")
    mtime2 = int(r0.get("mtimeMs") or 0)

    # ② 内容没变
    st, d = c.call("/api/sync/push", "POST", {"slug": slug, "items": [
        {"path": path, "content": "第一版：手机上看到的\n手机加了第二行", "baseMtimeMs": mtime2}]})
    r0 = ((d or {}).get("results") or [{}])[0]
    check("⑤ 内容没变：回 unchanged（不瞎写）", r0.get("status") == "unchanged",
          json.dumps(d, ensure_ascii=False)[:200])

    # ③ 两边都改：服务器先改
    st, d = c.call("/api/chapter", "PUT", {"slug": slug, "path": path,
                                           "content": "服务器这版：电脑上改的", "force": True})
    check("⑥ 模拟电脑那边也改了", st == 200, f"{st} {d}")
    server_before = (BOOKS / slug / path).read_text("utf-8")

    st, d = c.call("/api/sync/push", "POST", {"slug": slug, "items": [
        {"path": path, "content": "手机这版：在车上写的", "baseMtimeMs": mtime2}]})
    r0 = ((d or {}).get("results") or [{}])[0]
    cid = r0.get("conflictId")
    check("⑦ 两边都改过：判为冲突（不是闷头覆盖）", r0.get("status") == "conflict" and bool(cid),
          json.dumps(d, ensure_ascii=False)[:260])
    after = (BOOKS / slug / path).read_text("utf-8")
    check("⑧ 冲突时服务器文件**一个字节没动**", after == server_before,
          "文件被改了：%r" % after[:60])
    check("⑨ 冲突回包里直接带上服务器那版（手机不用再跑一趟）",
          (r0.get("serverText") or "") == server_before,
          json.dumps(r0, ensure_ascii=False)[:200])

    st, d = c.call("/api/sync/conflicts?slug=%s" % u(slug))
    items = (d or {}).get("items") or []
    check("⑩ 冲突进了清单（能看到、能挑）", st == 200 and len(items) == 1,
          f"{st} {json.dumps(d, ensure_ascii=False)[:200]}")
    st, d = c.call("/api/sync/conflict?id=%s" % cid)
    check("⑪ 冲突详情里两版全文都在",
          st == 200 and "手机这版" in (d or {}).get("localText", "") and
          "服务器这版" in (d or {}).get("serverText", ""),
          f"{st} {json.dumps(d, ensure_ascii=False)[:160]}")

    st, d = c.call("/api/notifications?limit=5")
    hit = [x for x in ((d or {}).get("items") or []) if x.get("kind") == "sync"]
    check("⑫ 给用户发了通知（不声不响才是坑）", st == 200 and bool(hit),
          f"{st} {json.dumps(hit[:1], ensure_ascii=False)[:160]}")

    # ⑤ 用服务器那版
    st, d = c.call("/api/sync/resolve", "POST", {"id": cid, "choice": "server"})
    got = (BOOKS / slug / path).read_text("utf-8")
    check("⑬ 挑「服务器那版」：文件变成服务器那版", st == 200 and got == server_before,
          f"{st} {got[:60]!r}")

    # ⑥ 再制造一次冲突，挑「合并稿」
    st, doc = c.call("/api/chapter?slug=%s&path=%s" % (u(slug), u(path)))
    m3 = int((doc or {}).get("mtimeMs") or 0)
    c.call("/api/chapter", "PUT", {"slug": slug, "path": path, "content": "服务器又改了", "force": True})
    st, d = c.call("/api/sync/push", "POST", {"slug": slug, "items": [
        {"path": path, "content": "手机又改了", "baseMtimeMs": m3}]})
    r0 = ((d or {}).get("results") or [{}])[0]
    cid2 = r0.get("conflictId")
    check("⑭ 再制造一次冲突", r0.get("status") == "conflict", json.dumps(d, ensure_ascii=False)[:200])
    st, d = c.call("/api/sync/resolve", "POST",
                   {"id": cid2, "choice": "merged", "text": "两边合起来的第三版"})
    got = (BOOKS / slug / path).read_text("utf-8")
    check("⑮ 挑「合并稿」：文件变成我给的合并稿",
          st == 200 and got == "两边合起来的第三版", f"{st} {got[:60]!r}")
    # 历史里要能找回被覆盖的那版（write_text 自带快照）
    st, d = c.call("/api/write/history?slug=%s&path=%s" % (u(slug), u(path)))
    check("⑯ 被覆盖的那版仍在历史里（可回退）", st == 200 and len((d or {}).get("items") or []) >= 3,
          f"{st} n={len((d or {}).get('items') or [])}")

    # ⑦ /chapter PUT 的冲突回包
    st, doc = c.call("/api/chapter?slug=%s&path=%s" % (u(slug), u(path)))
    m4 = int((doc or {}).get("mtimeMs") or 0)
    c.call("/api/chapter", "PUT", {"slug": slug, "path": path, "content": "别人改了", "force": True})
    st, d = c.call("/api/chapter", "PUT", {"slug": slug, "path": path, "content": "我这版",
                                           "expectedMtimeMs": m4})
    check("⑰ 章接口带陈旧 mtime：409 + 服务器正文一起给回来",
          st == 409 and (d or {}).get("conflict") is True and
          (d or {}).get("serverText") == "别人改了",
          f"{st} {json.dumps(d, ensure_ascii=False)[:220]}")

    # ⑧ 清理
    st, d = c.call("/api/sync/conflicts?slug=%s&status=open" % u(slug))
    left = len((d or {}).get("items") or [])
    for it in (d or {}).get("items") or []:
        c.call("/api/sync/resolve", "POST", {"id": it["id"], "choice": "server"})
    st, d = c.call("/api/sync/conflicts?slug=%s&status=open" % u(slug))
    check("⑱ 处理完不再挂 open", len((d or {}).get("items") or []) == 0, f"残留 {left}")

    # 删掉自测书（自己建的，不是用户数据）
    c.call("/api/book/delete", "POST", {"slug": slug})
    for p in (BOOKS / slug, TRASH / slug):
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
    # 删除接口会先把书挪进回收站（带时间戳后缀），自测的东西自己收干净
    for d in list(TRASH.glob("*" + slug + "*")):
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
    print("  自测书已删干净：%s" % slug)

    ok = sum(1 for _, o, _ in results if o)
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "slug": slug,
           "total": len(results), "ok": ok, "fail": len(results) - ok,
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "冲突处理实测.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/冲突处理实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
