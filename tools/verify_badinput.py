#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""错误参数实测：脏参数不许把服务打成 500。

为什么要有这一条（第 8 遍打磨新加的判据）：
    `verify_api.py` 只打**正常**请求，所以"传个字母给 limit"这类事一直没人试过。
    这类漏洞的表现是 **HTTP 500**（`int("abc")` 的 ValueError 直接冒到框架），
    前端看到的就是"服务出错了"，用户只会觉得"这软件坏了"。
    正经做法是 400（说清哪儿不对）或 422（参数校验不过），**不是 500**。

怎么打：
    1. 从 app 上把 GET 路由全**自省**出来（不写死清单，以后新加的路由自动进覆盖）；
    2. 每个数值/布尔型 query 参数，喂一串脏值（字母、负数、超长、中文、控制符…）；
    3. 只看状态码：200/400/404/422 都算合格，**5xx 或连不上算不合格**；
    4. 不碰任何写接口（只 GET，不 DELETE/PUT/PATCH）。

用法：
    server/venv/bin/python tools/verify_badinput.py            # 全跑
    server/venv/bin/python tools/verify_badinput.py --sample   # 每种参数只试第一个脏值（快）
产出：
    docs/错误参数实测.json
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
SAMPLE = "--sample" in sys.argv
BOOK = "example-book"
RESULTS: list[dict] = []

DIRTY = ["abc", "-1", "99999999999999999999", "1e999", "", " ", "中文", "1;DROP", "\x00", "NaN",
         "0x10", "１２３", "null", "true", "1,2", "../.."]
DIRTY_BOOL = ["maybe", "2", "", "yes", "tru"]

NUMERIC = {"int", "float", "bool", "Optional[int]", "int | None", "float | None",
           "bool | None", "int|None", "float|None", "bool|None"}


def password() -> str:
    for p in ("/home/ubuntu/nbapp/config.json",):
        try:
            d = json.loads(Path(p).read_text("utf-8"))
            if d.get("app_password"):
                return str(d["app_password"])
        except Exception:
            pass
    return os.environ.get("NOVELAPP_INIT_PASSWORD", "")


def _walk(routes, prefix=""):
    """把 app.routes 递归摊平成 (route, 完整路径)。新版 FastAPI 把 include_router
    包成 `_IncludedRouter`，得钻进去；老版直接就是 APIRoute。"""
    out = []
    for r in routes:
        if type(r).__name__ == "_IncludedRouter":
            out += _walk(r.original_router.routes, prefix + r.include_context.prefix)
        elif hasattr(r, "methods") and hasattr(r, "path"):
            out.append((r, prefix + r.path))
    return out


def _numeric_params(route):
    """挑出这个 GET 接口里**数值/布尔型**的 query 参数（这些才会因为脏值抛 ValueError）。"""
    got = []
    try:
        dep = route.dependant
    except Exception:
        return got
    for q in dep.query_params:
        ann = getattr(getattr(q, "field_info", None), "annotation", None)
        if ann in (int, float, bool):
            got.append((q.name, ann is bool))
        elif getattr(ann, "__name__", "") in ("int", "float", "bool"):
            got.append((q.name, ann.__name__ == "bool"))
    return got


# ── body 里的数值字段：同一类问题的另一半 ─────────────────────────────────
# 这些是**从代码里挑出来的真站点**（`grep -n 'int(payload\|float(payload'`）：字段是数字、
# 垃圾值以前会 500。挑的接口要么"号码不存在"要么"值不合法"，都不落数据。
BODY_CASES = [
    ("POST", "/api/bookmarks", {"path": "zz-坏参数.md", "percent": "abc"}),
    ("POST", "/api/progress", {"path": "zz-坏参数.md", "percent": "abc"}),
    ("POST", "/api/world/fact", {"entityId": "abc", "key": "zz", "value": "v"}),
    ("POST", "/api/world/relation", {"from": "a", "to": "b", "strength": "abc"}),
    ("POST", "/api/world/moment", {"label": "zz", "month": "abc", "day": "abc"}),
    ("POST", "/api/world/moment/time", {"momentId": "abc", "text": "开元 1 年"}),
    ("POST", "/api/plot/act", {"number": "abc", "title": "zz"}),
    ("POST", "/api/plot/act", {"number": "99999999999999999999", "title": "zz"}),
    ("POST", "/api/prompts/rollback", {"key": "writer.inline", "version": "abc"}),
    ("POST", "/api/workflows/run", {"id": "abc", "path": "zz.md"}),
    ("POST", "/api/bookmarks", {"path": "zz.md", "percent": "99999"}),
    ("POST", "/api/progress", {"path": "zz.md", "percent": "-5"}),
]


