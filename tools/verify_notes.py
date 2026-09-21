#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""笔记实测（docs/08 阶段 2.6「书签 / 阅读进度 / 笔记」里此前没做的那一件）。

验的是：能记、能带摘录、能搜、能改、**删掉的东西进回收目录**（用户写的东西不许凭空没了）。
用自建的一次性书跑，跑完删干净。
跑法：server/venv/bin/python tools/verify_notes.py
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
results: list[tuple[str, bool, str]] = []


def pw() -> str:
    try:
        return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
                   .get("app_password") or "")
    except Exception:
        return ""


def u(v) -> str:
    return urllib.request.quote(str(v), safe="")


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
            with self.op.open(req, d, timeout=60) as r:
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


def check(n, ok, why=""):
    results.append((n, bool(ok), str(why)))
    print(("  ✓ " if ok else "  ✗ ") + n + ("" if ok else "   —— " + str(why)[:200]))


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1
    st, d = c.call("/api/book", "POST", {"title": "笔记自测 " + STAMP})
    slug = (d or {}).get("slug") or ""
    check("① 建一本自测书", st == 200 and bool(slug), f"{st} {d}")
    if not slug:
        return 1

    st, d = c.call("/api/notes?slug=%s" % u(slug))
    check("② 开屏是空的（不假装有数据）", st == 200 and (d or {}).get("total") == 0,
          f"{st} {json.dumps(d, ensure_ascii=False)[:120]}")

    st, d = c.call("/api/note", "POST", {"slug": slug, "path": "manuscript/甲章.md",
                                         "percent": 0.42, "quote": "他把木牌翻过来看了看",
                                         "text": "这里可以埋一个伏笔：木牌背面还有字"})
    nid = (d or {}).get("id")
    check("③ 记一条笔记（带摘录和进度）", st == 200 and bool(nid),
          f"{st} {json.dumps(d, ensure_ascii=False)[:180]}")

    st, d = c.call("/api/notes?slug=%s&q=%s" % (u(slug), u("伏笔")))
    check("④ 搜得到（按内容搜）", st == 200 and (d or {}).get("total") == 1,
          f"{st} {json.dumps(d, ensure_ascii=False)[:160]}")
    st, d = c.call("/api/notes?slug=%s&q=%s" % (u(slug), u("根本不该有的词")))
    check("⑤ 搜不存在的词就是 0（不许搜什么都回全部）", (d or {}).get("total") == 0,
          json.dumps(d, ensure_ascii=False)[:160])
    st, d = c.call("/api/notes?slug=%s&q=%s" % (u(slug), u("木牌")))
    check("⑥ 摘录里的词也搜得到", (d or {}).get("total") == 1, json.dumps(d, ensure_ascii=False)[:160])

    st, d = c.call("/api/note", "POST", {"slug": slug, "id": nid, "text": "改主意了：这里先不埋"})
    st2, d2 = c.call("/api/notes?slug=%s" % u(slug))
    it = ((d2 or {}).get("items") or [{}])[0]
    check("⑦ 能改，而且只有一条（不是改一次多一条）",
          st == 200 and (d2 or {}).get("total") == 1 and "改主意了" in it.get("text", ""),
          f"{st} {json.dumps(d2, ensure_ascii=False)[:180]}")

    st, d = c.call("/api/note", "POST", {"slug": slug, "text": "   "})
    check("⑧ 空笔记不给存（免得点一下就多一条空白）", st == 400, f"{st} {d}")

    st, d = c.call("/api/note?id=%s&slug=%s" % (nid, u(slug)), "DELETE")
    before = set(p.name for p in TRASH.glob("note-*.json")) if TRASH.exists() else set()
    check("⑨ 删除先留一份到回收目录（用户写的东西不许凭空没了）",
          st == 200 and any(("note-%s-" % nid) in x for x in before),
          f"{st} trash={sorted(before)[-3:]}")
    st, d = c.call("/api/notes?slug=%s" % u(slug))
    check("⑩ 删完列表里没有了", (d or {}).get("total") == 0, json.dumps(d, ensure_ascii=False)[:120])

    st, d = c.call("/api/note", "POST", {"slug": slug, "id": 999999, "text": "不存在的"})
    check("⑪ 改一条不存在的笔记：404（不是默默新建一条）", st == 404, f"{st} {d}")

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
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results), "ok": ok,
           "fail": len(results) - ok,
           "items": [{"name": n, "ok": o, "why": w} for n, o, w in results]}
    (ROOT / "docs" / "笔记实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1),
                                                 encoding="utf-8")
    print(f"\n=== 共 {len(results)} 条：通过 {ok}，失败 {len(results) - ok} ===")
    for n, o, w in results:
        if not o:
            print("  ✗", n, w)
    print("报告：docs/笔记实测.json")
    return 1 if ok != len(results) else 0


if __name__ == "__main__":
    sys.exit(main())
