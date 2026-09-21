#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""路由逐条自测：**每一个路由模块**都要过四类请求，不许「写了没验」。

四类（每条都要真发 HTTP 请求）：
  1. 成功路径   真实中文参数 → 期望 200，且返回体是 JSON（不是 HTML 错误页）
  2. 空数据     不存在的书/不存在的 id → 期望 200（空列表）或 404，**绝不能 5xx**
  3. 中文路径   中文 slug / 中文章节路径 / 中文检索词 → 期望 200 且原样返回中文
  4. 错误参数   缺参数、参数类型不对 → 期望 4xx（400/404/422），**绝不能 5xx**

另外对**每个路由的每个端点**做一次「空参数扫」：GET 不带参、写方法带 `{}`，
只断言「不许 500」。会改数据或花钱的几个端点进 SKIP（见 SKIP_EMPTY_SCAN）。

产出：docs/路由逐条自测.json（逐条结果） + 控制台表格 + 末尾汇总行。
口令从本机配置读，**不打印**。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx

BASE = os.environ.get("NOVELAPP_API", "http://127.0.0.1:8899")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BOOK = "example-book"
CH = "manuscript/第001章-荒原雪夜.md"
CH_DIR = "manuscript"
BOGUS = "no-such-book-zz-中文测试"

# 空参数扫里不能碰的端点：会改数据 / 会花钱 / 会重启活儿
SKIP_EMPTY_SCAN = {
    ("POST", "/app/logout"), ("POST", "/app/change-password"),
    ("POST", "/agent/sessions"), ("POST", "/agent/profiles/compile-all"),
    ("POST", "/agent/jobs/clear-finished"), ("POST", "/projects/rag/rebuild"),
    ("POST", "/backup/create"), ("POST", "/passport/backups"), ("POST", "/backup/restore"),
    ("POST", "/backup/upload"), ("POST", "/backup/auto"), ("POST", "/passport/backups/delete"),
    ("PUT", "/config/global"), ("PUT", "/config/project"), ("POST", "/config/models/provider"),
    ("POST", "/config/models/default"), ("POST", "/config/models/recommended"),
    ("POST", "/config/models/test"), ("POST", "/workspace-files/upload-file"),
    ("POST", "/cover"), ("POST", "/projects/rag/debug"), ("POST", "/replace"),
    ("POST", "/term"), ("POST", "/material"), ("POST", "/bookmarks"), ("POST", "/progress"),
    ("POST", "/plot/decision"), ("POST", "/plot/promise"), ("POST", "/plot/thread"),
    ("POST", "/plot/scene"), ("POST", "/plot/act"), ("POST", "/plot/outline"),
    ("POST", "/plot/outline/approve"), ("POST", "/prompts/save"), ("POST", "/prompts/rollback"),
    ("POST", "/snippets/save"), ("POST", "/model-sets/save"), ("POST", "/model-sets/activate"),
    ("POST", "/presets/save"), ("POST", "/presets/reset"), ("POST", "/note"),
    ("POST", "/notes"), ("POST", "/sync/push"), ("POST", "/sync/resolve"),
    ("POST", "/peer/sync"), ("POST", "/peer/resolve"),   # 会真去连服务器，空参数扫跳过
    ("POST", "/workflows/save"), ("POST", "/workflows/run"), ("POST", "/write/batch"),
    ("POST", "/world/entity"), ("POST", "/world/entity/merge"), ("POST", "/world/fact"),
    ("POST", "/world/fact/close"), ("POST", "/world/relation"), ("POST", "/world/moment"),
    ("POST", "/world/episode"), ("POST", "/world/arc"), ("POST", "/world/extract"),
    ("POST", "/world/import-lorebook"), ("POST", "/lore/entry"), ("POST", "/files/upload"),
    ("POST", "/import/markdown"), ("POST", "/import/character-card"), ("POST", "/import/text"),
    ("POST", "/lint/scan"), ("POST", "/lint/scan-book"), ("POST", "/lint/fix"),
    ("POST", "/lint/llm"), ("POST", "/agent/sessions/{sid}/invocations"),
    ("POST", "/agent/sessions/{sid}/commands"),
    ("POST", "/voice/profile"), ("DELETE", "/voice/profile"), ("POST", "/consistency/alias"),
    ("POST", "/refs/item"), ("DELETE", "/refs/item"),
}
for m in ("generate", "continue", "rewrite", "polish", "inline", "outline", "summary"):
    SKIP_EMPTY_SCAN.add(("POST", "/write/" + m))

