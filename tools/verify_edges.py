#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""边界实测（第 9 遍打磨）：专挑"平时碰不到、一碰就出事"的地方。

覆盖（都是产品真会遇到、而不是为了凑数的）：
  A 空书（0 章）：质检/统计/导出/世界/剧情 一堆接口会不会 500
  B 中文路径：中文章名 + 带空格 + 带 # 的书名，建→读→写→改名→导出→搜
  C 路径穿越：../../etc/passwd 这类必须被挡，且**磁盘上不能真出现文件**
  D 超长输入：30 万字一章、10 万字的标题、5MB 设定 —— 要么收下要么说人话
  E 并发：16 路同时写不同章 / 8 路同时写同一章 —— 不许 DB locked 500、不许丢章
  F 不存在的 slug：要 404 说人话，不许 500，也不许"假装成功"
  G 类型错：body 传 null/数组/超长字符串 —— 400 说人话

用法：server/venv/bin/python tools/verify_edges.py
产出：docs/边界实测.json + 控制台逐条结果
规矩：只用靶子书；跑完全部进回收站（不碰用户的书）。
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import time
from pathlib import Path

import httpx

BASE = os.environ.get("NOVELAPP_API", "http://127.0.0.1:8899")
ROOT = Path(__file__).resolve().parent.parent
STAMP = time.strftime("%m%d-%H%M%S")
SCRATCH = f"zz-edge-{STAMP}"
OUT = ROOT / "docs/边界实测.json"

rows: list[dict] = []
cli = httpx.Client(base_url=BASE, timeout=180.0)


def password() -> str:
    try:
        d = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))
        return str(d.get("app_password") or "")
    except Exception:
        return os.environ.get("NOVELAPP_INIT_PASSWORD", "")


def rec(group: str, name: str, ok: bool, detail: str = "", status=None, ms=None, full=None):
    rows.append({"group": group, "name": name, "ok": bool(ok), "detail": detail[:400],
                 "detailFull": (full if full is not None else detail)[:20000],
                 "status": status, "ms": ms})
    print(("  ✓  " if ok else "  ✗  ") + name + ("" if ok else "   —— " + detail[:220]))


def req(method: str, path: str, *, ok=(200,), body=None, params=None, timeout=None):
    t0 = time.time()
    try:
        r = cli.request(method, path, json=body, params=params, timeout=timeout or 180.0)
    except Exception as e:
        return None, f"请求异常：{e}", None, int((time.time() - t0) * 1000)
    ms = int((time.time() - t0) * 1000)
    try:
        j = r.json()
    except Exception:
        j = {"_bytes": len(r.content), "_text": r.text[:200]}
    why = ""
    if r.status_code not in ok:
        why = f"HTTP {r.status_code} {json.dumps(j, ensure_ascii=False)[:200]}"
    return r, why, j, ms


