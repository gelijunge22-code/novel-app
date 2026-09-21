#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提示词库实测（阶段 17.1 / 17.2）：真登录、真存、真回滚，并证明它**真的进了系统提示词**。

跑法：server/venv/bin/python tools/verify_prompts.py
全程用全局作用域，跑完把改动删干净（绝不碰用户数据）。
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8899"
SLUG = "example-book"
MARK1 = "【自测标记一-7f31】遇到这个标记说明用的是自定义人设"
MARK2 = "【自测标记二-7f32】这是第二版"
results: list[tuple[str, bool, str]] = []


def pw() -> str:
    for p in ("/home/ubuntu/nbapp/config.json", "server/config.json"):
        f = Path(p)
        if f.exists():
            try:
                d = json.loads(f.read_text("utf-8"))
                v = d.get("app_password") or d.get("password")
                if v:
                    return str(v)
            except Exception:
                pass
    return ""


class C:
    def __init__(self):
        self.cookie = ""
        self.op = urllib.request.build_opener()

    def call(self, path, method="GET", body=None):
        req = urllib.request.Request(BASE + path, method=method)
        if self.cookie:
            req.add_header("cookie", self.cookie)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, data) as r:
                sc = r.headers.get("set-cookie")
                if sc:
                    self.cookie = sc.split(";")[0]
                txt = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(txt) if txt.strip().startswith(("{", "[")) else txt)
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(txt)
            except Exception:
                return e.code, txt


def check(name: str, ok: bool, why: str = "") -> bool:
    results.append((name, bool(ok), why))
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:200]))
    return bool(ok)