def badinput_body(cli) -> int:
    bad = 0
    for method, path, extra in BODY_CASES:
        body = {"projectRoot": BOOK, "slug": BOOK, **extra}
        try:
            rr = cli.request(method, path, json=body)
            code, text = rr.status_code, rr.text[:200]
        except Exception as e:
            code, text = 0, str(e)[:200]
        ok = code in (200, 400, 401, 403, 404, 405, 409, 422)
        RESULTS.append({"path": path, "param": "body:" + ",".join(k for k in extra if k not in
                                                                   ("label", "title", "key", "text")),
                        "value": json.dumps(extra, ensure_ascii=False)[:60],
                        "status": code, "ms": 0, "ok": ok, "kind": "body",
                        "why": "" if ok else "body 里的脏数字把服务打成了 5xx",
                        "snippet": "" if ok else text})
        if not ok:
            bad += 1
            print(f"  ✗ {method} {path}  {json.dumps(extra, ensure_ascii=False)[:50]} → {code} {text[:80]}")
    return bad


def main() -> int:
    cli = httpx.Client(base_url=BASE, timeout=30.0)  # noqa
    pw = password()
    if not pw:
        print("拿不到口令，跳过", file=sys.stderr)
        return 2
    r = cli.post("/api/app/login", json={"password": pw})
    if r.status_code != 200:
        print("登录失败", r.status_code, r.text[:200], file=sys.stderr)
        return 2
    skip_auth = {"health", "app/info", "app/version", "apk/version", "version"}

    sys.path.insert(0, str(ROOT))
    from server.app import app as _app
    routes = [(rt, p) for rt, p in _walk(_app.routes) if p.startswith("/api/")]
    targets = []
    for rt, path in routes:
        if "GET" not in (rt.methods or set()):
            continue
        if not path.startswith("/api/"):
            continue
        if any(x in path for x in ("/apk", "/logs/download", "/export/", "/files", "download")):
            continue                                  # 大文件/二进制，脏参数没意义还费流量
        params = _numeric_params(rt)
        if not params:
            continue
        real = path
        if "{" in path:                               # 路径参数给个"不存在"的值：期望 404
            import re
            real = re.sub(r"\{[^}]+\}", "zz-没有这个", path)
        targets.append((real, params))

    print(f"共 {len(targets)} 个 GET 接口带数值/布尔参数")
    bad = 0
    for path, params in targets:
        vals = DIRTY_BOOL if False else DIRTY
        for name, is_bool in params:
            pool = DIRTY_BOOL if is_bool else vals
            for dirty in (pool[:1] if SAMPLE else pool):
                q = {"projectRoot": BOOK, "slug": BOOK}
                q[name] = dirty
                t0 = time.time()
                try:
                    rr = cli.get(path, params=q)
                    code = rr.status_code
                    body = rr.text[:200]
                except Exception as e:                # 连不上也算不合格
                    code, body = 0, str(e)[:200]
                ms = int((time.time() - t0) * 1000)
                ok = code in (200, 400, 401, 403, 404, 405, 422)
                RESULTS.append({"path": path, "param": name, "value": dirty[:20],
                                "status": code, "ms": ms, "ok": ok,
                                "why": "" if ok else "脏参数把服务打成了 5xx/连不上",
                                "snippet": "" if ok else body})
                if not ok:
                    bad += 1
                    print(f"  ✗ {path}  ?{name}={dirty[:12]!r} → {code}  {body[:90]}")
    bad += badinput_body(cli)
    total = len(RESULTS)
    print(f"\n=== 错误参数：{total} 次请求，不合格 {bad} ===")
    (ROOT / "docs" / "错误参数实测.json").write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE,
        "endpoints": len(targets), "requests": total, "bad": bad,
        "results": RESULTS}, ensure_ascii=False, indent=1), "utf-8")
    print("报告：docs/错误参数实测.json")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
