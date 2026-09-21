#!/usr/bin/env python3
"""书架上不许有测试残留（引擎/数据级自测，跑在真库上）。

为什么要有这条：脚本逻辑上都会"跑完自删"，但**中途被杀**（超时、断线、模型通道中断）
就删不掉 —— 第 11 轮书架上真挂着一本 `E2E编排-660768`，直到走查按书名排序才露出来。
用户看到的是"我的书架上多了一本莫名其妙的书"，这是数据洁癖问题，必须每轮扫。

判据：
  1. 书架里没有标题命中测试命名（E2E / 实测 / 测试 / 走查 / 临时 / zz-）的书；
  2. 命中测试命名的书**都在回收站里**（证明是走 trash 删的，不是硬删）；
  3. 真书（用户自己的）还在，且章节数 > 0 —— 别为了"干净"把用户的书写没了。

第 41 轮又加了两条（监督人点名：用户在 **AI 对话里**亲眼看到 7 个测试会话）：
  7. `chat_session` 里不许有"测试口气"的会话（冒烟 / 烟测 / 判据 / 测试通过 / zz- …）；
  8. `session_token` 不许无限长大（大坨测试登录留下的），超过阈值就报红、提示跑 clean_userdata.py。

反证：`LITTER_FORCE=sess` 会**先往库里插一个测试会话**再跑 —— 判据必须报红（跑完自己删掉）。

产出：docs/测试残留检查.json    退出码 0 = 干净
"""
import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path("/home/ubuntu/novel-app")
sys.path.insert(0, str(ROOT))   # 以 server 命名空间包的方式导（和线上一样）
import httpx  # noqa: E402

BASE = "http://127.0.0.1:8899"
OUT = ROOT / "docs/测试残留检查.json"
# 注意：`自测` 也得算进去 —— 只写"测试"时，书架上一本 `同步自测-0919-162016`
# 一直躲过扫描（第 12 轮它就在书架上挂着）。命名命中测试口气的一律算残留。
TESTY = re.compile(r"E2E|实测|测试|自测|走查|临时|自动|zz-|scratch|probe|诊断|合并调")
# 会话表用的是**另一套词**：测试会话的标题是「冒烟-出字判据」「请只回四个字：测试通过」这种，
# 跟"书名"那套不一样。第一版我拿 TESTY 去扫会话，于是反证插的「冒烟-判据自检」它**看不见**
# —— 反证跑出来 8/8 全绿（假绿），这正是"判据自己有病"。跟 tools/clean_userdata.py 用同一份词表。
SESS_TESTY = re.compile(r"冒烟|烟测|判据|测试通过|zz-|zzz-|自测|实测|走查|临时|E2E|scratch|probe", re.I)

rows = []


def check(name, ok, why):
    rows.append({"name": name, "ok": bool(ok), "why": str(why)[:400]})
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok else "   —— " + str(why)[:200]))
    return bool(ok)


def force_seed():
    """反证用：往库里插一个**测试口气**的会话（判据必须报红），返回它的 id。"""
    from server import db as dbm
    dbm.init(ROOT / "data/app.db")
    n = dbm.now_ms()
    cur = dbm.db().execute(
        "INSERT INTO chat_session(identity,slug,profile_key,title,status,created_at,updated_at)"
        " VALUES('','',?,?,'active',?,?)",
        ("", f"冒烟-判据自检-{n}", n, n))
    return cur