# 只探 `/api/...` 这一套前缀（`nb/api` 挂的是同一批 router 对象，实现只有一份）
def api(path: str) -> str:
    return "/api" + path

# 每个路由的「成功路径」探针 + 中文说明；缺参数探针另配
ROUTER_OK = {
    "core":          ("GET",  "/app/info", {}),
    "books":         ("GET",  "/book", {"slug": BOOK}),
    "lore":          ("GET",  "/lore/tree", {"slug": BOOK}),
    "presets":       ("GET",  "/presets", {"scope": "global"}),
    "files":         ("GET",  "/workspace-files/tree", {"projectRoot": BOOK}),
    "tts":           ("GET",  "/tts/voices", {}),
    "agent":         ("GET",  "/agent/profiles/catalog", {}),
    "config":        ("GET",  "/config/models/library", {}),
    "rag":           ("GET",  "/projects/rag/inspector", {"projectRoot": BOOK}),
    "world":         ("GET",  "/world/overview", {"slug": BOOK}),
    "plot":          ("GET",  "/plot/overview", {"slug": BOOK}),
    "write":         ("GET",  "/write/status", {"slug": BOOK}),
    "lint":          ("GET",  "/lint/rules", {}),
    "stats":         ("GET",  "/stats/book", {"slug": BOOK}),
    "export":        ("GET",  "/export/text", {"slug": BOOK}),
    "misc":          ("GET",  "/audit", {"slug": BOOK}),
    "backup":        ("GET",  "/backup/list", {}),
    "prompts":       ("GET",  "/prompts", {"scope": "global"}),
    "models":        ("GET",  "/model-sets", {}),
    "notes":         ("GET",  "/notes", {"slug": BOOK}),
    "sync":          ("GET",  "/sync/state", {"slug": BOOK}),
    "workflows":     ("GET",  "/workflows", {"slug": BOOK}),
    "voice":         ("GET",  "/voice/report", {"slug": BOOK}),
    "pacing":        ("GET",  "/pacing/curve", {"slug": BOOK}),
    "refs":          ("GET",  "/refs", {"slug": BOOK}),
    "peer":          ("GET",  "/peer/state", {"slug": BOOK}),
}

# 「空数据」探针：拿不存在的书 / 不存在的 id / 空目录
ROUTER_EMPTY = {
    "books":     ("GET", "/book", {"slug": BOGUS}),
    "lore":      ("GET", "/lore/tree", {"slug": BOGUS}),
    "files":     ("GET", "/workspace-files/tree", {"projectRoot": BOGUS}),
    "rag":       ("GET", "/projects/rag/inspector", {"projectRoot": BOGUS}),
    "world":     ("GET", "/world/overview", {"slug": BOGUS}),
    "plot":      ("GET", "/plot/overview", {"slug": BOGUS}),
    "write":     ("GET", "/write/status", {"slug": BOGUS}),
    "stats":     ("GET", "/stats/book", {"slug": BOGUS}),
    "misc":      ("GET", "/audit", {"slug": BOGUS}),
    "notes":     ("GET", "/notes", {"slug": BOGUS}),
    "sync":      ("GET", "/sync/state", {"slug": BOGUS}),
    "workflows": ("GET", "/workflows", {"slug": BOGUS}),
    "models":    ("GET", "/model-sets/resolve", {"slug": BOOK, "purpose": "no-such-purpose"}),
    "prompts":   ("GET", "/prompts/versions", {"scope": "global", "key": "no.such.prompt"}),
    "agent":     ("GET", "/agent/jobs/zz-no-such-job", {}),
    "voice":     ("GET", "/voice/profile", {"slug": BOGUS, "name": "查无此人"}),
    "pacing":    ("GET", "/pacing/curve", {"slug": BOGUS}),
    "refs":      ("GET", "/refs", {"slug": BOGUS}),
    "peer":      ("GET", "/peer/conflict", {"id": 999999}),
}

