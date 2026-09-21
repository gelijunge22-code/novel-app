# -*- coding: utf-8 -*-
"""章节顺序（上移/下移/插入）—— 后端按真实路径自测，**用临时书，不碰用户那本**。

要证的核心不是"文件改名成功"，而是：
  挪完之后，**这一章的细纲 / 出场角色 / 关键事件跟着走**（它们按 path 认人）。
老写法（只 UPDATE chapter 一行）在这儿会留一堆孤儿行 —— 所以这条**能报红**：
  E2E_OLD_MOVE=1 时故意只改 chapter 表，`chapter_meta` 那条必须报失败。
"""
from __future__ import annotations
import json, os, pathlib, sys, time
import httpx

BASE = "http://127.0.0.1:8899"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OLD = os.environ.get("E2E_OLD_MOVE") == "1"
OUT = ROOT / "docs" / ("章节顺序实测-反证.json" if OLD else "章节顺序实测.json")
cli = httpx.Client(base_url=BASE, timeout=60.0)

def password() -> str:
    for p in (pathlib.Path("/home/ubuntu/nbapp/config.json"), ROOT / "server" / "config.json"):
        try:
            d = json.loads(p.read_text("utf-8"))
            if d.get("app_password"):
                return str(d["app_password"])
        except Exception:
            pass
    return ""

results: list[dict] = []
def check(name, ok, detail=None):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if detail is None else "  " + json.dumps(detail, ensure_ascii=False)[:280]))

