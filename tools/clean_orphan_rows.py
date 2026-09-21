#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把库里"书都没了、行还留着"的孤儿行清掉（治删书残留）。

为什么要有这个：
  第 12 轮给同步功能加了三张表（`peer_state` / `peer_file` / `peer_log`），
  它们都带 `slug` 维度，可**忘了登记进 `books._BOOK_STATE`** —— 于是删书只搬走了目录、
  清了别的表，这三张表的行全留下了（真库里当场就是 26 + 538 + 1256 行）。
  表面看不出来，后果是整包导出越导越大、库里越攒越脏。
  根因已经修了（名单补上三张表 + 新增 `heal_book_index()` 清幽灵书），
  这个脚本负责**把历史残留扫干净**，以后每轮也能当体检跑一遍。

规矩：
  * 只删"slug 不在磁盘上的书里"的行 —— 也就是说这本书的目录早就不在 `data/books/` 了；
  * `audit` / `trace` / `notification` / `job` 这四张**留痕表不碰**（故意留的账）；
  * 真书（目录还在）一行都不动；先 dry-run 报告，加 `--apply` 才真删。

用法：
    server/venv/bin/python tools/clean_orphan_rows.py            # 只看不动
    server/venv/bin/python tools/clean_orphan_rows.py --apply    # 真删
产出：docs/孤儿行清理.json
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import db as dbm                                   # noqa: E402
from server.routers.books import _BOOK_LOG, book_scoped_tables  # noqa: E402

OUT = ROOT / "docs/孤儿行清理.json"
APPLY = "--apply" in sys.argv


def main() -> int:
    dbm.init(ROOT / "data/app.db")
    d = dbm.db()
    books = ROOT / "data" / "books"
    alive = {p.name for p in books.iterdir() if p.is_dir() and not p.name.startswith(".")} \
        if books.is_dir() else set()

    tables = sorted(book_scoped_tables())          # 库里真有 slug 维度的表
    rows, total = [], 0
    for t in tables:
        keep_log = t in _BOOK_LOG
        slugs = [str(r["slug"]) for r in d.query(f"SELECT DISTINCT slug FROM {t}")]
        # `slug=''` 是**全局行**（全局预设、内置流水线），它不属于任何一本书 —— 不是孤儿！
        # 第一版忘了这一条，把全局预设那行当成孤儿删了（真踩过，后来从自动备份里核对回来）。
        orphan = [s for s in slugs if s and s not in alive]
        if not orphan:
            continue
        n = 0
        for s in orphan:
            n += int(d.scalar(f"SELECT COUNT(*) FROM {t} WHERE slug=?", (s,)) or 0)
        rows.append({"table": t, "keep_as_log": keep_log,
                     "orphanSlugs": len(orphan), "orphanRows": n})
        if not keep_log:
            total += n
            if APPLY:
                for s in orphan:
                    d.execute(f"DELETE FROM {t} WHERE slug=?", (s,))
    report = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "applied": APPLY,
              "aliveBooks": sorted(alive), "tables": rows,
              "orphanRowsDeletable": total,
              "note": "keep_as_log=True 的是留痕表（审计/任务/通知/改动留痕），故意不删"}
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(("已清理 " if APPLY else "可以清理，但没动手（加 --apply 才删）：") + f"{total} 行")
    for r in rows:
        print(("  留痕跳过 " if r["keep_as_log"] else "  待清 " if not APPLY else "  已清 ")
              + f"{r['table']:<16} {r['orphanSlugs']} 个已删书 / {r['orphanRows']} 行")
    print("报告：docs/孤儿行清理.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