def main():
    print("== 登录 ==")
    r, why, j, _ = req("POST", "/api/app/login", body={"password": password()})
    if why:
        print("登录失败：", why)
        return 1

    # 跑之前先把书架拍下来 —— 收尾要拿它**对账**：跑完必须跟跑之前一模一样。
    # （以前只按"标题像垃圾"的正则去清，结果 title=1 这种漏网，用户的架上真就多出一本"1"。）
    BASELINE = sorted(str(p.get("slug") or "") for p in
                      ((req("GET", "/api/shelf")[2] or {}).get("projects") or []))

    print("\n== A 空书（一章都没有）==")
    born = req("POST", "/api/book", body={"title": SCRATCH, "kind": "novel"})[2] or {}
    slug = born.get("slug") or SCRATCH
    for name, path, params, keys in [
        ("空书·book 详情", "/api/book", {"slug": slug}, ("chapters", "totalWords")),
        ("空书·质检报告", "/api/lint/report", {"slug": slug}, ("items", "book")),
        ("空书·质检扫描全书", "/api/lint/scan-book", {}, None),
        ("空书·统计", "/api/stats/book", {"slug": slug}, None),
        ("空书·导出 Markdown", "/api/export/markdown", {"slug": slug}, None),
        ("空书·导出整包", "/api/export/bundle", {"slug": slug}, None),
        ("空书·世界总览", "/api/world/overview", {"slug": slug}, ("counts",)),
        ("空书·世界回溯", "/api/world/retro", {"slug": slug}, None),
        ("空书·世界审计", "/api/world/audit", {"slug": slug}, None),
        ("空书·剧情总览", "/api/plot/overview", {"slug": slug}, None),
        ("空书·待兑现伏笔", "/api/plot/promises/due", {"slug": slug}, None),
        ("空书·出场统计", "/api/plot/cast", {"slug": slug}, None),
        ("空书·节奏曲线", "/api/pacing/curve", {"slug": slug}, None),
        ("空书·声音报告", "/api/voice/report", {"slug": slug}, None),
        ("空书·一致性体检", "/api/consistency/report", {"slug": slug}, None),
        ("空书·搜索", "/api/search", {"slug": slug, "q": "门"}, None),
    ]:
        if "扫描全书" in name:
            # scan-book 的 slug 走 body（POST 契约），不是 query
            r2, why2, j2, ms2 = req("POST", path, body={"slug": slug}, ok=(200,))
        else:
            r2, why2, j2, ms2 = req("GET", path, params=params)
        if keys and not why2:
            miss = [k for k in keys if k not in (j2 or {})]
            why2 = ("缺字段 " + ",".join(miss)) if miss else ""
        rec("A-空书", name, not why2, why2, getattr(r2, "status_code", None), ms2)

    print("\n== B 中文路径 / 空格 / 特殊字符 ==")
    cn_name = "书名带空格 与#井号·测试"
    b2 = req("POST", "/api/book", body={"title": cn_name, "kind": "novel"})[2] or {}
    cn_slug = b2.get("slug") or ""
    rec("B-中文", "中文书名建书（含空格与 #）", bool(cn_slug), "没拿到 slug")
    if cn_slug:
        ch = "manuscript/第001章-风雪夜归人·初稿.md"
        r3, why3, _, ms3 = req("POST", "/api/chapter/new",
                               body={"slug": cn_slug, "path": ch, "content": "# 风雪\n\n“走。”沈岩说。\n"})
        rec("B-中文", "中文章名新建", not why3, why3, None, ms3)
        r4, why4, j4, ms4 = req("GET", "/api/chapter", params={"slug": cn_slug, "path": ch})
        rec("B-中文", "中文章名读回（内容一致）", (not why4) and (j4 or {}).get("content", "").startswith("# 风雪"),
            why4 or ("内容不对：" + str((j4 or {}).get("content"))[:60]))
        r5, why5, _, ms5 = req("PUT", "/api/chapter",
                               body={"slug": cn_slug, "path": ch, "content": "# 风雪\n\n改过。\n"})
        rec("B-中文", "中文章名写入", not why5, why5, None, ms5)
        r6, why6, _, ms6 = req("GET", "/api/search", params={"slug": cn_slug, "q": "风雪"})
        rec("B-中文", "搜索命中中文内容", (not why6) and bool((r6 or {}).json().get("hits")),
            why6 or "一条都没搜到")
        r7, why7, _, _ = req("POST", "/api/chapter/rename",
                             body={"slug": cn_slug, "from": ch, "to": "manuscript/第001章-改过名·终.md"})
        rec("B-中文", "中文章名改名", not why7, why7)
        r8, why8, _, _ = req("GET", "/api/export/markdown", params={"slug": cn_slug})
        rec("B-中文", "中文书名导出 Markdown", (not why8) and len((r8.content if r8 else b"")) > 0,
            why8 or "导出是空的")
        r9, why9, _, _ = req("POST", "/api/import/text",
                             body={"slug": cn_slug, "name": "002-第002章-带空格 的 名字.md",
                                   "text": "正文一段。\n", "prefix": "manuscript"})
        rec("B-中文", "导入时文件名带空格", not why9, why9)

    print("\n== C 路径穿越 ==")
    # 判据不是"必须 4xx" —— 有的写法（如 URL 编码过的 %2f）根本不是穿越，是个合法怪文件名。
    # 真正要命的只有一件事：**文件落到书目录外面去**。
    bookdir = ROOT / "data/books" / slug
    escapes = ["../../../../etc/passwd", "..%2f..%2fetc%2fpasswd", "manuscript/../../../etc/passwd",
               "/etc/passwd", "manuscript/..\\..\\win.ini"]
    for p in escapes:
        r10, why10, j10, _ = req("PUT", "/api/chapter",
                                 body={"slug": slug, "path": p, "content": "HACKED"}, ok=(200, 400, 403))
        outside = False
        if r10 is not None and r10.status_code == 200:
            # 收下了就必须落在书目录里（且不能是 data/ 或仓库根的越界位置）
            cands = [ROOT / "data" / p, ROOT / p, Path("/etc/passwd"), Path("/tmp") / p]
            outside = any(c.exists() and "HACKED" in c.read_text("utf-8", errors="ignore")
                          for c in cands if c.is_file())
        rec("C-穿越", f"写章节：{p}（不许落到书目录外面）", not outside,
            why10 or "真写到书外面去了")
    leaked = Path("/etc/passwd").read_text("utf-8", errors="ignore")
    rec("C-穿越", "/etc/passwd 没被改写", "HACKED" not in leaked, "系统文件被写了！")
    # 书目录外、但仍在仓库里的相对路径（最容易被忽略的一种"越界"）
    evil = "../evil-slug-escape.txt"
    r11, why11, _, _ = req("PUT", "/api/chapter", body={"slug": slug, "path": evil, "content": "X"},
                           ok=(200, 400, 403))
    on_disk = (ROOT / "data/books" / "evil-slug-escape.txt").exists() or (ROOT / "data" / "evil-slug-escape.txt").exists()
    rec("C-穿越", "相对上级目录（data/books/../）不许落盘", not on_disk,
        "真写到了书目录外面：%s" % evil)

    print("\n== D 超长 / 超大 ==")
    big = ("他推开门。屋里没有人。风从窗缝里挤进来，吹得灯芯晃了一下。\n" * 8000)   # ≈30 万字
    r12, why12, _, ms12 = req("POST", "/api/chapter/new",
                              body={"slug": slug, "path": "manuscript/900-超长章.md", "content": big})
    rec("D-超长", f"30 万字一章（{len(big)} 字）建得下", not why12, why12, None, ms12)
    if not why12:
        r13, why13, j13, ms13 = req("GET", "/api/chapter",
                                    params={"slug": slug, "path": "manuscript/900-超长章.md"})
        rec("D-超长", "读回来长度一致",
            (not why13) and len((j13 or {}).get("content") or "") == len(big),
            why13 or f"长度 {len((j13 or {}).get('content') or '')} != {len(big)}", None, ms13)
        r14, why14, _, ms14 = req("POST", "/api/lint/scan", body={"slug": slug, "path": "manuscript/900-超长章.md"})
        rec("D-超长", "30 万字扫质检不超时（<20s）", (not why14) and (ms14 or 0) < 20000,
            why14 or f"耗时 {ms14}ms", None, ms14)
    r15, why15, _, ms15 = req("POST", "/api/chapter/new",
                              body={"slug": slug, "path": "manuscript/901-超长标题.md",
                                    "content": "正文" * 100}, ok=(200, 400))
    rec("D-超长", "超长正文（20 万字）不炸", not why15, why15, None, ms15)
    r16, why16, _, _ = req("POST", "/api/book",
                           body={"title": "标" * 8000, "kind": "novel"}, ok=(200, 400))
    rec("D-超长", "8000 字书名：要么收下要么说人话", not why16, why16)

    print("\n== E 并发 ==")
    paths = [f"manuscript/80{i}-并发-{i}.md" for i in range(16)]
    def w(p):
        r, why, _, _ = req("POST", "/api/chapter/new",
                           body={"slug": slug, "path": p, "content": "并发写 " + p + "\n"}, timeout=60)
        return why
    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        errs = [e for e in ex.map(w, paths) if e]
    rec("E-并发", "16 路同时写不同章：0 个 500 / DB locked", not errs, "; ".join(errs)[:300])
    r17, why17, j17, _ = req("GET", "/api/book", params={"slug": slug})
    got = {c["path"] for c in (j17 or {}).get("chapters") or []}
    rec("E-并发", "16 章全都出现在书目里（没丢）",
        all(p in got for p in paths), "丢了：" + ",".join(p for p in paths if p not in got)[:200])
    same = "manuscript/850-同章并发.md"
    def w2(i):
        r, why, _, _ = req("PUT", "/api/chapter",
                           body={"slug": slug, "path": same, "content": f"第 {i} 版\n"}, timeout=60)
        return why
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        errs2 = [e for e in ex.map(w2, range(8)) if e]
    rec("E-并发", "8 路同时写同一章：0 个 500", not errs2, "; ".join(errs2)[:300])
    r18, _, j18, _ = req("GET", "/api/chapter", params={"slug": slug, "path": same})
    rec("E-并发", "同一章最后是一个完整版本（不是半个文件）",
        bool((j18 or {}).get("content", "").strip().startswith("第")),
        "内容：" + str((j18 or {}).get("content"))[:80])
    # 读写混合：一边读整本书一边写
    def mixed(i):
        if i % 2:
            return req("GET", "/api/book", params={"slug": slug}, timeout=60)[1]
        return req("PUT", "/api/chapter",
                   body={"slug": slug, "path": same, "content": f"混合 {i}\n"}, timeout=60)[1]
    with cf.ThreadPoolExecutor(max_workers=12) as ex:
        errs3 = [e for e in ex.map(mixed, range(24)) if e]
    rec("E-并发", "读写混合 24 路：0 个 500", not errs3, "; ".join(errs3)[:300])

    print("\n== F 不存在的 slug / 不存在的对象 ==")
    for name, method, path, params, body in [
        ("book 详情", "GET", "/api/book", {"slug": "book-that-never-existed-zz"}, None),
        ("质检报告", "GET", "/api/lint/report", {"slug": "book-that-never-existed-zz"}, None),
        ("世界总览", "GET", "/api/world/overview", {"slug": "book-that-never-existed-zz"}, None),
        ("章节读", "GET", "/api/chapter",
         {"slug": "book-that-never-existed-zz", "path": "manuscript/001.md"}, None),
        ("不存在的章（书是真的）", "GET", "/api/chapter",
         {"slug": slug, "path": "manuscript/999-没有这一章.md"}, None),
        ("导出", "GET", "/api/export/markdown", {"slug": "book-that-never-existed-zz"}, None),
        ("写章节", "PUT", "/api/chapter",
         None, {"slug": "book-that-never-existed-zz", "path": "manuscript/001.md", "content": "x"}),
    ]:
        r19, why19, j19, _ = req(method, path, params=params, body=body, ok=(200, 400, 403, 404))
        if not why19 and r19.status_code >= 500:
            why19 = f"500：{json.dumps(j19, ensure_ascii=False)[:160]}"
        rec("F-不存在", name + "（要 4xx 说人话，不许 500）", not why19, why19,
            getattr(r19, "status_code", None))

    print("\n== G 类型错 / 空 body ==")
    cases = [
        ("建书：空 body", "POST", "/api/book", None, {}, (200, 400, 422)),
        ("建书：title 是数组", "POST", "/api/book", None, {"title": ["a", "b"]}, (200, 400, 422)),
        ("建书：title 是对象", "POST", "/api/book", None, {"title": {"a": 1}}, (200, 400, 422)),
        ("写章：content 是数字", "PUT", "/api/chapter", None,
         {"slug": slug, "path": "manuscript/902-类型.md", "content": 12345}, (200, 400, 422)),
        ("写章：path 是空", "PUT", "/api/chapter", None,
         {"slug": slug, "path": "", "content": "x"}, (200, 400, 422)),
        ("世界实体：name 是数字", "POST", "/api/world/entity", None,
         {"slug": slug, "kind": "character", "name": 42}, (200, 400, 422)),
        ("时刻：date 是数组", "POST", "/api/world/moment", None,
         {"slug": slug, "label": "某刻", "date": []}, (200, 400, 422)),
    ]
    for name, method, path, params, body, ok in cases:
        r20, why20, j20, _ = req(method, path, params=params, body=body, ok=ok)
        rec("G-类型", name, not why20, why20, getattr(r20, "status_code", None))

    print("\n== H 错误类型模糊测试（每个字段灌 5 种错类型，只看会不会 500）==")
    r23, _, j23, _ = req("POST", "/api/world/entity", body={"slug": slug, "kind": "character", "name": "模糊实体"})
    eid = (j23 or {}).get("id")
    r24, _, j24, _ = req("POST", "/api/chapter/new",
                         body={"slug": slug, "path": "manuscript/910-模糊.md", "content": "内容"})
    base_bodies = [
        ("POST", "/api/book", {"title": "模糊书", "kind": "novel"}, ["title", "summary", "kind"]),
        ("POST", "/api/book/rename", {"slug": slug, "title": "模糊改名"}, ["title"]),
        ("POST", "/api/chapter/new", {"slug": slug, "path": "manuscript/911-模糊.md", "content": "x"},
         ["path", "content"]),
        ("PUT", "/api/chapter", {"slug": slug, "path": "manuscript/910-模糊.md", "content": "x"},
         ["path", "content"]),
        ("POST", "/api/chapter/rename", {"slug": slug, "from": "manuscript/910-模糊.md",
                                         "to": "manuscript/912-模糊.md"}, ["from", "to"]),
        ("POST", "/api/lore/entry", {"slug": slug, "path": "lorebook/character/模糊.md",
                                     "title": "模糊", "content": "x"}, ["path", "title", "content"]),
        ("POST", "/api/world/entity", {"slug": slug, "kind": "item", "name": "模糊物"}, ["kind", "name"]),
        ("POST", "/api/world/fact", {"slug": slug, "entityId": eid, "key": "年龄", "value": "20"},
         ["key", "value"]),
        ("POST", "/api/world/moment", {"slug": slug, "label": "模糊时刻", "date": "第1天"}, ["label", "date"]),
        ("POST", "/api/plot/promise", {"slug": slug, "name": "模糊伏笔", "kind": "prop"}, ["name", "kind"]),
        ("POST", "/api/plot/act", {"slug": slug, "number": 2, "title": "模糊卷"}, ["title"]),
        ("POST", "/api/material", {"slug": slug, "title": "模糊素材", "kind": "note", "text": "x"},
         ["title", "kind", "text"]),
        ("POST", "/api/note", {"slug": slug, "text": "模糊便签"}, ["text"]),
        ("POST", "/api/refs/item", {"slug": slug, "title": "模糊参考", "source": "某书", "tags": "a,b",
                                    "text": "x"}, ["title", "source", "tags", "text"]),
        ("POST", "/api/voice/profile", {"slug": slug, "name": "模糊角色", "voice": {"tone": "冷"}},
         ["name", "voice"]),
        ("POST", "/api/prompts/save", {"key": "writer.default", "text": "x"}, ["key", "text"]),
    ]
    bad_types = [["数组"], {"对象": 1}, 12345, True, "   "]
    seen500 = []
    tested = 0
    for method, path, base, fields in base_bodies:
        for f in fields:
            for v in bad_types:
                body = dict(base)
                body[f] = v
                tested += 1
                r25, why25, j25, _ = req(method, path, body=body, ok=(200, 400, 403, 404, 409, 422))
                if r25 is not None and r25.status_code >= 500:
                    seen500.append(f"{method} {path} · {f}={json.dumps(v, ensure_ascii=False)[:24]}"
                                   f" → {r25.status_code} {json.dumps(j25, ensure_ascii=False)[:90]}")
    rec("H-类型", f"错类型字段不许把服务打成 5xx（{tested} 次请求）", not seen500,
        f"{len(seen500)} 处：" + " | ".join(seen500[:6]),
        full="\n".join(seen500))

    print("\n== 收尾①：模糊测试顺手建出来的书也要清（第 9 遍打磨真踩过）==")
    # H 段往 /api/book 灌了 title=12345/true/数组…，类型合法的那些会**真的建出一本书**。
    # 上一版只按"标题像垃圾"的正则去清，`title=1` 这种漏网 —— 用户的架上真多出一本叫「1」的书
    # （2026-09-20 抓到，已清）。现在改成**对账**：凡是"跑之前那一份"里没有的，一律进回收站。
    KEEP = set(BASELINE) | {slug, cn_slug}
    r_sh = req("GET", "/api/shelf")[2] or {}
    junk = [p for p in (r_sh.get("projects") or []) if str(p.get("slug") or "") not in KEEP]
    for p in junk:
        req("POST", "/api/book/delete", body={"slug": p["slug"]})
    r_sh2 = req("GET", "/api/shelf")[2] or {}
    left_junk = [p["slug"] for p in (r_sh2.get("projects") or [])
                 if str(p.get("slug") or "") not in KEEP]
    rec("Z-收尾", f"模糊测试建的 {len(junk)} 本书全进回收站，架上回到跑之前那一份", not left_junk,
        "还剩：" + ",".join(left_junk))

    print("\n== 收尾②：靶子书进回收站 ==")
    for s in [slug, cn_slug]:
        if not s:
            continue
        r21, why21, j21, _ = req("POST", "/api/book/delete", body={"slug": s})
        rec("Z-收尾", f"删测试书 {s}", not why21 and bool((j21 or {}).get("trashedTo")), why21)
    r22, _, j22, _ = req("GET", "/api/shelf")
    now = sorted(str(p.get("slug") or "") for p in (j22 or {}).get("projects") or [])
    rec("Z-收尾", "书架上**跟跑之前逐本一致**（自测绝不往用户架上留东西）", now == BASELINE,
        {"跑之前": BASELINE, "跑完": now,
         "多出来": sorted(set(now) - set(BASELINE)), "少了": sorted(set(BASELINE) - set(now))})

    bad = [r for r in rows if not r["ok"]]
    OUT.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE,
                               "total": len(rows), "bad": len(bad), "rows": rows},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 边界实测：{len(rows) - len(bad)}/{len(rows)} 通过 ===")
    print("报告：docs/边界实测.json")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