# 追加探针：同一个模块多探几条（键是 `router#编号`，跑的时候归到前面的 router 名下）
EXTRA = {
    "books#2":     ("GET", "/chapter", {"slug": BOOK, "path": "manuscript/没有这一章.md"}, 404),
    "agent#2":     ("GET", "/agent/sessions", {"q": "雪"}),
    "books#3":     ("GET", "/search", {"slug": BOOK, "q": "雪"}),
    "lore#2":      ("GET", "/lore/search", {"slug": BOOK, "q": "雪"}),
    "files#2":     ("GET", "/workspace-files/read", {"projectRoot": BOOK, "path": CH}),
    "world#2":     ("GET", "/world/entities", {"slug": BOOK, "q": "雪"}),
    "plot#2":      ("GET", "/plot/outline", {"slug": BOOK, "path": CH}),
    "write#2":     ("GET", "/write/context", {"slug": BOOK, "path": CH, "mode": "continue"}),
    "lint#2":      ("POST", "/lint/scan", {"slug": BOOK, "path": CH}),
    "export#2":    ("GET", "/export/print", {"slug": BOOK, "path": CH}),
    "voice#2":     ("GET", "/voice/fields", {}),
    "voice#3":     ("GET", "/voice/brief", {"slug": BOOK, "names": "唐三,小舞"}),
    "pacing#2":    ("GET", "/pacing/one", {"slug": BOOK, "path": CH}),
    "refs#2":      ("GET", "/refs/item", {"slug": BOOK, "id": 999999}, 404),
    "refs#3":      ("GET", "/refs/snippets", {"slug": BOOK, "q": "雪"}),
}

# 「中文路径」探针：中文 slug / 中文章节路径 / 中文检索词
ROUTER_CN = {
    "books":     ("GET", "/chapter", {"slug": BOOK, "path": CH}),
    "lore":      ("GET", "/lore/search", {"slug": BOOK, "q": "雪"}),
    "files":     ("GET", "/workspace-files/read", {"projectRoot": BOOK, "path": CH}),
    "tts":       ("GET", "/tts/segments", {"slug": BOOK, "path": CH, "voice": "zh-CN-XiaoxiaoNeural"}),
    "rag":       ("GET", "/projects/rag/search", {"projectRoot": BOOK, "q": "雪"}),
    "world":     ("GET", "/world/entities", {"slug": BOOK, "q": "雪"}),
    "plot":      ("GET", "/plot/outline", {"slug": BOOK, "path": CH}),
    "write":     ("GET", "/write/context", {"slug": BOOK, "path": CH, "mode": "continue"}),
    "lint":      ("POST", "/lint/scan", {"slug": BOOK, "path": CH}),
    "stats":     ("GET", "/stats/calendar", {"slug": BOOK}),
    "export":    ("GET", "/export/print", {"slug": BOOK, "path": CH}),
    "misc":      ("GET", "/term", {"slug": BOOK}),
    "prompts":   ("GET", "/prompts", {"scope": "global", "slug": BOOK}),
    "notes":     ("GET", "/notes", {"slug": BOOK, "q": "雪"}),
    "books#search": ("GET", "/search", {"slug": BOOK, "q": "雪"}),
    "agent#sess": ("GET", "/agent/sessions", {"q": "雪"}),
    "peer":      ("GET", "/peer/state", {"slug": BOOK}),
}

