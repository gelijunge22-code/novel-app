# -*- coding: utf-8 -*-
"""书架 / 作品 / 章节 / 搜索 / 封面 / 可选模型。

返回结构对着 `ref/golden/legacy-shapes.json`（从线上实测抓的）写，
字段名一个不改 —— 前端才不会崩（见 docs/设计方案 §4.1）。
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from fastapi import (APIRouter, Body, File, HTTPException, Query, Request,
                     Response, UploadFile)
from fastapi.responses import FileResponse, JSONResponse

from .. import args
from .. import db as dbm
from ..config import CFG
from ..security import current_user
from ..store import (P, all_slugs, book_dir, chapter_files, chapter_title,
                     create_book, read_text, safe_slug, write_project_yaml,
                     write_text, now_ms, hanzi, iso)

router = APIRouter(tags=["books"])

IMAGE_CT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif"}


# ── 内务：把磁盘上的真实情况同步进数据库 ────────────────────────────────────
def sync_book(slug: str) -> dict:
    """扫描一本书，把章节清单与字数写回数据库（磁盘是真相，数据库是索引）。"""
    d = dbm.db()
    files = chapter_files(slug)
    seen = {c["path"] for c in files}
    total = 0
    with d.tx() as conn:
        for i, c in enumerate(files):
            total += c["words"]
            conn.execute(
                "INSERT INTO chapter(slug,path,order_no,title,words,mtime_ms,updated_at)"
                " VALUES(?,?,?,?,?,?,?)"
                " ON CONFLICT(slug,path) DO UPDATE SET order_no=excluded.order_no,"
                " title=CASE WHEN chapter.title='' THEN excluded.title ELSE chapter.title END,"
                " words=excluded.words, mtime_ms=excluded.mtime_ms, updated_at=excluded.updated_at",
                (slug, c["path"], i + 1, c["name"], c["words"], int(c["mtimeMs"]), now_ms()))
        if seen:
            q = ",".join("?" * len(seen))
            conn.execute(f"DELETE FROM chapter WHERE slug=? AND path NOT IN ({q})",
                         (slug, *sorted(seen)))
        else:
            conn.execute("DELETE FROM chapter WHERE slug=?", (slug,))
        conn.execute("UPDATE book SET word_count=?, updated_at=? WHERE slug=?",
                     (total, now_ms(), slug))
    py = _project_yaml(slug)
    if py.get("title"):
        d.execute("UPDATE book SET title=?, summary=? WHERE slug=? AND title != ?",
                  (py["title"], py.get("summary") or "", slug, py["title"]))
    return {"chapters": files, "totalWords": total}


def _project_yaml(slug: str) -> dict:
    from ..store import read_project_yaml
    return read_project_yaml(slug)


def ensure_book_row(slug: str) -> dict:
    """磁盘上有这本书、数据库里没有 → 补一行（迁移或手拷目录后能自愈）。"""
    d = dbm.db()
    row = d.one("SELECT * FROM book WHERE slug=?", (slug,))
    if row:
        return row
    py = _project_yaml(slug)
    title = py.get("title") or slug
    now = now_ms()
    d.execute("INSERT INTO book(slug,title,kind,summary,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?)",
              (slug, title, py.get("kind") or "novel", py.get("summary") or "", now, now))
    return d.one("SELECT * FROM book WHERE slug=?", (slug,))


def require_book(slug: str) -> str:
    s = safe_slug(slug)
    if not s or not book_dir(s).is_dir():
        raise HTTPException(404, "没有这本书")
    return s


def require_path(slug: str, path: str) -> str:
    from ..paths import safe_rel
    p = safe_rel(path)
    if not p:
        raise HTTPException(400, "路径不合法")
    return p


# ── 书架 ────────────────────────────────────────────────────────────────────
@router.get("/shelf")
async def shelf(request: Request):
    current_user(request)
    heal_book_index()                      # 幽灵书（有行没目录）别摆上书架
    out = []
    for slug in all_slugs():
        row = ensure_book_row(slug)
        cover = row.get("cover") or ""
        cover_path = book_dir(slug) / ".novel" / cover if cover else None
        out.append({
            "slug": slug,
            "title": row["title"] or _project_yaml(slug).get("title") or slug,
            "updatedAt": row["updated_at"],
            "hasCover": bool(cover_path and cover_path.exists()),
            "raw": {"kind": row["kind"], "wordCount": row["word_count"],
                    "status": row["status"], "summary": row["summary"]},
        })
    out.sort(key=lambda x: -(x["updatedAt"] or 0))
    return {"projects": out}


@router.get("/projects")
async def projects(request: Request):
    current_user(request)
    heal_book_index()
    items = []
    for slug in all_slugs():
        row = ensure_book_row(slug)
        # slug 和 projectRoot 是**同一个东西**（全站其它接口一律叫 slug、查询参数也叫 slug，
        # 只有这里是照旧平台的叫法）。两个都返回，省得谁少看一行就踩空 —— 第 11 轮我自己就
        # 因为 /api/shelf 给 slug、/api/projects 给 projectRoot，写脚本时取到 undefined。
        items.append({"projectRoot": slug, "slug": slug, "kind": row["kind"], "title": row["title"],
                      "summary": row["summary"],
                      "manifestUpdatedAt": iso(row["updated_at"])})
    items.sort(key=lambda x: x["projectRoot"])
    return {"revision": dbm.db().scalar("SELECT COUNT(*) FROM book") or 0, "projects": items}


@router.post("/projects")
async def projects_create(request: Request, payload: dict = Body(...)):
    current_user(request)
    try:
        out = create_book(args.s(payload.get("title"), name="书名"),
                          args.s(payload.get("summary"), name="简介"),
                          args.s(payload.get("kind"), name="类型") or "novel")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {**out, "projectRoot": out["slug"]}


@router.post("/projects/open")
async def projects_open(request: Request, payload: dict = Body(default={})):
    """旧平台有个「当前打开的作品」概念，过期就把接口打成 409。
    我们没有这个状态 —— 这个接口留着只为兼容，永远成功。"""
    current_user(request)
    slug = safe_slug((payload or {}).get("projectRoot") or (payload or {}).get("slug") or "")
    if slug and not book_dir(slug).is_dir():
        raise HTTPException(404, "没有这本书")
    return {"ok": True, "projectRoot": slug or ""}


@router.patch("/projects/item")
async def projects_rename(request: Request, payload: dict = Body(...), projectRoot: str = ""):
    current_user(request)
    slug = require_book(projectRoot or payload.get("projectRoot") or payload.get("slug"))
    title = args.s(payload.get("title"), name="书名").strip()
    if not title:
        raise HTTPException(400, "书名不能为空")
    dbm.db().execute("UPDATE book SET title=?, updated_at=? WHERE slug=?", (title, now_ms(), slug))
    py = _project_yaml(slug)
    write_project_yaml(slug, {**py, "title": title})
    return {"ok": True, "slug": slug, "title": title}


# ── 删书时到底该清哪些表 ─────────────────────────────────────────────────────
# 这一份名单是**照着库里真实存在的表列出来的**（`slug` 维度的表一共 45 张）。
# 踩过的坑：老代码手写了个 19 张的名单，剩下的全靠自觉 —— 于是删书之后
# 世界审计、历法、世界切面、章节元数据、提示词覆盖、工作流、笔记、参考书架、
# 冲突队列、成就、记忆事件、别名/关系、大纲、编排台账…… 全都留在库里；
# 表面看不出来，实际后果是：① 整包导出越导越大，里面全是已删书的东西；
# ② 用户哪天建一本同名书（slug 一样），旧书的历法/提示词/参考书架会"复活"。
# 分两类写清楚，别让下一个人再猜：
#   _BOOK_STATE —— 这本书的**内容与状态**，书没了就该跟着走；
#   _BOOK_LOG   —— **留痕/账本**（谁在什么时候删了什么、花了多少 token、
#                  任务与通知的历史），故意留着，删书这件事本身也要有记录。
# 新增带 slug 的表时，tools/verify_book_scope.py 会直接判失败，逼你选一类。
_BOOK_STATE = (
    "chapter", "chapter_version", "chapter_meta", "act", "scene", "outline", "episode",
    "entity", "entity_alias", "entity_relation", "fact", "moment", "moment_abs", "arc",
    "thread", "thread_scene", "promise", "decision", "world_snapshot", "calendar",
    "memory", "memory_event", "term", "material", "note", "reference", "rag_index",
    "writing_day", "revision", "achievement", "bookmark", "reading_progress",
    "lint_run", "sync_conflict", "prompt", "prompt_version", "workflow",
    "chat_session", "orchestra_run", "preset",
    # 对端同步（第 12 轮加的）：这三张表都是"这本书跟服务器同步到哪儿了"的书内状态，
    # 书删了它们就是孤儿（verify_book_scope.py 的静态那条正是抓这个 —— 它当场就报了）。
    "peer_state", "peer_file", "peer_log",
    # 第 42 轮补的两张（`verify_book_scope.py` 的"必须分类"那条当场报红抓出来的）：
    # 「段落批注」和「这本书的常用指令」都是**书内状态**，书删了它们就是孤儿 ——
    # 实测库里真躺着 10 条 margin_note + 63 条 quick_cmd（都是自测书留下的）。
    "margin_note", "quick_cmd",
)
_BOOK_LOG = ("audit", "trace", "notification", "job")


def book_scoped_tables() -> set:
    """库里所有带 slug 维度的表（book 自己是主表，不算子表）。"""
    rows = dbm.db().query("SELECT name FROM sqlite_master WHERE type='table'")
    out = set()
    d = dbm.db()
    for r in rows:
        name = r["name"]
        if name == "book" or name.startswith("sqlite_"):
            continue
        cols = [c["name"] for c in d.query(f"PRAGMA table_info({name})")]
        if "slug" in cols:
            out.add(name)
    return out


def heal_book_index() -> list[str]:
    """把"库里有一行、磁盘上没有这本书"的**幽灵书**清掉（返回清掉的 slug）。

    踩过的坑：测试/脚本中途被杀时，目录被搬进回收站、`book` 那一行却留下了 ——
    书架上（目录驱动）看不见它，可它一直躺在库里：`revision` 数偏大、整包导出里带一本
    打开就 404 的书。目录才是"这本书在不在"的唯一真相（`ensure_book_row()` 能从目录回填
    那一行），所以这类残行清掉是安全的、也是可自愈的。
    """
    from ..store import all_slugs
    have = set(all_slugs())
    gone = []
    for r in list(dbm.db().query("SELECT slug FROM book")):
        if r["slug"] not in have:
            dbm.db().execute("DELETE FROM book WHERE slug=?", (r["slug"],))
            # **只删 book 那一行是不够的**：这本书的章节/批注/常用指令…还全在库里当孤儿。
            # 第 42 轮实测：这么"治好"过的书，留下了 1 条 chapter + 10 条 margin_note +
            # 63 条 quick_cmd + 2 条 revision（`verify_no_litter` 的⑥当场报红）。
            # 目录都不在磁盘上了，这些索引行就是死的，一并清（书稿本体在回收站里，没动它）。
            purge_book_rows(r["slug"])
            gone.append(r["slug"])
    return gone


def purge_book_rows(slug: str) -> dict:
    """把一本书在库里留下的行清干净（书稿目录已经在回收站里，这里只清索引）。"""
    d = dbm.db()
    gone = {}
    for t in _BOOK_STATE:
        # rowcount 才有意义；execute() 给的是 lastrowid（上一次 INSERT 的 rowid），
        # 一本 0 章的自测书曾因此报出"清了 8343 条索引"。
        gone[t] = d.rowcount(f"DELETE FROM {t} WHERE slug=?", (slug,))
    # 会话表有外键级联（chat_entry / chat_event 跟着会话走），
    # 但 orchestra_run 是账本、故意没挂外键 —— 步骤要跟着 run 手动走一遍。
    d.execute("DELETE FROM orchestra_step WHERE run_id NOT IN (SELECT id FROM orchestra_run)")
    gone["orchestra_step(孤儿)"] = 1
    return gone


@router.delete("/projects/item")
async def projects_delete(request: Request, projectRoot: str = ""):
    current_user(request)
    slug = require_book(projectRoot)
    dst = P.trash / f"book-{slug}-{int(time.time())}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(book_dir(slug)), str(dst))
    dbm.db().execute("DELETE FROM book WHERE slug=?", (slug,))
    purged = purge_book_rows(slug)
    # 书稿本体进回收站了，那几行**索引**（章节/设定/世界…）就没用了 —— 一并清掉，
    # 否则"这本书跟服务器同步到哪儿了"之类的行会留下来当孤儿。
    return {"ok": True, "trashedTo": str(dst), "purged": sum(v for v in purged.values() if isinstance(v, int))}


# ── 作品详情 / 目录 ─────────────────────────────────────────────────────────
@router.get("/book")
async def book(slug: str, request: Request, refresh: int = 0):
    current_user(request)
    s = require_book(slug)
    row = ensure_book_row(s)
    data = sync_book(s)
    return {"slug": s, "title": row["title"], "chapters": data["chapters"],
            "totalWords": data["totalWords"]}


@router.get("/chapter")
async def chapter(slug: str, path: str, request: Request):
    current_user(request)
    s = require_book(slug)
    p = require_path(s, path)
    try:
        content = read_text(s, p)
    except FileNotFoundError:
        raise HTTPException(404, "没有这一章")
    except (ValueError, OSError) as e:
        raise HTTPException(400, str(e))
    files = chapter_files(s)
    paths = [c["path"] for c in files]
    i = paths.index(p) if p in paths else -1
    name = chapter_title(p)
    return {"slug": s, "path": p, "content": content,
            "mtimeMs": _mtime(s, p), "name": name,
            "index": i + 1 if i >= 0 else None, "total": len(paths),
            "prev": paths[i - 1] if i > 0 else None,
            "next": paths[i + 1] if 0 <= i < len(paths) - 1 else None,
            "title": _chapter_row(s, p).get("title") or name,
            "status": _chapter_row(s, p).get("status") or "draft"}


def _mtime(slug: str, path: str) -> float:
    try:
        return (book_dir(slug) / path).stat().st_mtime * 1000.0
    except OSError:
        return 0.0


def _chapter_row(slug: str, path: str) -> dict:
    return dbm.db().one("SELECT * FROM chapter WHERE slug=? AND path=?", (slug, path)) or {}


@router.put("/chapter")
async def save_chapter(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    p = require_path(s, payload.get("path") or "")
    content = payload.get("content")
    if content is None:
        raise HTTPException(400, "没有正文内容")
    content = args.s(content, name="正文")     # 数组/对象 → 400 说人话，别 500
    expected = payload.get("expectedMtimeMs")
    if expected and not payload.get("force"):
        cur = _mtime(s, p)
        if cur and abs(cur - float(expected)) > 2:
            # 两边都改过：**不替用户选**。把服务器这版一并带回去，让 App 摆出来给人挑；
            # 同时记进冲突表（/api/sync/conflicts），换台设备也看得到。
            try:
                server_text = read_text(s, p)
            except Exception:
                server_text = ""
            from .sync import record_conflict
            cid = record_conflict(s, p, base=int(float(expected)), local_text=str(content),
                                  server_text=server_text, server_mtime=int(cur))
            return JSONResponse(status_code=409, content={
                "detail": "这一章在别处也改过 —— 两边的内容都留着，你挑一版",
                "conflict": True, "conflictId": cid, "path": p,
                "serverMtimeMs": cur, "localMtimeMs": int(float(expected)),
                "serverText": server_text})
    try:
        out = write_text(s, p, str(content), origin="user", note="编辑正文")
    except FileNotFoundError:
        raise HTTPException(404, "没有这个文件")
    _touch(s)
    sync_book(s)
    _note_writing(s, len(str(content)))
    return {"ok": True, "mtimeMs": out["mtimeMs"]}


def _touch(slug: str) -> None:
    dbm.db().execute("UPDATE book SET updated_at=? WHERE slug=?", (now_ms(), slug))


def _note_writing(slug: str, chars: int) -> None:
    """记当天的写作量（统计页 / 写作日历 / 码字速度全靠它）。

    净增字数 = 今天的总字数 − 昨天结束时的总字数（删掉的字会算成负数，这是对的）。
    另外把「两次保存之间的时间」记进 seconds —— 用来算码字速度，超过 10 分钟算歇过了。
    """
    import datetime
    import time as _t
    day = datetime.datetime.now()
    key = day.strftime("%Y-%m-%d")
    total = dbm.db().scalar("SELECT SUM(words) FROM chapter WHERE slug=?", (slug,)) or 0
    d = dbm.db()
    row = d.one("SELECT * FROM writing_day WHERE slug=? AND date_key=?", (slug, key))
    prev_end = d.scalar("SELECT ending_words FROM writing_day WHERE slug=? AND date_key<?"
                        " ORDER BY date_key DESC LIMIT 1", (slug, key)) or 0
    last_key = "writing.lastSaveAt"
    last = float(d.scalar("SELECT value_json FROM setting WHERE key=?", (last_key,)) or 0)
    gap = 0
    if last and 0 < _t.time() - last <= 600:
        gap = int(_t.time() - last)
    if row:
        d.execute("UPDATE writing_day SET ending_words=?, net_words=?, seconds=seconds+?,"
                  " updated_at=? WHERE id=?",
                  (total, total - prev_end, gap, now_ms(), row["id"]))
    else:
        d.execute("INSERT INTO writing_day(slug,date_key,net_words,ending_words,seconds,updated_at)"
                  " VALUES(?,?,?,?,?,?)", (slug, key, total - prev_end, total, gap, now_ms()))
    d.execute("INSERT INTO setting(key,value_json,updated_at) VALUES(?,?,?)"
              " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
              " updated_at=excluded.updated_at",
              (last_key, str(_t.time()), now_ms()))


# ── 作品 / 章节管理 ─────────────────────────────────────────────────────────
@router.post("/book")
async def book_new(request: Request, payload: dict = Body(...)):
    current_user(request)
    try:
        out = create_book(args.s(payload.get("title"), name="书名"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return out


@router.post("/book/rename")
async def book_rename(request: Request, payload: dict = Body(...)):
    current_user(request)
    return await projects_rename(request, payload,
                                 projectRoot=payload.get("slug") or "")


@router.post("/book/delete")
async def book_delete(request: Request, payload: dict = Body(...)):
    current_user(request)
    return await projects_delete(request, projectRoot=payload.get("slug") or "")


@router.post("/chapter/new")
async def chapter_new(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    p = require_path(s, payload.get("path") or "")
    from ..store import create_file
    try:
        out = create_file(s, p, args.s(payload.get("content"), name="正文"))
    except FileExistsError:
        raise HTTPException(400, "已经有一章叫这个名字了")
    _touch(s)
    sync_book(s)
    return {**out, "slug": s}


@router.post("/chapter/delete")
async def chapter_delete(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    p = require_path(s, payload.get("path") or "")
    from ..store import delete_path
    try:
        out = delete_path(s, p)
    except FileNotFoundError:
        raise HTTPException(404, "没有这一章")
    _touch(s)
    sync_book(s)
    return {**out, "slug": s}


@router.post("/chapter/rename")
async def chapter_rename(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    a = require_path(s, payload.get("from") or "")
    b = require_path(s, payload.get("to") or "")
    from ..store import rename_path
    try:
        out = rename_path(s, a, b)
    except FileNotFoundError:
        raise HTTPException(404, "原文件不在了")
    except FileExistsError:
        raise HTTPException(400, "目标名字已经被占用")
    dbm.db().execute("UPDATE chapter SET path=?, title=? WHERE slug=? AND path=?",
                     (b, chapter_title(b), s, a))
    _touch(s)
    sync_book(s)
    return {**out, "slug": s}


# ── 全书搜索 ────────────────────────────────────────────────────────────────
@router.get("/search")
async def search_book(slug: str, q: str, request: Request, limit: int = 40):
    current_user(request)
    s = require_book(slug)
    kw = (q or "").strip()
    if not kw:
        return {"hits": []}
    hits: list[dict] = []
    for ch in chapter_files(s):
        try:
            text = read_text(s, ch["path"])
        except Exception:
            continue
        start = 0
        while len(hits) < limit:
            i = text.find(kw, start)
            if i < 0:
                break
            hits.append({
                "path": ch["path"], "name": ch["name"], "index": ch.get("index"),
                "before": text[max(0, i - 28):i], "match": kw,
                "after": text[i + len(kw): i + len(kw) + 28],
            })
            start = i + len(kw)
        if len(hits) >= limit:
            break
    return {"hits": hits}


# ── 封面 ────────────────────────────────────────────────────────────────────
def _cover_file(slug: str) -> Path | None:
    d = book_dir(slug) / ".novel"
    if not d.is_dir():
        return None
    for f in sorted(d.glob("cover.*")):
        if f.suffix.lower() in IMAGE_CT:
            return f
    return None


@router.get("/cover")
async def cover_get(slug: str, request: Request):
    current_user(request)
    s = require_book(slug)
    f = _cover_file(s)
    if not f:
        raise HTTPException(404, "没有封面")
    return FileResponse(str(f), media_type=IMAGE_CT.get(f.suffix.lower(), "image/jpeg"),
                        headers={"Cache-Control": "public, max-age=30"})


@router.post("/cover")
async def cover_put(slug: str, request: Request, file: UploadFile = File(...)):
    current_user(request)
    s = require_book(slug)
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件是空的")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "封面超过 20MB")
    ext = Path(file.filename or "cover.jpg").suffix.lower()
    if ext not in IMAGE_CT:
        head = data[:4]
        ext = ".png" if head[:4] == b"\x89PNG" else ".jpg"
    d = book_dir(s) / ".novel"
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob("cover.*"):
        old.unlink()
    (d / ("cover" + ext)).write_bytes(data)
    dbm.db().execute("UPDATE book SET cover=?, updated_at=? WHERE slug=?",
                     ("cover" + ext, now_ms(), s))
    return {"ok": True}


@router.delete("/cover")
async def cover_del(slug: str, request: Request):
    current_user(request)
    s = require_book(slug)
    for old in (book_dir(s) / ".novel").glob("cover.*"):
        old.unlink()
    dbm.db().execute("UPDATE book SET cover='', updated_at=? WHERE slug=?", (now_ms(), s))
    return {"ok": True}


@router.get("/projects/cover")
async def project_cover(projectRoot: str, request: Request):
    return await cover_get(projectRoot, request)


@router.put("/projects/cover")
async def project_cover_put(projectRoot: str, request: Request):
    current_user(request)
    form = await request.form()
    f = form.get("file")
    if f is None or not hasattr(f, "read"):
        raise HTTPException(400, "没有收到文件")
    data = await f.read()
    return await _put_cover_bytes(projectRoot, data, getattr(f, "filename", "cover.jpg"))


@router.delete("/projects/cover")
async def project_cover_del(projectRoot: str, request: Request):
    return await cover_del(projectRoot, request)


async def _put_cover_bytes(slug: str, data: bytes, filename: str) -> dict:
    s = require_book(slug)
    if not data:
        raise HTTPException(400, "文件是空的")
    ext = Path(filename or "cover.jpg").suffix.lower()
    if ext not in IMAGE_CT:
        ext = ".png" if data[:4] == b"\x89PNG" else ".jpg"
    d = book_dir(s) / ".novel"
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob("cover.*"):
        old.unlink()
    (d / ("cover" + ext)).write_bytes(data)
    dbm.db().execute("UPDATE book SET cover=?, updated_at=? WHERE slug=?",
                     ("cover" + ext, now_ms(), s))
    return {"ok": True}


# ── 可选模型（前端选模型用）─────────────────────────────────────────────────
def model_options(q: str = "") -> dict:
    rows = dbm.db().query(
        "SELECT p.id pid, p.name pname, p.grp pgrp, m.model_id, m.name mname, m.grp mgrp"
        " FROM provider p JOIN provider_model m ON m.provider_id=p.id"
        " WHERE p.enabled=1 AND m.enabled=1 ORDER BY p.sort, p.id, m.id")
    out = [{"key": f"{r['pgrp'] or r['pname']}/{r['model_id']}",
            "name": r["mname"] or r["model_id"],
            "provider": r["pname"], "group": r["mgrp"] or r["pgrp"] or r["pname"]}
           for r in rows]
    if q:
        s = q.lower()
        out = [m for m in out if s in m["name"].lower() or s in m["key"].lower()]
    default = dbm.db().scalar("SELECT value_json FROM setting WHERE key='models.default'")
    default = default.strip('"') if default else None
    rec_raw = dbm.db().scalar("SELECT value_json FROM setting WHERE key='models.recommended'")
    rec = dbm.db().jloads(rec_raw, []) if rec_raw else []
    if not rec:
        rec = [m["key"] for m in out[:2]]
    if not default:
        default = rec[0] if rec else (out[0]["key"] if out else None)
    order = {k: i for i, k in enumerate(rec)}
    out.sort(key=lambda m: (order.get(m["key"], 99), m["provider"], m["name"]))
    return {"models": out, "default": default, "recommended": rec}


@router.get("/models")
async def models(request: Request, q: str = ""):
    current_user(request)
    return model_options(q)


# ── 数据自检（我们新增：把"对不上"的东西摆出来，不自动删）──────────────────
@router.get("/doctor")
async def doctor(request: Request):
    current_user(request)
    report = {"books": [], "orphanFiles": [], "missingFiles": [], "ok": True}
    d = dbm.db()
    for slug in all_slugs():
        files = chapter_files(slug)
        known = {r["path"] for r in d.query("SELECT path FROM chapter WHERE slug=?", (slug,))}
        disk = {c["path"] for c in files}
        missing = sorted(known - disk)
        orphan = sorted(disk - known)
        if missing or orphan:
            report["ok"] = False
        report["books"].append({"slug": slug, "chapters": len(disk),
                                "words": sum(c["words"] for c in files)})
        report["missingFiles"] += [{"slug": slug, "path": p} for p in missing]
        report["orphanFiles"] += [{"slug": slug, "path": p} for p in orphan]
    return report
