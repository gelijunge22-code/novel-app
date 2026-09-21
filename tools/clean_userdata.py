#!/usr/bin/env python3
"""清掉**用户库里的测试残留**（第 41 轮监督人点名：用户在 AI 对话里亲眼看到 7 个测试会话）。

为什么必须有这个脚本：判据脚本逻辑上都会"跑完自删"，但**中途被打断**（超时 / 模型通道中断 /
Ctrl-C）就删不掉。第 41 轮库里就攒了 7 个：
    16  「编排烟测」        219「冒烟-出字判据」     225「zz-判据临时-出字核实」
    230~233「请只回四个字：测试通过」×4
用户打开对话页第一眼看到的就是这些 —— 他会以为是自己写的。

跑法：
    python3 tools/clean_userdata.py            # 只**列出**将要删什么，不动库（默认 dry-run）
    python3 tools/clean_userdata.py --yes      # 真删（删之前先备份 app.db 到 data/backups/）
    python3 tools/clean_userdata.py --tokens   # 顺带清过期/注销很久的登录口令（安全，见 security.prune_tokens）

    默认还会清**孤儿行**：那些"书已经不在书架上了、行还留在库里"的行（第 42 轮实测有
    1 条 chapter + 10 条 margin_note + 63 条 quick_cmd + 2 条 revision）。

判据在 tools/verify_no_litter.py（残留 > 0 报红）。
"""
import argparse
import json
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path("/home/ubuntu/novel-app")
DB = ROOT / "data/app.db"

# 「标题命中这些词」的会话 = 测试/判据建的，不是用户写的
TESTY = re.compile(r"冒烟|烟测|判据|测试通过|zz-|zzz-|自测|实测|走查|临时|E2E|scratch|probe", re.I)
TABLES = []          # 带 slug 的表（运行时填）
# 这些标题**绝不碰**（用户的）
KEEP = re.compile(r"^(主创会话)$")

# 「一张会话没了，这些表里的行也得跟着走」——按 session_id 级联
CASCADE = ("chat_entry", "chat_event", "attachment", "trace")


# **留痕表**：故意不参与孤儿清理 —— 项目规矩是"删书这件事本身也要留得下记录"
# （跟 server/routers/books.py 的 _BOOK_LOG 同一份口径）。第 42 轮我第一版没排除，
# 把 746 条 audit / 53 条 notification / 93 条 trace 一起删了 —— **已从备份里补回来**。
KEEP_LOG = {"audit", "trace", "notification", "job"}


def _slug_tables(db):
    """库里所有带 slug 维度的表 —— 不写死名单，新增表也扫得到（写死就一定会漏）。"""
    out = []
    for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
        name = r[0]
        if name == "book" or name.startswith("sqlite_") or name in KEEP_LOG:
            continue
        cols = [c[1] for c in db.execute(f"PRAGMA table_info({name})").fetchall()]
        if "slug" in cols:
            out.append(name)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="真的删（不加就是 dry-run）")
    ap.add_argument("--tokens", action="store_true", help="顺带清过期/注销很久的登录口令")
    a = ap.parse_args()

    db = sqlite3.connect(str(DB))
    db.row_factory = sqlite3.Row
    global TABLES
    TABLES = _slug_tables(db)
    rows = db.execute("SELECT id,title,slug,created_at FROM chat_session ORDER BY id").fetchall()
    junk = [r for r in rows if TESTY.search(r["title"] or "") and not KEEP.match(r["title"] or "")]

    print(f"会话共 {len(rows)} 个，其中测试残留 {len(junk)} 个：")
    for r in junk:
        n = db.execute("SELECT COUNT(*) FROM chat_entry WHERE session_id=?", (r["id"],)).fetchone()[0]
        print(f"  #{r['id']:>4} 「{r['title']}」  {n} 条消息")
    keep = [r for r in rows if r not in junk]
    print("保留（用户的）：" + "、".join(f"#{r['id']}「{r['title']}」" for r in keep))

    if not a.yes:
        print("\n（dry-run，没动库。要真删加 --yes）")
        return 0

    # 备份：删之前先留一份（用户数据宁可多一份备份）
    bkdir = ROOT / "data/backups"
    bkdir.mkdir(parents=True, exist_ok=True)
    bk = bkdir / f"app-before-clean-{time.strftime('%Y%m%d-%H%M%S')}.db"
    shutil.copy2(DB, bk)
    print(f"\n备份 → {bk}")

    gone = 0
    for r in junk:
        sid = r["id"]
        for t in CASCADE:
            gone += db.execute(f"DELETE FROM {t} WHERE session_id=?", (sid,)).rowcount
        gone += db.execute("DELETE FROM chat_session WHERE id=?", (sid,)).rowcount
    db.commit()
    print(f"删了 {len(junk)} 个会话 / 连带 {gone} 行。")

    # 孤儿行：带 slug 的表里，slug 既不在书架上、也不是"全局行"（空 slug）→ 清掉
    alive = {r["slug"] for r in db.execute("SELECT slug FROM book")}
    orph = {}
    for t in sorted(TABLES):
        try:
            slugs = [r[0] for r in db.execute(f"SELECT DISTINCT slug FROM {t}")]
        except sqlite3.Error:
            continue
        bad = [x for x in slugs if x and x not in alive]
        if bad:
            q = ",".join("?" * len(bad))
            n = db.execute(f"DELETE FROM {t} WHERE slug IN ({q})", bad).rowcount
            orph[t] = (n, len(bad))
    if orph:
        print("孤儿行（书都不在书架上了）：")
        for t, (n, k) in sorted(orph.items()):
            print(f"  {t}: 删 {n} 行（涉及 {k} 个 slug）")
        db.commit()
    else:
        print("孤儿行：无")

    if a.tokens:
        db.close()
        sys.path.insert(0, str(ROOT))
        import server.db as dbm
        dbm.init(DB)
        from server.security import prune_tokens
        print(f"清掉登录口令 {prune_tokens()} 行（只删过期的 / 注销很久的）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
