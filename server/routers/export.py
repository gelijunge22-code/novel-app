# -*- coding: utf-8 -*-
"""导出与导入：TXT / Markdown / EPUB / PDF / 整包，以及 Markdown 批量导入、角色卡导入。

导出就是**把磁盘上的正文按顺序拼一遍**，不经过数据库二次加工 ——
数据库只是索引，正文永远是原始文件（见 docs/决策记录 D5）。
"""
from __future__ import annotations

import io
import json
import re
import time
import zipfile
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response

from .. import db as dbm
from ..security import current_user
from ..store import (P, book_dir, chapter_files, create_book, hanzi, now_ms,
                     read_text, safe_slug, write_text)

router = APIRouter(tags=["export"])


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _book_title(slug: str) -> str:
    return dbm.db().scalar("SELECT title FROM book WHERE slug=?", (slug,)) or slug


def _pick(slug: str, chapters: str = "") -> list[dict]:
    files = chapter_files(slug)
    if not chapters.strip():
        return files
    want = [c for c in chapters.split(",") if c.strip()]
    out = [f for f in files if f["path"] in want]
    if not out:
        raise HTTPException(404, "挑的这几章都不存在")
    return out


def _safe_name(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|\r\n]+', "_", s).strip()[:60] or "book"


def _chapter_name(s: str) -> str:
    """章节文件名：把用户给的 `.md/.txt` 结尾去掉，再由调用方统一补 `.md`。

    第 9 遍打磨实测到的真问题：前端"粘贴导入"传 `name="001-第001章-雪.md"`，
    老代码直接拼 `.md` → 落盘成 `001-第001章-雪.md.md`，用户在目录里看见两个后缀。
    """
    n = _safe_name(s)
    return re.sub(r"\.(md|markdown|txt)$", "", n, flags=re.I) or "导入"


def _download(data: bytes, filename: str, media: str) -> Response:
    fn = quote(filename)
    return Response(data, media_type=media, headers={
        "content-disposition": f"attachment; filename*=UTF-8''{fn}"})


# ── TXT / Markdown ──────────────────────────────────────────────────────────
@router.get("/export/text")
async def export_text(request: Request, slug: str, chapters: str = "", format: str = "txt"):
    current_user(request)
    s = _slug(slug)
    files = _pick(s, chapters)
    title = _book_title(s)
    parts = [f"《{title}》", ""]
    for f in files:
        text = read_text(s, f["path"]).strip()
        if format == "md":
            parts.append(f"## {f['name']}\n\n{text}\n")
        else:
            parts.append(f"\n{f['name']}\n\n{text}\n")
    body = "\n".join(parts)
    ext = "md" if format == "md" else "txt"
    media = "text/markdown; charset=utf-8" if ext == "md" else "text/plain; charset=utf-8"
    return _download(body.encode("utf-8"), f"{_safe_name(title)}.{ext}", media)


@router.get("/export/markdown")
async def export_markdown_zip(request: Request, slug: str, chapters: str = ""):
    """一章一个 .md 打进 zip（拿去别的地方也能读）。"""
    current_user(request)
    s = _slug(slug)
    files = _pick(s, chapters)
    title = _book_title(s)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("书名.txt", title + "\n")
        for i, f in enumerate(files, 1):
            z.writestr(f"{i:03d}-{_safe_name(f['name'])}.md",
                       f"# {f['name']}\n\n{read_text(s, f['path'])}")
    return _download(buf.getvalue(), f"{_safe_name(title)}-markdown.zip", "application/zip")