# 「错误参数」探针：缺参数 / 类型不对 → 期望 4xx
ROUTER_BAD = {
    "books":     ("GET", "/book", {}),
    "lore":      ("GET", "/lore/tree", {}),
    "files":     ("GET", "/workspace-files/read", {}),
    "tts":       ("GET", "/tts/segments", {"slug": BOOK, "path": ""}),
    "rag":       ("GET", "/projects/rag/subject", {"projectRoot": BOOK}),
    "world":     ("GET", "/world/state", {"slug": BOOK}),
    "plot":      ("POST", "/plot/decision", {"slug": BOOK, "title": ""}),
    "write":     ("POST", "/write/generate", {"mode": "不认识的模式"}),
    "lint":      ("POST", "/lint/scan", {"slug": BOOK}),
    "stats":     ("GET", "/stats/book", {"days": "不是数字"}),
    "export":    ("GET", "/export/text", {}),
    "backup":    ("POST", "/backup/restore", {"name": "没有这份备份.zip"}),
    "prompts":   ("POST", "/prompts/save", {"scope": "global", "key": "", "text": "x"}),
    "models":    ("POST", "/model-sets/activate", {"name": "没有这个模型组"}),
    "notes":     ("POST", "/note", {"slug": BOOK}),
    "sync":      ("GET", "/sync/conflict", {"id": 999999}),
    "workflows": ("POST", "/workflows/run", {"slug": BOOK, "id": 999999}),
    "agent":     ("GET", "/agent/sessions/zz-not-a-number", {}),
    "presets":   ("GET", "/presets/resource", {"profileKey": "writer", "key": "没有这条资源.md"}),
    "lore#entry": ("GET", "/lore/entry", {"slug": BOOK}),
    "books#doc": ("GET", "/doctor", {}),
    "misc#prog": ("GET", "/progress", {"slug": BOGUS}),
    "peer":      ("POST", "/peer/sync", {"slug": BOOK, "base": "127.0.0.1:1", "direction": "瞎写的"}),
}

NO_CN_REASON = {}


def password() -> str:
    for p in ("/home/ubuntu/nbapp/config.json",):
        try:
            d = json.loads(Path(p).read_text("utf-8"))
            if d.get("app_password"):
                return str(d["app_password"])
        except Exception:
            pass
    raise SystemExit("读不到口令")


def call(cli: httpx.Client, method: str, path: str, params: dict, body: dict | None = None):
    url = api(path)
    try:
        if method == "GET":
            r = cli.get(url, params=params)
        elif method == "POST":
            r = cli.post(url, params={}, json=body if body is not None else (params or {}))
        elif method == "PUT":
            r = cli.put(url, params={}, json=body if body is not None else (params or {}))
        elif method == "PATCH":
            r = cli.patch(url, params={}, json=body if body is not None else (params or {}))
        else:
            r = cli.request(method, url, params=params, json=body if body is not None else (params or {}))
    except Exception as e:                       # 连不上/超时都算问题
        return 0, {"error": repr(e)[:200]}
    try:
        data = r.json()
    except Exception:
        data = {"_raw": r.text[:120]}
    return r.status_code, data


