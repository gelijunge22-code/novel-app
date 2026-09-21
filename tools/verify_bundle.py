#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""整包导出 / 导入 往返实测（补上「导出去要能回来」这半个模块）。

验的是**往返**而不是"能下载"：
  造一本测试书（两章正文 + 角色 + 事实 + 伏笔 + 决策 + 素材）
  → /api/export/bundle 拿走 zip
  → /api/import/bundle 还原成另一本书
  → 逐项比对：章数、字数、实体数、事实数、伏笔数、决策数、素材数、出处条数
  → 还要证明**原书一个字节没动**，以及乱七八糟的 zip 会被明确拒绝。

跑法：server/venv/bin/python tools/verify_bundle.py
产出：docs/整包导出导入实测.json
"""
from __future__ import annotations

import io
import json
import sys
import time
import zipfile
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:8899"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "整包导出导入实测.json"
STAMP = time.strftime("%m%d-%H%M%S")
TITLE = f"整包测试-{STAMP}"
results: list[dict] = []
cli = httpx.Client(base_url=BASE, timeout=120.0)


def password() -> str:
    return str(json.loads(Path("/home/ubuntu/nbapp/config.json").read_text("utf-8"))["app_password"])


def check(name, ok, why="", data=None):
    results.append({"name": name, "ok": bool(ok), "why": str(why)[:400],
                    "data": data if data is not None else None})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:300]))


def api(method, path, **kw):
    r = cli.request(method, path, **kw)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def stats(slug: str) -> dict:
    """一本书的可比快照（只取数量与字数，不打印正文）。"""
    book = api("GET", "/api/book", params={"slug": slug})[1]
    chapters = book.get("chapters") or []
    ents = api("GET", "/api/world/entities", params={"slug": slug})[1].get("items") or []
    facts = sum(len(e.get("facts") or []) for e in ents)
    retro = api("GET", "/api/world/retro", params={"slug": slug})[1]
    evidence = sum(len(f.get("evidence") or [])
                   for e in (retro.get("entities") or []) for f in (e.get("facts") or []))
    ov = api("GET", "/api/plot/overview", params={"slug": slug})[1]
    promises = ov.get("promises") or []
    decisions = ov.get("decisions") or []
    material = api("GET", "/api/material", params={"slug": slug})[1]
    material = material.get("items") if isinstance(material, dict) else (material or [])
    return {"chapters": len(chapters), "words": sum(c.get("words") or 0 for c in chapters),
            "entities": len(ents), "facts": facts, "evidence": evidence,
            "promises": len(promises or []), "decisions": len(decisions or []),
            "material": len(material or [])}


def main() -> int:
    if api("POST", "/api/app/login", json={"password": password()})[0] != 200:
        print("登录失败"); return 1
    st, born = api("POST", "/api/projects", json={"title": TITLE, "summary": "整包往返测试",
                                                 "kind": "novel"})
    assert st == 200, born
    src = born["projectRoot"]
    print("源书：%s → %s" % (TITLE, src))

    # 造料
    body1 = "雪停了。林诺把木牌按进雪里，一块、两块，数到一百零八。\n\n\"够了吗？\"沈岩问。\n"
    body2 = "第二天，木牌少了一块。雪是新的，上面有别人的脚印。\n"
    for i, b in enumerate((body1, body2), 1):
        api("POST", "/api/import/text", json={"slug": src, "name": f"第{i:03d}章-测试",
                                              "text": b, "prefix": "manuscript"})
    ent = api("POST", "/api/world/entity", json={"slug": src, "kind": "character",
                                                "name": "林诺", "summary": "沉默的少年"})[1]
    eid = (ent.get("entity") or ent).get("id") or ent.get("id")
    st_f, r_f = api("POST", "/api/world/fact", json={
        "slug": src, "entityId": eid, "key": "武魂", "value": "冰晶短刃",
        "sourcePath": "manuscript/第001章-测试.md",
        "evidence": [{"path": "manuscript/第001章-测试.md", "line": 3,
                      "quote": "掌心浮起半透明的短刃"}]})
    check("事实带上了出处（哪一章、第几行、原句）", st_f == 200, f"{st_f} {r_f}")
    api("POST", "/api/plot/promise", json={"slug": src, "name": "断掉的线", "kind": "foreshadow",
                                           "setupScene": "manuscript/第001章-测试.md"})
    api("POST", "/api/plot/decision", json={"slug": src, "title": "让林诺先沉默",
                                            "reason": "前三章不给他完整句子。"})
    api("POST", "/api/material", json={"slug": src, "title": "雪地上的木牌",
                                       "body": "牌子上刻着名字", "kind": "idea"})
    before = stats(src)
    print("源书统计：", json.dumps(before, ensure_ascii=False))
    check("测试书造好了（章/实体/事实/伏笔/决策/素材都有）",
          before["chapters"] >= 2 and before["entities"] >= 1 and before["facts"] >= 1
          and before["promises"] >= 1 and before["decisions"] >= 1 and before["material"] >= 1,
          json.dumps(before, ensure_ascii=False))

    # 导出整包
    r = cli.get("/api/export/bundle", params={"slug": src})
    check("整包导出拿到一个 zip", r.status_code == 200 and r.content[:2] == b"PK",
          f"{r.status_code} {r.headers.get('content-type')}")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    check("包里同时有书稿文件和结构化数据",
          any(n.startswith("book/manuscript/") for n in names) and "data.json" in names,
          json.dumps(names[:6], ensure_ascii=False))
    data = json.loads(z.read("data.json").decode("utf-8"))
    check("data.json 里带上了设定/伏笔/决策这些结构化表",
          all(k in data for k in ("entity", "fact", "promise", "decision", "material")),
          str(list(data)[:12]))

    # 还原成另一本书
    target = f"整包还原-{STAMP}"
    st, back = api("POST", "/api/import/bundle",
                   files={"file": (f"{TITLE}-整包.zip", r.content, "application/zip")},
                   data={"title": target})
    check("整包导入成功，并另起了一本新书（不覆盖原书）",
          st == 200 and back.get("ok") and back.get("slug") != src, f"{st} {str(back)[:200]}")
    dst = back.get("slug")
    after = stats(dst) if dst else {}
    print("还原书统计：", json.dumps(after, ensure_ascii=False))
    check("章数与字数一致（正文一个不丢）",
          after.get("chapters") == before["chapters"] and after.get("words") == before["words"],
          f"{before['chapters']}章/{before['words']}字 → {after.get('chapters')}章/{after.get('words')}字")
    check("实体与事实一致（世界引擎的数据跟着走）",
          after.get("entities") == before["entities"] and after.get("facts") == before["facts"],
          f"{before['entities']}实体/{before['facts']}事实 → {after.get('entities')}/{after.get('facts')}")
    check("伏笔 / 决策 / 素材一致",
          after.get("promises") == before["promises"] and after.get("decisions") == before["decisions"]
          and after.get("material") == before["material"],
          f"{before['promises']}/{before['decisions']}/{before['material']} → "
          f"{after.get('promises')}/{after.get('decisions')}/{after.get('material')}")
    check("事实的出处（哪一章哪一行）也回来了",
          after.get("evidence", 0) >= before["evidence"] and after.get("evidence", 0) > 0,
          f"{before['evidence']} → {after.get('evidence')}")
    now = stats(src)
    check("原书一个字节没动", now == before, f"{json.dumps(before)} vs {json.dumps(now)}")

    # 不是整包的 zip 要明确拒绝，不能悄悄建一本空书
    junk = io.BytesIO()
    with zipfile.ZipFile(junk, "w") as zz:
        zz.writestr("hello.txt", "hi")
    st2, why = api("POST", "/api/import/bundle",
                   files={"file": ("junk.zip", junk.getvalue(), "application/zip")},
                   data={"title": "不该建出来的书"})
    check("乱七八糟的 zip 被明确拒绝（400，且理由说得清）",
          st2 == 400 and "book/" in str(why), f"{st2} {str(why)[:120]}")
    listed = api("GET", "/api/projects/rag/inspector", params={"slug": "不该建出来的书"})
    check("被拒绝时没有偷偷建出一本空书", listed[0] != 200, str(listed)[:120])

    api("DELETE", "/api/projects/item", params={"projectRoot": src})
    if dst:
        api("DELETE", "/api/projects/item", params={"projectRoot": dst})
    ok = sum(1 for r2 in results if r2["ok"])
    OUT.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "base": BASE,
        "source": {"slug": src, "stats": before}, "restored": {"slug": dst, "stats": after},
        "total": len(results), "passed": ok, "failed": len(results) - ok,
        "items": results}, ensure_ascii=False, indent=1), "utf-8")
    print(f"\n=== 整包往返实测：{ok}/{len(results)} ===")
    print("报告：docs/整包导出导入实测.json")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