def main() -> int:
    c = C()
    st, d = c.call("/api/app/login", "POST", {"password": pw()})
    if st != 200:
        print("登录失败", st, d)
        return 1
    print("登录 ok")

    # ⓪ 开跑前先自愈：别的自测脚本可能在这两个作用域留了覆盖，先清干净（只清自测会动的那两个）
    KEYS = ["leader.default", "writer", "inline.editor", "researcher", "world.engine"]
    for scope, sl in (("book", SLUG), ("global", "")):
        for k in KEYS:
            q = "key=%s&scope=%s" % (k, scope) + (("&slug=" + SLUG) if sl else "")
            c.call("/api/prompts/override?" + q, "DELETE")
            c.call("/api/prompts/versions?" + q, "DELETE")

    # ① 列表：内置的 5 个人设都在，且现在用的是内置
    st, d = c.call("/api/prompts")
    items = d.get("items", []) if isinstance(d, dict) else []
    check("① 提示词列表返回内置人设", st == 200 and len(items) >= 5,
          f"status={st} n={len(items)}")
    wr = next((i for i in items if i["key"] == "writer"), None)
    check("① 未改过时来源是 builtin", bool(wr) and wr["source"] == "builtin", wr and wr["source"])
    check("① 列表里带内置正文（能对比/能恢复）", bool(wr) and len(wr["builtin"]) > 50,
          wr and len(wr.get("builtin") or ""))

    # ② 保存一份全局覆盖 → 版本 1
    st, d = c.call("/api/prompts/save", "POST",
                   {"key": "writer", "scope": "global", "body": MARK1, "note": "自测第一版"})
    check("② 保存自定义人设（v1）", st == 200 and d.get("version") == 1, f"{st} {d}")

    # ③ 它真的进了系统提示词（不是摆着看的）
    st, d = c.call(f"/api/write/context?slug={SLUG}")
    sysp = (d or {}).get("system", "") if isinstance(d, dict) else ""
    check("③ 自定义人设进了系统提示词", MARK1 in sysp, "system 里没有标记")

    # ④ 版本列表：刚存的那一版排在最前，号是往上走的（不跟旧历史撞号）
    st, d = c.call("/api/prompts/versions?key=writer&scope=global")
    vs = d.get("versions", []) if isinstance(d, dict) else []
    check("④ 版本列表最新一版带备注、号不撞车",
          bool(vs) and vs[0]["note"] == "自测第一版"
          and vs[0]["version"] == max(v["version"] for v in vs)
          and len({v["version"] for v in vs}) == len(vs), vs[:3])

    # ⑤ 再存一版 → 版本 2；这时拿 v1 跟现在比，diff 必须真的列出差别
    v1 = vs[0]["version"]
    st, d = c.call("/api/prompts/save", "POST",
                   {"key": "writer", "scope": "global", "body": MARK2, "note": "自测第二版"})
    check("⑤ 再存一版 = 版本号 +1", st == 200 and (d or {}).get("version") == v1 + 1, f"{st} {d} {v1}")
    st, d = c.call(f"/api/prompts/diff?key=writer&version={v1}&scope=global")
    dl = (d or {}).get("diff") or []
    check("⑤ 能拿历史版本跟现在比（diff 列出差别）",
          st == 200 and any(l.startswith("-") and MARK1 in l for l in dl)
          and any(l.startswith("+") and MARK2 in l for l in dl), f"{st} {dl[:6]}")

    # ⑥ 回滚到 v1 → 新增 v3，正文回到 MARK1
    st, d = c.call("/api/prompts/rollback", "POST",
                   {"key": "writer", "scope": "global", "version": v1})
    ok_roll = st == 200 and d.get("from") == v1 and d.get("version") == v1 + 2
    st, d = c.call("/api/prompts/versions?key=writer&scope=global")
    cur = (d or {}).get("current", "")
    check("⑥ 回滚到旧版本 = 新增一版且正文回退", ok_roll and MARK1 in cur,
          f"{st} current={cur[:40]!r}")
    check("⑥ 回滚也是一条历史（备注写着回滚）",
          any(v["version"] == v1 + 2 and "回滚" in v["note"] for v in (d or {}).get("versions", [])),
          (d or {}).get("versions"))

    # ⑦ 恢复内置：删掉覆盖 → 回到 builtin，系统提示词里不再有标记
    st, d = c.call("/api/prompts/override?key=writer&scope=global", "DELETE")
    check("⑦ 删除覆盖后回到内置", st == 200 and (d or {}).get("removed") is True, f"{st} {d}")
    st, d = c.call("/api/prompts")
    wr = next((i for i in (d.get("items") or []) if i["key"] == "writer"), None)
    check("⑦ 来源回到 builtin", bool(wr) and wr["source"] == "builtin" and wr["version"] == 0,
          wr and (wr["source"], wr["version"]))
    st, d = c.call(f"/api/write/context?slug={SLUG}")
    check("⑦ 系统提示词里标记已消失", MARK1 not in (d or {}).get("system", ""), "")

    # ⑧ 片段（Snippet）
    st, d = c.call("/api/snippets/save", "POST",
                   {"key": "selftest-snip", "name": "自测片段", "body": "把这段塞进提示词", "tags": "自测"})
    check("⑧ 存片段", st == 200, f"{st} {d}")
    st, d = c.call("/api/snippets")
    got = next((x for x in (d.get("items") or []) if x["key"] == "selftest-snip"), None)
    check("⑧ 片段能列出来且内容对", bool(got) and got["body"] == "把这段塞进提示词", got)
    st, d = c.call("/api/snippets?key=selftest-snip", "DELETE")
    st, d = c.call("/api/snippets")
    check("⑧ 片段删掉了（跑完不留垃圾）",
          all(x["key"] != "selftest-snip" for x in (d.get("items") or [])), d)

    # ⑨ 收尾：两个作用域都恢复内置、历史清空（用户的提示词库不该被自测污染）
    for scope, sl in (("book", SLUG), ("global", "")):
        for k in KEYS:
            q = "key=%s&scope=%s" % (k, scope) + (("&slug=" + SLUG) if sl else "")
            c.call("/api/prompts/override?" + q, "DELETE")
            c.call("/api/prompts/versions?" + q, "DELETE")
    st, d = c.call("/api/prompts/versions?key=writer&scope=global")
    check("⑨ 自测留下的版本历史清干净", (d or {}).get("versions") == [], (d or {}).get("versions"))
    bad_left = []
    for u in ("/api/prompts", "/api/prompts?slug=" + SLUG):
        st, d = c.call(u)
        bad_left += ["%s:%s" % (i["key"], i["source"]) for i in (d.get("items") or [])
                     if i["source"] != "builtin"]
    check("⑨ 两个作用域都回到内置（跑完不留痕）", not bad_left, bad_left)

    bad = [r for r in results if not r[1]]
    print("\n=== 共 %d 项：通过 %d，失败 %d ===" % (len(results), len(results) - len(bad), len(bad)))
    out = Path("docs/提示词库实测.json")
    out.write_text(json.dumps({"at": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
                               "total": len(results), "ok": len(results) - len(bad),
                               "fail": len(bad),
                               "results": [{"name": n, "ok": o, "why": w} for n, o, w in results]},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print("报告：", out)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