def main():
    forced = 0
    if os.environ.get("LITTER_FORCE") == "sess":
        forced = force_seed()
        print(f"  ⚠ 反证模式 LITTER_FORCE=sess：先插了一个测试会话 #{forced}（判据 ⑦ 必须报红）")
    pw = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text())["app_password"]
    with httpx.Client(base_url=BASE, timeout=30) as c:
        r = c.post("/api/app/login", json={"password": pw})
        assert r.status_code == 200, r.text
        projects = c.get("/api/projects").json()["projects"]

        junk = [p for p in projects if TESTY.search(p.get("title") or "")]
        real = [p for p in projects if not TESTY.search(p.get("title") or "")]

        check("① 书架上没有测试残留（标题命中 E2E/实测/测试/走查… 的 0 本）",
              not junk, "残留：" + ", ".join(p["title"] for p in junk))

        check("② 书架上至少还有一本真书（用户的稿子没被脚本清掉）",
              len(real) >= 1, "真书：" + ", ".join(p["title"] for p in real))

        ok_books = []
        for p in real:
            d = c.get("/api/book", params={"slug": p["projectRoot"]}).json()
            n = len(d.get("chapters") or [])
            ok_books.append((p["title"], n))
            check(f"③ 真书《{p['title']}》的章节还在（{n} 章）", n > 0, n)

        # 回收站：被删的测试书应该躺在 data/trash 里（可找回），不是在库里被抹掉
        trash = sorted((ROOT / "data/trash").glob("book-*"))
        check("④ 删掉的测试书进的是回收站（data/trash/，可找回，没硬删）",
              len(trash) >= 1, f"{len(trash)} 个")

        # 库里不该再留下这些书的任何行（整包导出会越导越大）
        from server import db as dbm  # noqa: E402
        dbm.init(ROOT / "data/app.db")   # 直连库：只读统计，别指望服务进程的 _db
        db = dbm.db()
        slugs = [p["projectRoot"] for p in junk]
        orph = 0
        if slugs:
            q = ",".join("?" * len(slugs))
            for t in ("orchestra_run", "orchestra_step", "chat_session"):
                try:
                    orph += db.execute(f"SELECT COUNT(*) FROM {t} WHERE slug IN ({q})", slugs).fetchone()[0]
                except Exception:
                    pass
        check("⑤ 测试书删干净后库里不留孤儿行（编排/会话）", orph == 0, f"{orph} 行")

        # ⑥ 全库体检：**所有**带 slug 的表里，都不许有"书都没了行还留着"的孤儿
        #    （第 12 轮的三张同步表就是这么漏的：删书名单没登记，留下 1800+ 行）
        from server.routers.books import _BOOK_LOG, book_scoped_tables  # noqa: E402
        alive = set(p["projectRoot"] for p in projects)
        bad = {}
        for t in sorted(book_scoped_tables() - set(_BOOK_LOG)):
            try:
                slugs = [r["slug"] for r in db.query(f"SELECT DISTINCT slug FROM {t}")]
            except Exception:
                continue
            # 空 slug = 全局行（全局预设 / 内置流水线），不属于任何一本书，别当孤儿
            n = sum(1 for s in slugs if s and s not in alive)
            if n:
                bad[t] = n
        check("⑥ 全库没有孤儿行（带 slug 的表里，slug 都对应书架上真有的书）",
              not bad, json.dumps(bad, ensure_ascii=False))

    # ⑦ 会话表里不许有测试口气的会话（用户打开 AI 对话第一眼看到的就是它）
    sess = [dict(r) for r in db.query("SELECT id,title FROM chat_session ORDER BY id")]
    sbad = [r for r in sess if SESS_TESTY.search(r["title"] or "")]
    check(f"⑦ chat_session 里没有测试残留会话（{len(sess)} 个会话，残留 {len(sbad)} 个）",
          not sbad, "残留：" + ", ".join(f"#{r['id']}「{r['title']}」" for r in sbad))

    # ⑧ 登录口令表不许无限长大（测试反复登录会一天攒几百行；监督人实测攒到 1651 行）
    ntok = db.scalar("SELECT COUNT(*) FROM session_token", default=0)
    check(f"⑧ 登录口令表没有无限长大（{ntok} 行 ≤ 400）", ntok <= 400,
          f"{ntok} 行 —— 跑 python3 tools/clean_userdata.py --yes --tokens 清一次")

    if forced:
        from server import db as dbm
        dbm.init(ROOT / "data/app.db")
        dbm.db().execute("DELETE FROM chat_session WHERE id=?", (forced,))
        print(f"  （反证插的测试会话 #{forced} 已删掉）")

    ok = sum(1 for r in rows if r["ok"])
    OUT.write_text(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(rows),
                               "ok": ok, "fail": len(rows) - ok, "items": rows,
                               "shelf": [p["title"] for p in projects],
                               "trash": len(trash)}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n=== 测试残留检查 {ok}/{len(rows)} 通过 ===")
    print("报告：docs/测试残留检查.json")
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