# ── EPUB ────────────────────────────────────────────────────────────────────
@router.get("/export/epub")
async def export_epub(request: Request, slug: str, chapters: str = ""):
    current_user(request)
    s = _slug(slug)
    files = _pick(s, chapters)
    title = _book_title(s)
    author = dbm.db().scalar("SELECT author FROM book WHERE slug=?", (s,)) or ""
    uid = f"novelapp-{s}-{int(time.time())}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0" encoding="utf-8"?>\n'
                   '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>')
        items, spine, navs = [], [], []
        for i, f in enumerate(files, 1):
            name = f"ch{i:04d}.xhtml"
            body = "".join(f"<p>{_esc(ln)}</p>" for ln in read_text(s, f["path"]).splitlines()
                           if ln.strip())
            z.writestr("OEBPS/" + name,
                       '<?xml version="1.0" encoding="utf-8"?>\n'
                       '<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>'
                       f'<title>{_esc(f["name"])}</title>'
                       '<link rel="stylesheet" href="style.css"/></head><body>'
                       f'<h2>{_esc(f["name"])}</h2>{body}</body></html>')
            items.append(f'<item id="c{i}" href="{name}" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="c{i}"/>')
            navs.append(f'<li><a href="{name}">{_esc(f["name"])}</a></li>')
        z.writestr("OEBPS/style.css",
                   "body{font-family:serif;line-height:1.8;margin:1em}"
                   "p{text-indent:2em;margin:0.4em 0}h2{text-align:center}")
        z.writestr("OEBPS/nav.xhtml",
                   '<?xml version="1.0" encoding="utf-8"?>\n'
                   '<html xmlns="http://www.w3.org/1999/xhtml" '
                   'xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/>'
                   f'<title>目录</title></head><body><nav epub:type="toc"><h1>{_esc(title)}</h1>'
                   f'<ol>{"".join(navs)}</ol></nav></body></html>')
        z.writestr("OEBPS/content.opf",
                   '<?xml version="1.0" encoding="utf-8"?>\n'
                   '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
                   'unique-identifier="bookid"><metadata '
                   'xmlns:dc="http://purl.org/dc/elements/1.1/">'
                   f'<dc:title>{_esc(title)}</dc:title><dc:language>zh-CN</dc:language>'
                   f'<dc:identifier id="bookid">{uid}</dc:identifier>'
                   f'<dc:creator>{_esc(author)}</dc:creator></metadata><manifest>'
                   '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" '
                   'properties="nav"/><item id="css" href="style.css" media-type="text/css"/>'
                   + "".join(items) + '</manifest><spine>' + "".join(spine)
                   + '</spine></package>')
    return _download(buf.getvalue(), f"{_safe_name(title)}.epub", "application/epub+zip")


def _esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ── PDF ─────────────────────────────────────────────────────────────────────
FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"


@router.get("/export/pdf")
async def export_pdf(request: Request, slug: str, chapters: str = "", font_size: int = 11):
    """用本机自带的中文字体（文泉驿正黑）直接生成 PDF，手机上能看、能打印。"""
    current_user(request)
    s = _slug(slug)
    try:
        from reportlab.lib.pagesizes import A5
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.pdfgen import canvas
    except ImportError:
        raise HTTPException(500, "服务器没装 PDF 组件（reportlab），先用 EPUB 或 TXT 吧")
    import os
    if not os.path.exists(FONT_PATH):
        raise HTTPException(500, "服务器上没有中文字体，导不了 PDF")
    pdfmetrics.registerFont(TTFont("WQY", FONT_PATH, subfontIndex=0))
    files = _pick(s, chapters)
    title = _book_title(s)
    buf = io.BytesIO()
    W, H = A5
    size = max(8, min(20, int(font_size or 11)))
    c = canvas.Canvas(buf, pagesize=A5)
    c.setTitle(title)
    margin, leading = 34, size * 1.75
    y = H - margin
    page = 1
    for f in files:
        c.setFont("WQY", size + 4)
        c.drawString(margin, y, f["name"])
        y -= leading * 1.4
        c.setFont("WQY", size)
        for para in read_text(s, f["path"]).splitlines():
            line = para.strip()
            if not line:
                y -= leading * 0.5
                continue
            for chunk in _wrap(line, size):
                if y < margin + leading:
                    _footer(c, page, margin, size, W); c.showPage(); page += 1; y = H - margin
                    c.setFont("WQY", size)
                c.drawString(margin, y, chunk)
                y -= leading
        y -= leading * 0.6
    _footer(c, page, margin, size, W)
    c.save()
    return _download(buf.getvalue(), f"{_safe_name(title)}.pdf", "application/pdf")


def _wrap(line: str, size: int, width: float = 330.0) -> list[str]:
    """按显示宽度折行（中文一字一宽，英文算半个）。"""
    per = max(8, int(width / size))
    out, cur, w = [], "", 0.0
    for ch in line:
        cw = 1.0 if ord(ch) > 0x2E80 else 0.55
        if w + cw > per:
            out.append(cur)
            cur, w = "", 0.0
        cur += ch
        w += cw
    if cur:
        out.append(cur)
    return out


def _footer(c, page: int, margin: float, size: int, W: float) -> None:
    c.setFont("WQY", 8)
    c.drawCentredString(W / 2, margin / 2, str(page))


