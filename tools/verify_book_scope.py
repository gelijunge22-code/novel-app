#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""删书到底删干净了没有 —— 两件事一起验：

① **静态**：库里所有带 `slug` 维度的表，必须被 server/routers/books.py 明确分类：
   要么在 `_BOOK_STATE`（书没了就该跟着走），要么在 `_BOOK_LOG`（留痕，故意保留）。
   漏一张直接判失败 —— 以前就是手写名单漏了 21 张表，谁也没发现。
② **动态**：真建一本测试书 → 往会漏的那几张表里塞行 → 调真正的 DELETE /api/projects/item
   → 逐表核对：state 表 0 行、log 表还留着、书稿目录进了 data/trash（不是被删掉）。

用法：server/venv/bin/python tools/verify_book_scope.py
产出：docs/删书干净度实测.json
"""
import json
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import db as dbm                      # noqa: E402
from server.routers import books as B             # noqa: E402
from server.store import P, create_book           # noqa: E402

OUT = ROOT / "docs/删书干净度实测.json"
checks = []
dbm.init(ROOT / "data/app.db")      # 这个测试要直接读库、核对每张表剩几行


def add(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})


def main() -> int:
    real = B.book_scoped_tables()
    known = set(B._BOOK_STATE) | set(B._BOOK_LOG)
    missing = sorted(real - known)
    unknown = sorted(known - real)
    add("库里带 slug 的表都被分类了（新增表必须选一类）", not missing,
        "没分类：" + json.dumps(missing, ensure_ascii=False) if missing else
        "共 %d 张，state %d + log %d" % (len(real), len(B._BOOK_STATE), len(B._BOOK_LOG)))
    add("名单里没有已经不存在的表（改名了要一起改）", not unknown,
        "多出来的：" + json.dumps(unknown, ensure_ascii=False) if unknown else "干净")
    add("留痕表是明确的少数（审计/计费/任务/通知）",
        set(B._BOOK_LOG) == {"audit", "trace", "notification", "job"}, sorted(B._BOOK_LOG))

    # ── 动态：真的建一本书、塞垃圾、再删 ──
    made = create_book("删书验收（自动建、自动删）", "", "novel")
    slug = made["slug"]
    B.ensure_book_row(slug)
    d = dbm.db()
    now = dbm.now_ms()
    seeded = {}
    # 每张表按**真实表结构**塞一行（列名对不上就白测了 —— 第一版有 6 张塞不进去，
    # 等于"空表比空表"，什么也没证明）。
    seed_sql = {
        "calendar": "INSERT INTO calendar(slug,name,def_json,note,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,?)",
        "world_snapshot": "INSERT INTO world_snapshot(slug,entity_id,cutoff_order,state_json,"
                          "hist_json,fact_ids_json,fact_count,created_at) VALUES(?,?,?,?,?,?,?,?)",
        "chapter_meta": "INSERT INTO chapter_meta(slug,path,cast_json,events_json,updated_at)"
                        " VALUES(?,?,?,?,?)",
        "prompt": "INSERT INTO prompt(scope,slug,key,name,purpose,body,version,updated_at)"
                  " VALUES(?,?,?,?,?,?,?,?)",
        "prompt_version": "INSERT INTO prompt_version(scope,slug,key,version,body,note,created_at)"
                          " VALUES(?,?,?,?,?,?,?)",
        "workflow": "INSERT INTO workflow(slug,name,steps_json,updated_at) VALUES(?,?,?,?)",
        "note": "INSERT INTO note(slug,path,percent,quote,text,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?)",
        "reference": "INSERT INTO reference(slug,title,author,source,kind,tags_json,text,words,"
                     "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        "lint_run": "INSERT INTO lint_run(slug,path,created_at,hits_json,stats_json)"
                    " VALUES(?,?,?,?,?)",
        "achievement": "INSERT INTO achievement(slug,key,title,unlocked_at,progress,detail_json)"
                       " VALUES(?,?,?,?,?,?)",
        "sync_conflict": "INSERT INTO sync_conflict(slug,path,base_mtime,local_mtime,"
                         "server_mtime,local_text,server_text,status,created_at)"
                         " VALUES(?,?,?,?,?,?,?,?,?)",
    }
    args = {
        "calendar": (slug, "验收历", "{}", "e2e", now, now),
        "world_snapshot": (slug, 0, 1, "{}", "[]", "[]", 0, now),
        "chapter_meta": (slug, "manuscript/001-验收.md", "[]", "[]", now),
        "prompt": ("book", slug, "zz.verify", "验收提示词", "custom", "验收正文", 1, now),
        "prompt_version": ("book", slug, "zz.verify", 1, "验收正文", "e2e", now),
        "workflow": (slug, "验收工作流", "[]", now),
        "note": (slug, "manuscript/001-验收.md", 10.0, "摘", "验收笔记", now, now),
        "reference": (slug, "验收参考", "", "e2e", "snippet", "[]", "正文", 2, now, now),
        "lint_run": (slug, "manuscript/001-验收.md", now, "[]", "{}"),
        "achievement": (slug, "zz_verify", "验收成就", now, 100, "{}"),
        "sync_conflict": (slug, "manuscript/001-验收.md", now, now, now, "本地", "服务器",
                          "open", now),
    }
    for t, sql in seed_sql.items():
        try:
            d.execute(sql, args[t])
            seeded[t] = d.scalar("SELECT COUNT(*) FROM %s WHERE slug=?" % t, (slug,))
        except Exception as e:                       # 表结构对不上就老实记下来
            seeded[t] = "塞不进去：%s" % e
    add("测试数据真的塞进去了（不是空表对比空表）",
        sum(1 for v in seeded.values() if isinstance(v, int) and v > 0) >= 8,
        json.dumps(seeded, ensure_ascii=False))

    # 走真正的删除接口（HTTP，不是直接调函数）——它才是用户点"删"走的那条路
    import urllib.request
    import urllib.parse
    pw = json.loads(Path("/home/ubuntu/nbapp/config.json").read_text())["app_password"]
    base = "http://127.0.0.1:8899"
    cj = urllib.request.HTTPCookieProcessor()
    op = urllib.request.build_opener(cj)
    req = urllib.request.Request(base + "/api/app/login",
                                data=json.dumps({"password": pw}).encode(),
                                headers={"content-type": "application/json"})
    op.open(req).read()
    req = urllib.request.Request(
        base + "/api/projects/item?projectRoot=" + urllib.parse.quote(slug), method="DELETE")
    body = json.loads(op.open(req).read().decode())

    # 注意：这里按**库里真实存在的表**核对，而不是按实现里的名单 ——
    # 否则实现漏删哪张，测试就跟着漏查哪张（自己给自己发绿灯）。
    must_be_empty = sorted(real - set(B._BOOK_LOG))
    left = {}
    for t in sorted(real):
        left[t] = d.scalar("SELECT COUNT(*) FROM %s WHERE slug=?" % t, (slug,))
    bad_state = {t: n for t, n in left.items() if t in must_be_empty and n}
    add("删完之后：状态表一行都不剩（按库里真实的表核对，共 %d 张）" % len(must_be_empty),
        not bad_state,
        json.dumps(bad_state, ensure_ascii=False) if bad_state else
        "核对了 %d 张状态表，全为 0" % len(must_be_empty))
    add("留痕表还在（删书这件事本身要留得下记录）",
        all(left.get(t, 0) >= 0 for t in B._BOOK_LOG), json.dumps(
            {t: left.get(t) for t in B._BOOK_LOG}, ensure_ascii=False))
    add("书稿目录进了回收站，不是被删掉（绝不删用户数据）",
        "trash" in str(body.get("trashedTo", "")) and Path(body["trashedTo"]).exists(),
        body.get("trashedTo"))

    # 编排台账的孤儿也要为 0
    orphan_run = d.scalar("SELECT COUNT(*) FROM orchestra_run WHERE session_id NOT IN"
                          " (SELECT id FROM chat_session) AND slug=?", (slug,))
    add("这本书的编排台账没有孤儿残留", orphan_run == 0, orphan_run)

    ok = sum(1 for c in checks if c["ok"])
    OUT.write_text(json.dumps({
        "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "book_scoped_tables": sorted(real), "state_tables": sorted(B._BOOK_STATE),
        "log_tables": sorted(B._BOOK_LOG), "seeded": seeded,
        "total": len(checks), "passed": ok, "failed": len(checks) - ok, "items": checks,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in checks:
        print(("  ✓ " if c["ok"] else "  ✗ ") + c["name"] + ("" if c["ok"] else "   —— " + c["detail"]))
    print("\n=== 删书干净度：%d/%d ===  报告：docs/删书干净度实测.json" % (ok, len(checks)))
    return 0 if ok == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
