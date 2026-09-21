# -*- coding: utf-8 -*-
"""写作辅助三件套（第 16 轮新增，都是"手机上写长篇"真正用得上的）：

  ① 故事线  `/api/storyline`  —— 一章一句话，一眼看清这本书讲到哪了。
  ② 小批注  `/api/notes/margin` —— 看正文时给自己留的待办。**不进正文**，
     所以导出稿子里搜不到它（这就是它存在的意义：写进正文会污染稿子）。
  ③ 常用指令 `/api/quick`  —— 写正文那排一键指令（"接着写 800 字""改口语一点"），按书存。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Body, HTTPException, Request

from .. import args
from .. import db as dbm
from ..security import current_user
from ..store import chapter_files, chapter_title, hanzi, read_text
from .books import require_path, require_book

router = APIRouter(tags=["authoring"])

# 第一次打开时给的那几条「常用指令」。用户能改能删，这里只是别让他对着空白发呆。
DEFAULT_QUICK = [
    "接着往下写，承接现在的场景和情绪，不要重复上文",
    "把节奏放慢，多写细节和动作，少写解释",
    "这一段改得口语一点，对话更像真人说的",
    "加一段对话，把两个人的分歧写出来",
    "删掉总结句和排比，只留能看见的动作",
]

MAX_SUMMARY = 200
MAX_NOTE = 2000
MAX_CMD = 200


def _one_line(text: str, n: int = 70) -> str:
    """从正文里抠出"第一句像样的话"当摘要。

    为什么不是随便截前 N 个字：正文开头常常是标题行、空行、或者半句话。
    先把 markdown 标题、空行去掉，取第一段，再按句号/问号收口。
    """
    t = re.sub(r"^#+.*$", "", text or "", flags=re.M)          # 去掉 # 小标题
    t = re.sub(r"[*_`>]+", "", t)                              # 去掉 markdown 符号
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return ""
    m = re.search(r"^.{2,}?[。！？!?]", t)          # 第一句（"炕很烫。"这种短句也要认）
    s = m.group(0) if m else t
    return s[:n] + ("…" if len(s) > n else "")


# ── ① 故事线 ────────────────────────────────────────────────────────────────
@router.get("/storyline")
async def storyline(request: Request, slug: str):
    """一章一句话。**只认一个来源**：`chapter.summary`（老早就有这一列，剧情面板、
    批量"写摘要"写的都是它）；没写过就从正文里自动抠一句，并标明这是自动的。"""
    current_user(request)
    s = require_book(slug)
    d = dbm.db()
    mine = {r["path"]: (r.get("summary") or "") for r in d.query(
        "SELECT path, summary FROM chapter WHERE slug=?", (s,))}
    out = []
    for ch in chapter_files(s):              # 顺序 = 阅读顺序（跟阅读器一致）
        rel = ch["path"]
        try:
            body = read_text(s, rel) or ""
        except Exception:
            body = ""
        words = hanzi(body) or int(ch.get("words") or 0)
        has = (mine.get(rel) or "").strip()
        out.append({
            "path": rel,
            "no": ch.get("index") or (len(out) + 1),
            "title": ch.get("name") or rel,
            "words": words,
            "empty": words == 0,
            "summary": has or _one_line(body),
            "mine": bool(has),
        })
    return {"items": out, "count": len(out),
            "words": sum(x["words"] for x in out),
            "emptyCount": sum(1 for x in out if x["empty"])}


@router.post("/storyline")
async def storyline_save(request: Request, payload: dict = Body(...)):
    """改某一章的"一句话"（写进 `chapter.summary`）。写空 = 恢复成自动从正文里抠。"""
    current_user(request)
    s = require_book(payload.get("slug") or "")
    path = require_path(s, payload.get("path") or "")
    text = str(payload.get("summary") or "").strip()
    if len(text) > MAX_SUMMARY:
        raise HTTPException(400, f"一句话别超过 {MAX_SUMMARY} 字（现在 {len(text)} 字）")
    d = dbm.db()
    if not d.one("SELECT id FROM chapter WHERE slug=? AND path=?", (s, path)):
        from .books import sync_book
        sync_book(s)                       # 磁盘上有、库里还没索引 → 先补一行
    if not d.one("SELECT id FROM chapter WHERE slug=? AND path=?", (s, path)):
        raise HTTPException(404, "这一章不在了")
    d.execute("UPDATE chapter SET summary=?, updated_at=? WHERE slug=? AND path=?",
              (text, dbm.now_ms(), s, path))
    return {"ok": True, "path": path, "summary": text}


# ── ② 小批注 ────────────────────────────────────────────────────────────────
@router.get("/notes/margin")
async def margin_list(request: Request, slug: str, path: str = ""):
    current_user(request)
    s = require_book(slug)
    d = dbm.db()
    if path:
        rows = d.query("SELECT * FROM margin_note WHERE slug=? AND path=? ORDER BY at_ms, id",
                       (s, require_path(s, path)))
    else:
        rows = d.query("SELECT * FROM margin_note WHERE slug=? ORDER BY path, at_ms, id", (s,))
    return {"items": [{"id": r["id"], "path": r["path"], "quote": r["quote"], "note": r["note"],
                       "at": r["at_ms"], "createdAt": r["created_at"]} for r in rows],
            "count": len(rows)}


@router.post("/notes/margin")
async def margin_add(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    path = require_path(s, payload.get("path") or "")
    note = str(payload.get("note") or "").strip()
    if not note:
        raise HTTPException(400, "批注是空的 —— 写一句你想干什么（例：这里补一场打斗）")
    if len(note) > MAX_NOTE:
        raise HTTPException(400, f"批注太长了（上限 {MAX_NOTE} 字）")
    quote = str(payload.get("quote") or "")[:300]
    try:
        at = int(payload.get("at") or 0)
    except Exception:
        at = 0
    now = dbm.now_ms()
    rid = dbm.db().execute(
        "INSERT INTO margin_note(slug,path,quote,note,at_ms,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?)", (s, path, quote, note, at, now, now))
    return {"ok": True, "id": rid, "path": path}


@router.put("/notes/margin")
async def margin_edit(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    rid = int(payload.get("id") or 0)
    note = str(payload.get("note") or "").strip()
    if not rid:
        raise HTTPException(400, "要改哪一条（id 不能空）")
    if not note:
        raise HTTPException(400, "批注不能改空；不想留了就删掉它")
    n = dbm.db().rowcount("UPDATE margin_note SET note=?, updated_at=? WHERE slug=? AND id=?",
                          (note[:MAX_NOTE], dbm.now_ms(), s, rid))
    if not n:
        raise HTTPException(404, "这条批注已经不在了")
    return {"ok": True, "id": rid}


@router.delete("/notes/margin")
async def margin_del(request: Request, slug: str = "", id: int = 0):
    current_user(request)
    s = require_book(slug)
    if not id:
        raise HTTPException(400, "要删哪一条（id 不能空）")
    n = dbm.db().rowcount("DELETE FROM margin_note WHERE slug=? AND id=?", (s, id))
    if not n:
        raise HTTPException(404, "这条批注已经不在了")
    return {"ok": True, "deleted": n}


# ── ③ 常用指令 ──────────────────────────────────────────────────────────────
@router.get("/quick")
async def quick_list(request: Request, slug: str):
    current_user(request)
    s = require_book(slug)
    d = dbm.db()
    rows = d.query("SELECT * FROM quick_cmd WHERE slug=? ORDER BY order_no, id", (s,))
    if not rows:
        now = dbm.now_ms()
        for i, t in enumerate(DEFAULT_QUICK):
            d.execute("INSERT INTO quick_cmd(slug,text,order_no,created_at) VALUES(?,?,?,?)",
                      (s, t, i, now))
        rows = d.query("SELECT * FROM quick_cmd WHERE slug=? ORDER BY order_no, id", (s,))
        return {"items": [{"id": r["id"], "text": r["text"]} for r in rows], "seeded": True}
    return {"items": [{"id": r["id"], "text": r["text"]} for r in rows], "seeded": False}


@router.post("/quick")
async def quick_add(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = require_book(payload.get("slug") or "")
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "指令是空的")
    if len(text) > MAX_CMD:
        raise HTTPException(400, f"一句话指令别超过 {MAX_CMD} 字")
    d = dbm.db()
    # 这一段原来是 `if ...: pass` —— 空分支 = 什么都没做（账本里那 40 条"空实现"的一条）。
    # 它想干的事从条件就看得出来：**同名指令别加两条**。所以正经写成去重：
    # 已经有一模一样的一条，就把那一条还回去（前端按 id 处理，不会多出一个重复的胶囊）。
    dup = d.one("SELECT id FROM quick_cmd WHERE slug=? AND text=?", (s, text))
    if dup:
        return {"ok": True, "id": dup["id"], "text": text, "dup": True}
    order = (d.scalar("SELECT MAX(order_no) FROM quick_cmd WHERE slug=?", (s,)) or 0) + 1
    rid = d.execute("INSERT INTO quick_cmd(slug,text,order_no,created_at) VALUES(?,?,?,?)",
                    (s, text, order, dbm.now_ms()))
    return {"ok": True, "id": rid, "text": text}


@router.delete("/quick")
async def quick_del(request: Request, slug: str = "", id: int = 0):
    current_user(request)
    s = require_book(slug)
    if not id:
        raise HTTPException(400, "要删哪一条（id 不能空）")
    n = dbm.db().rowcount("DELETE FROM quick_cmd WHERE slug=? AND id=?", (s, id))
    if not n:
        raise HTTPException(404, "这条指令已经不在了")
    return {"ok": True, "deleted": n}


# ── ④ 章节顺序：上移 / 下移 / 插在中间（手机上给长篇调顺序）──────────────────
#   为什么单拎出来说：**挪一章不是"改个文件名"那么简单**。
#   这一章的细纲（outline.chapter_path）、出场角色与关键事件（chapter_meta.path）、
#   历史版本、素材归属……都按 path 认人。老写法（rename_path）只改了 chapter 一行，
#   别的表就变成了孤儿 —— 用户在界面上看着"挪好了"，其实细纲丢了。所以这里：
#     ① 先把所有带 path 的列都找出来（问 SQLite 自己），② 文件用临时名两步挪（防撞名），
#     ③ 每一处 path 都跟着改。挪完还会把新清单回给前端。

_NUM_RE = re.compile(r"^(第\s*0*(\d+)\s*章\s*[-—·_]?\s*)")
# "插入"用的临时名（`._insert-2.500-插曲.md`）：重排时必须把这段前缀当编号剥掉，
# 否则插进来的那一章会永远挂着个临时名。
_TMP_RE = re.compile(r"^\._insert-[\d.]+-")


def _split_no(name: str) -> tuple[str, str]:
    """把 `第003章-官道南行` 拆成 (前缀, 名字)。没有编号就当前缀为空。"""
    m = _TMP_RE.match(name)
    if m:
        return name[:m.end()], name[m.end():]
    m = _NUM_RE.match(name)
    if m:
        return m.group(1), name[m.end():]
    m = re.match(r"^0*(\d+)[\s._-]*", name)
    if m:
        return m.group(0), name[m.end():]
    return "", name


def _renumber(slug: str, order: list[str]) -> dict[str, str]:
    """按 order 把章节重排成 001、002…（只动需要动的那些），返回 {旧: 新}。

    两步走防撞名：先把要改的全部挪到一个临时名，再落到最终名。
    只在 `manuscript/` 下的平铺章节上做（带卷子目录的结构不动，那种顺序靠目录）。
    """
    from ..store import rename_path
    mapping: dict[str, str] = {}
    plans: list[tuple[str, str]] = []
    for i, path in enumerate(order, 1):
        if "/" in path[len("manuscript/"):]:        # 卷/章目录结构：不重排，免得动到卷
            continue
        name = chapter_title(path)
        pre, rest = _split_no(name)
        want = "第%03d章-%s.md" % (i, rest or "未命名")
        if name + ".md" == want:
            continue
        plans.append((path, "manuscript/" + want))
    if not plans:
        return mapping
    stage: list[tuple[str, str]] = []
    for j, (src, dst) in enumerate(plans):
        tmp = "manuscript/.moving-%d-%s" % (j, dst.split("/")[-1])
        rename_path(slug, src, tmp)
        stage.append((src, tmp))
    for (src, tmp), (_, dst) in zip(stage, plans):
        rename_path(slug, tmp, dst)
        mapping[src] = dst
    return mapping


def _rewrite_paths(slug: str, mapping: dict[str, str]) -> dict[str, int]:
    """把所有按 path 认人的列一起改掉（**问 SQLite 自己有哪些列**，别手写清单漏掉那个倒霉的表）。"""
    if not mapping:
        return {}
    d = dbm.db()
    touched: dict[str, int] = {}
    tables = [r["name"] for r in d.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for t in tables:
        cols = [r["name"] for r in d.query("PRAGMA table_info(%s)" % t)]
        pcols = [c for c in cols if "path" in c]
        if not pcols:
            continue
        for col in pcols:
            for old, new in mapping.items():
                n = d.rowcount("UPDATE %s SET %s=? WHERE %s=?" % (t, col, col), (new, old))
                if n:
                    touched["%s.%s" % (t, col)] = touched.get("%s.%s" % (t, col), 0) + n
    return touched


def _chapter_list(slug: str) -> list[dict]:
    from ..store import book_dir
    d = dbm.db()
    metas = {r["path"]: r for r in d.query(
        "SELECT path, cast_json, events_json FROM chapter_meta WHERE slug=?", (slug,))}
    base = book_dir(slug)
    out = []
    for ch in chapter_files(slug):
        rel = ch["path"]
        meta = metas.get(rel) or {}
        out.append({"path": rel, "name": ch.get("name") or rel, "index": ch.get("index"),
                    "abs": str((base / rel)),
                    "cast": d.jloads(meta.get("cast_json"), []) or [],
                    "events": d.jloads(meta.get("events_json"), []) or [],
                    "words": int(ch.get("words") or 0)})
    return out


@router.post("/chapter/move")
async def chapter_move(request: Request, payload: dict = Body(...)):
    """把一章上移 / 下移（顺序 = 文件名里的编号，跟阅读器一致）。"""
    current_user(request)
    s = require_book(payload.get("slug") or "")
    path = require_path(s, payload.get("path") or "")
    d = payload.get("dir") or "up"
    if d not in ("up", "down", "top", "bottom"):
        raise HTTPException(400, "方向只能是 up / down / top / bottom")
    chs = _chapter_list(s)
    order = [c["path"] for c in chs]
    if path not in order:
        raise HTTPException(404, "这一章不在了")
    i = order.index(path)
    if d == "up" and i > 0:
        order[i - 1], order[i] = order[i], order[i - 1]
    elif d == "down" and i < len(order) - 1:
        order[i + 1], order[i] = order[i], order[i + 1]
    elif d == "top":
        order.insert(0, order.pop(i))
    elif d == "bottom":
        order.append(order.pop(i))
    else:
        return {"ok": True, "moved": False, "why": "已经在头/尾了", "chapters": chs}
    mapping = _renumber(s, order)
    _rewrite_paths(s, mapping)
    from .books import sync_book
    sync_book(s)
    return {"ok": True, "moved": path in mapping, "renamed": len(mapping),
            "chapters": _chapter_list(s)}


@router.post("/chapter/insert")
async def chapter_insert(request: Request, payload: dict = Body(...)):
    """在某一章**后面**插一章（后面的编号自动往后让一位）。"""
    current_user(request)
    s = require_book(payload.get("slug") or "")
    after = require_path(s, payload.get("after") or "")
    title = args.s(payload.get("title"), name="章节名").strip() or "未命名"
    chs = _chapter_list(s)
    order = [c["path"] for c in chs]
    if after not in order:
        raise HTTPException(404, "要插在哪一章后面？那一章不在了")
    at = order.index(after) + 1
    tmp = "manuscript/._insert-%.3f-%s.md" % (at + 0.5, title.replace("/", "_"))
    from ..store import create_file
    create_file(s, tmp, "")
    order.insert(at, tmp)
    mapping = _renumber(s, order)
    _rewrite_paths(s, mapping)
    from .books import sync_book
    sync_book(s)
    return {"ok": True, "inserted": mapping.get(tmp, tmp), "renamed": len(mapping),
            "chapters": _chapter_list(s)}