# ── 打印视图（在手机上「打印成 PDF」也行） ──────────────────────────────────
@router.get("/export/print")
async def export_print(request: Request, slug: str, chapters: str = ""):
    current_user(request)
    s = _slug(slug)
    files = _pick(s, chapters)
    body = "".join(
        f'<h2>{_esc(f["name"])}</h2>'
        + "".join(f"<p>{_esc(ln)}</p>" for ln in read_text(s, f["path"]).splitlines() if ln.strip())
        for f in files)
    html = ("<!doctype html><html lang=zh-CN><head><meta charset=utf-8>"
            "<meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<title>{_esc(_book_title(s))}</title><style>"
            "body{font-family:serif;max-width:44em;margin:0 auto;padding:18px;line-height:1.9}"
            "h1{text-align:center}h2{margin-top:2em}p{text-indent:2em;margin:.45em 0}"
            "@media print{body{max-width:none}}</style></head><body>"
            f"<h1>{_esc(_book_title(s))}</h1>{body}</body></html>")
    return HTMLResponse(html)


# ── 整包导出（一本书的全部数据带走）────────────────────────────────────────
@router.get("/export/bundle")
async def export_bundle(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    d = dbm.db()
    title = _book_title(s)
    tables = ("act", "chapter", "scene", "outline", "moment", "episode", "entity",
              "entity_alias", "entity_relation", "fact", "fact_evidence", "arc", "thread",
              "thread_scene", "promise", "decision", "term", "material", "bookmark",
              "reading_progress", "chapter_version")
    data = {"exportedAt": now_ms(), "slug": s, "title": title}
    for t in tables:
        try:
            if t == "fact_evidence":
                # 这张表没有 slug 列（它是 facts 的从表）——以前照统一写法查 slug 会抛异常，
                # 被 except 吞掉后写成空数组：导出的包**一直缺"事实的出处"**。
                data[t] = d.query("SELECT * FROM fact_evidence WHERE fact_id IN"
                                  " (SELECT id FROM fact WHERE slug=?)", (s,))
            else:
                data[t] = d.query(f"SELECT * FROM {t} WHERE slug=?", (s,))
        except Exception:
            data[t] = []
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        base = book_dir(s)
        for f in sorted(base.rglob("*")):
            if f.is_file() and ".novel/revisions" not in str(f):
                z.write(str(f), "book/" + str(f.relative_to(base)))
        z.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=1))
        z.writestr("说明.txt",
                   "这是《%s》的整包数据。\nbook/ 里是原始书稿文件（manuscript 正文、"
                   "lorebook 设定、world 世界配置）。\ndata.json 里是数据库里的设定、"
                   "伏笔、时间线等结构化数据。\n换台机器时，把 book/ 里的文件放回"
                   " data/books/<slug>/ 就能继续写。\n" % title)
    return _download(buf.getvalue(), f"{_safe_name(title)}-整包.zip", "application/zip")


# ── 导入：Markdown 批量 ─────────────────────────────────────────────────────
@router.post("/import/markdown")
async def import_markdown(request: Request, slug: str = Form(""),
                          title: str = Form(""), prefix: str = Form("manuscript"),
                          files: list[UploadFile] = File(default=[])):
    """把 .md/.txt（或一个 zip）导成一本书的章节。章节名取文件名或第一个标题。"""
    current_user(request)
    s = safe_slug(slug or title or "")
    if not s:
        raise HTTPException(400, "给个书名或者 slug")
    if not book_dir(s).is_dir():
        create_book(title or slug or s)
    items: list[tuple[str, str]] = []
    for up in files or []:
        raw = await up.read()
        name = up.filename or "未命名"
        if name.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    for n in sorted(z.namelist()):
                        if n.lower().endswith((".md", ".txt")) and not n.startswith("__MACOSX"):
                            items.append((n.split("/")[-1], z.read(n).decode("utf-8", "replace")))
            except zipfile.BadZipFile:
                raise HTTPException(400, f"{name} 不是个正常的压缩包")
        else:
            if not name.lower().endswith((".md", ".txt")):
                raise HTTPException(400, f"{name} 不是 Markdown/文本文件")
            items.append((name, raw.decode("utf-8", "replace")))
    if not items:
        raise HTTPException(400, "没收到文件")
    base = (prefix or "manuscript").strip("/")
    made = []
    for i, (name, text) in enumerate(items, 1):
        stem = re.sub(r"\.(md|txt)$", "", name, flags=re.I)
        m = re.search(r"^#\s+(.+)$", text, re.M)
        chap = (m.group(1).strip() if m else stem)[:40]
        body = re.sub(r"^#\s+.+\n", "", text, count=1, flags=re.M) if m else text
        rel = f"{base}/{i:03d}-{_safe_name(chap)}.md"
        if (book_dir(s) / rel).exists():
            raise HTTPException(400, f"{rel} 已经存在，先改名或换个前缀")
        write_text(s, rel, body.strip() + "\n", origin="import", note="Markdown 导入")
        made.append({"path": rel, "name": chap, "words": hanzi(body)})
    from .books import sync_book
    sync_book(s)
    return {"ok": True, "slug": s, "imported": len(made), "chapters": made}