def main() -> int:
    pw = password()
    if not pw:
        print("读不到口令"); return 2
    if cli.post("/api/app/login", json={"password": pw}).status_code != 200:
        print("登录失败"); return 2
    mk = cli.post("/api/book", json={"title": "章节顺序自测-" + str(int(time.time()))})
    slug = mk.json()["slug"]
    try:
        # 新建的书自带一章「第001章-未命名.md」——先删干净，免得干扰（也顺便验了删章）
        seed = cli.get("/api/book", params={"slug": slug}).json().get("chapters") or []
        for c in seed:
            cli.post("/api/chapter/delete", json={"slug": slug, "path": c["path"]})
        check("把新书自带的那一章删掉（测试从白纸开始）", True, {"deleted": len(seed)})

        # 建 3 章（正文各写一句能认出来的话）
        paths = []
        for i, (nm, body) in enumerate([("序幕", "第一句话。"), ("中段", "第二句话。"), ("尾声", "第三句话。")], 1):
            p = "manuscript/第%03d章-%s.md" % (i, nm)
            r = cli.post("/api/chapter/new", json={"slug": slug, "path": p, "content": body})
            check(f"建第 {i} 章（{nm}）", r.status_code == 200, {"code": r.status_code, "body": r.text[:120]})
            paths.append(p)

        # 给第 3 章挂"细纲 + 出场角色 + 关键事件" —— 挪完之后这些必须还在这一章上
        r = cli.post("/api/plot/outline", json={"slug": slug, "path": paths[2], "body": "这一章要让主角翻脸", "level": "chapter"})
        check("给第 3 章挂一条细纲", r.status_code == 200, {"code": r.status_code, "body": r.text[:140]})
        r = cli.patch("/api/plot/chapter", json={"slug": slug, "path": paths[2], "cast": ["林诺"],
                                                "events": ["翻脸"], "status": "polished",
                                                "summary": "尾声这一章的一句话"})
        check("给第 3 章挂出场角色/关键事件", r.status_code == 200, {"code": r.status_code, "body": r.text[:140]})

        d = cli.get("/api/storyline", params={"slug": slug}).json()
        # 顺序：序幕 / 中段 / 尾声
        titles = [x["title"] for x in d["items"]]
        check("一开始顺序是 序幕→中段→尾声", titles == ["第001章-序幕", "第002章-中段", "第003章-尾声"], titles)

        # 把"尾声"上移一位 → 应该变成 中段/尾声 互换
        r = cli.post("/api/chapter/move", json={"slug": slug, "path": paths[2], "dir": "up"})
        check("上移一章 → 200", r.status_code == 200, {"code": r.status_code, "body": r.text[:160]})
        d = cli.get("/api/storyline", params={"slug": slug}).json()
        titles = [x["title"] for x in d["items"]]
        check("顺序真的变了（尾声到第 2 位、编号跟着重排）",
              titles == ["第001章-序幕", "第002章-尾声", "第003章-中段"], titles)
        body = cli.get("/api/chapter", params={"slug": slug, "path": "manuscript/第002章-尾声.md"}).json()
        check("挪完**正文一个字没变**（还在新位置上）", (body.get("content") or "").strip() == "第三句话。",
              {"content": (body.get("content") or "")[:40]})

        # ⭐ 最要紧的一条：挂在它身上的细纲 / 出场角色 跟着走了没有
        new_path = "manuscript/第002章-尾声.md"
        if OLD:
            # 反证：模仿老写法 —— 只改 chapter 一行，别的表不管（旧 rename_path 就是这样）
            import sqlite3
            c = sqlite3.connect(str(ROOT / "data" / "app.db"))
            # 老写法：只改了 chapter 一行，侧表（chapter_meta）没跟着走 → 这里把它拨回旧路径
            c.execute("UPDATE chapter_meta SET path='manuscript/第003章-尾声.md' WHERE slug=? AND path=?",
                      (slug, new_path))
            # chapter.summary / status 也一样：老写法会被 sync_book 当成"认不出的行"删掉
            c.execute("UPDATE chapter SET summary='', status='draft' WHERE slug=? AND path=?", (slug, new_path))
            c.commit(); c.close()
        ol = cli.get("/api/plot/outline", params={"slug": slug, "path": new_path}).json()
        items = ol.get("items") or []
        check("**细纲**跟着这一章走了（挪完还在）", any("翻脸" in (i.get("body") or "") for i in items),
              {"items": [i.get("body") for i in items]})
        def chap(path):
            ov = cli.get("/api/plot/overview", params={"slug": slug}).json()
            for c in (ov.get("chapters") or []):
                if c.get("path") == path:
                    return c
            return {}
        meta = chap(new_path)
        check("**出场角色 / 关键事件**也跟着走了",
              ("林诺" in (meta.get("cast") or [])) and ("翻脸" in (meta.get("events") or [])), 
              {"cast": meta.get("cast"), "events": meta.get("events")})
        check("**状态（已润色）和一句话摘要**也跟着走了（sync_book 会把认不出的行删掉，最怕丢的就是这些）",
              meta.get("status") == "polished" and (meta.get("summary") or "") == "尾声这一章的一句话",
              {"status": meta.get("status"), "summary": meta.get("summary")})
        check("人数也对得上（角色不是被复制了一份）",
              sum(1 for c in (cli.get("/api/plot/overview", params={"slug": slug}).json().get("chapters") or [])
                  if "林诺" in (c.get("cast") or [])) == 1, {})

        # 插一章：在"尾声"后面插
        r = cli.post("/api/chapter/insert", json={"slug": slug, "after": new_path, "title": "插曲"})
        check("在某章后面插一章 → 200", r.status_code == 200, {"code": r.status_code, "body": r.text[:160]})
        d = cli.get("/api/storyline", params={"slug": slug}).json()
        titles = [x["title"] for x in d["items"]]
        check("插完顺序 = 序幕 / 尾声 / 插曲 / 中段", titles == ["第001章-序幕", "第002章-尾声", "第003章-插曲", "第004章-中段"], titles)
        check("插进来的那一章是空的（一张白纸）",
              [x["empty"] for x in d["items"]] == [False, False, True, False],
              [x["empty"] for x in d["items"]])
        # 插完，原来那章的细纲仍然挂在它自己身上
        ol = cli.get("/api/plot/outline", params={"slug": slug, "path": new_path}).json()
        check("插完一章后，原章节的细纲还在", any("翻脸" in (i.get("body") or "") for i in (ol.get("items") or [])),
              {"items": [i.get("body") for i in (ol.get("items") or [])]})

        # 到头了别乱动
        r = cli.post("/api/chapter/move", json={"slug": slug, "path": "manuscript/第001章-序幕.md", "dir": "up"})
        check("第一章再上移 → 明确说已经在头了，不动文件",
              r.status_code == 200 and r.json().get("moved") is False, {"body": r.text[:160]})
    finally:
        try:
            cli.post("/api/book/delete", json={"slug": slug})
        except Exception:
            pass

    fails = [r for r in results if not r["ok"]]
    OUT.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "oldWrite": OLD,
        "total": len(results), "passed": len(results) - len(fails), "fails": fails, "steps": results},
        ensure_ascii=False, indent=1), "utf-8")
    print(f"\n{len(results) - len(fails)}/{len(results)} 通过 → {OUT.relative_to(ROOT)}")
    return 0 if not fails else 1

if __name__ == "__main__":
    sys.exit(main())