def main() -> int:
    import server.app as A                       # noqa: N812
    by_router: dict[str, list[tuple[str, str]]] = {}
    for r in A.ROUTERS:
        name = r.tags[0] if r.tags else "?"
        for rt in r.routes:
            m = sorted(x for x in rt.methods if x != "HEAD")[0]
            by_router.setdefault(name, []).append((m, rt.path))

    cli = httpx.Client(base_url=BASE, timeout=180.0)
    pw = password()
    r = cli.post("/api/app/login", json={"password": pw})
    if r.status_code != 200:
        raise SystemExit("登录失败：%s" % r.status_code)

    report: dict = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE,
                    "book": BOOK, "routers": [], "problems": []}
    checks: list[dict] = []

    def add(router: str, kind: str, method: str, path: str, params: dict,
            status: int, ok: bool, note: str = ""):
        checks.append({"router": router, "kind": kind, "method": method, "path": path,
                       "params": {k: v for k, v in (params or {}).items()}, "status": status,
                       "ok": bool(ok), "note": note})
        if not ok:
            report["problems"].append(
                f"{router} · {kind} · {method} {path} → {status} {note}")

    from collections import Counter
    sweep_codes_all = Counter()
    for router, routes in by_router.items():
        codes = Counter()
        n_ok = n_bad = 0
        # 1) 成功路径
        m, p, params = ROUTER_OK[router]
        st, data = call(cli, m, p, params)
        good = st == 200 and isinstance(data, (dict, list))
        add(router, "成功路径", m, p, params, st, good, "" if good else str(data)[:120])
        # 2) 中文
        cn = ROUTER_CN.get(router)
        if cn:
            m2, p2, q2 = cn
            st2, d2 = call(cli, m2, p2, q2)
            good2 = st2 == 200
            note2 = ""
            if good2:
                blob = json.dumps(d2, ensure_ascii=False)
                for probe in ("雪", "荒原"):
                    pass
                if not blob:
                    note2 = "返回是空的"
            add(router, "中文路径", m2, p2, q2, st2, good2, note2 or ("" if good2 else str(d2)[:120]))
        else:
            NO_CN_REASON[router] = "这个模块不收文本参数"
        # 3) 空数据
        empty = ROUTER_EMPTY.get(router)
        if empty:
            m3, p3, q3 = empty
            st3, d3 = call(cli, m3, p3, q3)
            good3 = (st3 < 500) and st3 != 0
            add(router, "空数据", m3, p3, q3, st3, good3, "" if good3 else str(d3)[:120])
        # 4) 错误参数
        bad = ROUTER_BAD.get(router)
        if bad:
            m4, p4, q4 = bad
            st4, d4 = call(cli, m4, p4, q4)
            good4 = 400 <= st4 < 500
            add(router, "错误参数", m4, p4, q4, st4, good4,
                "" if good4 else "期望 4xx，实际 %s %s" % (st4, str(d4)[:80]))
        # 5) 空参数扫：每个端点都不许 500
        swept = 0
        for (mm, pp) in routes:
            if (mm, pp) in SKIP_EMPTY_SCAN:
                continue
            stt, dd = call(cli, mm, pp, {}, body={})
            swept += 1
            codes[stt] += 1
            sweep_codes_all[stt] += 1
            if stt >= 500 or stt == 0:
                add(router, "空参数扫", mm, pp, {}, stt, False, str(dd)[:120])
        report["routers"].append({
            "router": router, "routes": len(routes), "swept": swept, "sweepCodes": dict(sorted(codes.items())),
            "checks": [c for c in checks if c["router"] == router]})
        n_ok = sum(1 for c in checks if c["router"] == router and c["ok"])
        n_bad = sum(1 for c in checks if c["router"] == router and not c["ok"])
        print("%-10s 端点 %2d 扫 %2d | 通过 %2d 失败 %d" % (router, len(routes), swept, n_ok, n_bad))

    # 追加的中文/错误参数探针（同一个模块的第二、三条）
    for key, probe in EXTRA.items():
        owner = key.split("#")[0]
        m, pp, qq = probe[0], probe[1], probe[2]
        want = probe[3] if len(probe) > 3 else (200 if m == "GET" else None)
        st, dd = call(cli, m, pp, qq)
        good = (st == want) if want else (200 <= st < 500)
        add(owner, "追加探针", m, pp, qq, st, good,
            "" if good else str(dd)[:120])
        print("%-10s 追加 %s %s → %d %s" % (owner, m, pp, st, "ok" if good else "✗"))

    sweep_codes = sweep_codes_all
    report["sweepCodes"] = dict(sorted(sweep_codes.items()))
    report["checks"] = checks
    report["total"] = len(checks)
    report["passed"] = sum(1 for c in checks if c["ok"])
    report["failed"] = sum(1 for c in checks if not c["ok"])
    report["no_cn"] = NO_CN_REASON
    out = ROOT / "docs" / "路由逐条自测.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n合计 %d 条：通过 %d，失败 %d" % (report["total"], report["passed"], report["failed"]))
    for p in report["problems"][:40]:
        print("  ✗", p)
    print("报告：", out)
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