# ── 导入：整包还原（和 /export/bundle 对着）────────────────────────────────
@router.post("/import/bundle")
async def import_bundle(request: Request, file: UploadFile = File(...),
                        title: str = Form("")):
    """把「整包带走」出来的 zip 还原成一本书。

    规矩：
    * **绝不覆盖**已有书：slug 撞了就自动加后缀（《书名-还原》），老书一个字不动；
    * 先落书稿文件，再把 data.json 里结构化数据补进去（中间出错也留着书稿，不半途清空）；
    * 只认自己导出的包：里面有 `book/` 目录才算数，别人家的 zip 明确拒绝。
    """
    current_user(request)
    raw = await file.read()
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "这不是个正常的 zip")
    names = z.namelist()
    if not any(n.startswith("book/") for n in names):
        raise HTTPException(400, "这个包里没有 book/ 目录 —— 不是本 App「整包带走」出来的文件")
    data: dict = {}
    if "data.json" in names:
        try:
            data = json.loads(z.read("data.json").decode("utf-8"))
        except Exception as e:
            raise HTTPException(400, f"data.json 读不了：{e}")
    want = (title or str(data.get("title") or "") or "还原的书").strip()
    made = create_book(want, str(data.get("summary") or ""), kind="novel")
    s = made["slug"]
    base = book_dir(s)
    n_files = 0
    for n in names:
        if not n.startswith("book/") or n.endswith("/"):
            continue
        rel = n[len("book/"):]
        if not rel or ".." in rel.split("/") or rel.startswith("/"):
            continue
        dst = base / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(z.read(n))
        n_files += 1
    # 结构化数据：只补空的、不覆盖（这一本本来就是新建的，所以等于全补）
    d = dbm.db()
    restored: dict[str, int] = {}
    id_map: dict[tuple[str, int], int] = {}     # (表, 老 id) → 新 id
    # 外键要重新指：包里的 id 是**原书**的 id，直接照抄过来会指向别的书（甚至撞 FK 写不进去）。
    # 这张表就是"这一列指的是哪张表"；插之前一律换成新书的 id。
    FK_OF = {"entity_id": "entity", "from_id": "entity", "to_id": "entity", "location_id": "entity",
             "moment_id": "moment", "world_moment_id": "moment", "first_moment_id": "moment",
             "from_moment_id": "moment", "to_moment_id": "moment",
             "valid_from_moment_id": "moment", "valid_to_moment_id": "moment",
             "thread_id": "thread", "scene_id": "scene", "fact_id": "fact",
             "act_id": "act", "arc_id": "arc"}
    # 先插有 slug 的主表，顺手把 id 映射记下来
    for table, rows in (data.items() if isinstance(data, dict) else []):
        if table in ("exportedAt", "slug", "title", "summary") or not isinstance(rows, list):
            continue
        if not rows:
            continue
        try:
            cols = [r["name"] for r in d.query(f"PRAGMA table_info({table})")]
        except Exception:
            continue
        if not cols or "slug" not in cols:
            continue
        keep = [c for c in cols if c != "id"]
        added = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            vals = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
                    for k, v in row.items() if k in keep}
            for col in list(vals):
                ref = FK_OF.get(col)
                if not ref or vals[col] is None:
                    continue
                vals[col] = id_map.get((ref, int(vals[col])))     # 找不到就置空，别指向别人家
            vals["slug"] = s
            keys = [k for k in keep if k in vals]
            sql_cols = ",".join(keys)
            sql_ph = ",".join("?" for _ in keys)
            try:
                new_id = d.execute(f"INSERT INTO {table}({sql_cols}) VALUES({sql_ph})",
                                   tuple(vals[k] for k in keys))
                added += 1
                if row.get("id") is not None:
                    id_map[(table, int(row["id"]))] = int(new_id)
            except Exception:
                continue                      # 单条坏了不拖垮整包
        if added:
            restored[table] = added
    # 再补「没有 slug、靠外键挂上去」的从表（事实的出处、伏笔出现的场景）——
    # 不补的话，"回溯带出处"回来就只剩结论没有出处，等于半个包。
    for table, fk, fk_table in (("fact_evidence", "fact_id", "fact"),
                                ("thread_scene", "thread_id", "thread")):
        rows = data.get(table) if isinstance(data, dict) else None
        if not isinstance(rows, list) or not rows:
            continue
        cols = [r["name"] for r in d.query(f"PRAGMA table_info({table})")]
        added = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            new_fk = id_map.get((fk_table, int(row.get(fk) or 0)))
            if not new_fk:
                continue                      # 对应的主记录没进来，这条只好跳过
            vals = {k: v for k, v in row.items() if k in cols and k != "id"}
            vals[fk] = new_fk
            keys = list(vals)
            try:
                d.execute(f"INSERT INTO {table}({','.join(keys)})"
                          f" VALUES({','.join('?' for _ in keys)})",
                          tuple(vals[k] for k in keys))
                added += 1
            except Exception:
                continue
        if added:
            restored[table] = added
    from .books import sync_book
    sync_book(s)
    return {"ok": True, "slug": s, "title": want, "files": n_files,
            "chapters": len([x for x in names if x.startswith("book/manuscript/")
                             and x.endswith(".md")]),
            "restored": restored,
            "from": {"exportedAt": data.get("exportedAt"), "slug": data.get("slug")}}


# ── 导入：SillyTavern 角色卡 ────────────────────────────────────────────────
def _png_text_chunks(data: bytes) -> dict:
    """读 PNG 的 tEXt/iTXt 块（角色卡就藏在关键词 chara 里）。"""
    out: dict[str, str] = {}
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return out
    i = 8
    while i + 8 <= len(data):
        ln = int.from_bytes(data[i:i + 4], "big")
        typ = data[i + 4:i + 8]
        body = data[i + 8:i + 8 + ln]
        if typ == b"tEXt" and b"\x00" in body:
            k, v = body.split(b"\x00", 1)
            out[k.decode("latin-1")] = v.decode("latin-1")
        elif typ == b"iTXt" and b"\x00" in body:
            k = body.split(b"\x00", 1)[0].decode("latin-1")
            out[k] = body.split(b"\x00", 1)[1].split(b"\x00", 1)[-1].decode("utf-8", "replace")
        elif typ == b"IEND":
            break
        i += 12 + ln
    return out


def _card_to_entity(slug: str, card: dict) -> dict:
    from ..engine import world as W
    name = str(card.get("name") or card.get("char_name") or "").strip()
    if not name:
        raise HTTPException(400, "这张卡没有名字")
    data = {
        "description": card.get("description") or "",
        "personality": card.get("personality") or "",
        "scenario": card.get("scenario") or "",
        "firstMes": card.get("first_mes") or card.get("firstMes") or "",
        "example": card.get("mes_example") or "",
        "creator": card.get("creator") or "",
        "tags": card.get("tags") or [],
        "source": "SillyTavern 角色卡",
    }
    eid = W.upsert_entity(slug, "character", name, data,
                          aliases=[a for a in (card.get("aliases") or []) if a])
    return {"ok": True, "id": eid, "name": name}


@router.post("/import/character-card")
async def import_character_card(request: Request, slug: str = Form(""),
                                file: UploadFile = File(...)):
    """支持两种卡：SillyTavern 的 PNG（带 chara 元数据）和 JSON 卡。"""
    current_user(request)
    s = _slug(slug)
    raw = await file.read()
    name = (file.filename or "").lower()
    card = None
    if name.endswith(".json"):
        try:
            card = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            raise HTTPException(400, "这个 json 读不出来")
    else:
        chunks = _png_text_chunks(raw)
        blob = chunks.get("chara") or chunks.get("ccv3")
        if not blob:
            raise HTTPException(400, "这张 PNG 里没有角色卡数据（要 SillyTavern 导出的那种）")
        import base64
        try:
            card = json.loads(base64.b64decode(blob).decode("utf-8", "replace"))
        except Exception:
            raise HTTPException(400, "角色卡数据解不开")
    if isinstance(card, dict) and isinstance(card.get("data"), dict):
        card = {**card["data"], "name": card.get("name") or card["data"].get("name")}
    if not isinstance(card, dict):
        raise HTTPException(400, "角色卡格式不认识")
    return _card_to_entity(s, card)


# ── 导入：直接塞正文（把手上的文字贴进来） ──────────────────────────────────
@router.post("/import/text")
async def import_text(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    text = str(payload.get("text") or "")
    if not text.strip():
        raise HTTPException(400, "没有内容")
    name = str(payload.get("name") or "导入").strip()[:40]
    base = str(payload.get("prefix") or "manuscript").strip("/")
    rel = f"{base}/{_chapter_name(name)}.md"
    if (book_dir(s) / rel).exists() and not payload.get("overwrite"):
        raise HTTPException(400, "同名文件已存在")
    write_text(s, rel, text, origin="import", note="粘贴导入")
    from .books import sync_book
    sync_book(s)
    return {"ok": True, "path": rel, "words": hanzi(text)}
