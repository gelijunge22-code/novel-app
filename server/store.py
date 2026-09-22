# -*- coding: utf-8 -*-
"""书稿文件层：`data/books/<slug>/` 的全部读写都在这里。

为什么要这一层：正文是用户的命，必须留在**肉眼可读的文件**里（见 docs/决策记录 D3）。
数据库只存元数据，磁盘才是正文的真相；两边对不上时以磁盘为准。

目录约定（与旧工作区兼容，迁移时直接复制即可读）：
    <书>/project.yaml            书名与简介
    <书>/manuscript/*.md         正文（平铺或 卷/章/index.md 两种都认）
    <书>/lorebook/<类别>/*.md    设定
    <书>/world/**                世界引擎（历法、schema、地图）
    <书>/agents/<档案>/**        文风/参考等档案资源（兼容旧 home 概念）
    <书>/.novel/{meta.json,cover.*,revisions/}
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path

from .config import CFG
from .paths import Paths, safe_rel, safe_slug, slugify

P = Paths(CFG)

SKIP_BASE = {"章节细纲.md", "README.md", "index.md"}
TEXT_EXT = {".md", ".txt", ".json", ".yaml", ".yml", ".ts", ".tsx", ".js", ".css",
            ".html", ".csv", ".log", ".ini", ".toml", ".py"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"}
MAX_TEXT_BYTES = 8 * 1024 * 1024      # 单个文本文件上限（防手滑把大文件拖进来）
REV_KEEP = 20                          # 每个文件保留多少份历史


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms) -> str | None:
    """毫秒时间戳 → ISO 字符串（前端 tools.js 两种形态都认，这里统一给 ISO）。"""
    if not ms:
        return None
    import datetime
    return (datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
            .isoformat(timespec="milliseconds").replace("+00:00", "Z"))


def hanzi(s: str) -> int:
    """汉字数 —— 与旧实现一致，保证前端显示的字数不跳变。"""
    return sum(1 for c in s if "\u4e00" <= c <= "\u9fa5")


# ── 基本路径 ────────────────────────────────────────────────────────────────
def book_dir(slug: str) -> Path:
    s = safe_slug(slug)
    if not s:
        raise ValueError("作品标识不合法")
    return P.books / s


def exists(slug: str) -> bool:
    try:
        return book_dir(slug).is_dir()
    except ValueError:
        return False


def all_slugs() -> list[str]:
    if not P.books.exists():
        return []
    out = []
    for d in sorted(P.books.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            out.append(d.name)
    return out


def ensure_dirs(slug: str) -> Path:
    b = book_dir(slug)
    (b / "manuscript").mkdir(parents=True, exist_ok=True)
    (b / "lorebook").mkdir(parents=True, exist_ok=True)
    (b / "world").mkdir(parents=True, exist_ok=True)
    (b / ".novel").mkdir(parents=True, exist_ok=True)
    return b


def inner_path(slug: str, rel: str) -> Path:
    """书内相对路径 → 绝对路径（已做穿越防护）。"""
    r = safe_rel(rel)
    if r is None:
        raise ValueError("路径不合法")
    base = book_dir(slug).resolve()
    p = (base / r).resolve()
    if not str(p).startswith(str(base) + os.sep) and p != base:
        raise ValueError("路径越界")
    return p


# ── project.yaml（书名/简介）────────────────────────────────────────────────
def _yaml_get(text: str, key: str) -> str:
    for line in text.splitlines():
        m = re.match(r"^\s*" + re.escape(key) + r"\s*:\s*(.*)$", line)
        if m:
            v = m.group(1).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            return v
    return ""


def read_project_yaml(slug: str) -> dict:
    f = book_dir(slug) / "project.yaml"
    if not f.exists():
        return {}
    try:
        t = f.read_text("utf-8")
    except Exception:
        return {}
    return {k: _yaml_get(t, k) for k in ("kind", "title", "summary", "author")}


def write_project_yaml(slug: str, meta: dict) -> None:
    lines = [
        "kind: " + str(meta.get("kind") or "novel"),
        "title: " + str(meta.get("title") or slug),
        "summary: " + str(meta.get("summary") or "").replace("\n", " "),
    ]
    if meta.get("author"):
        lines.append("author: " + str(meta["author"]))
    (book_dir(slug) / "project.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def is_chapter_path(path: str) -> bool:
    """正文文件判定（对齐旧层 `_book` 的两种结构）。"""
    if not path.startswith("manuscript/") or not path.endswith(".md"):
        return False
    rest = path[len("manuscript/"):]
    base = rest.split("/")[-1]
    if base in SKIP_BASE:
        # 卷/章结构里 index.md 是正文；平铺结构里 index.md 是目录索引
        return rest.count("/") >= 2
    if "/" not in rest:
        return True
    # 有子目录：只认「章目录/index.md」和「卷/章.md」
    if base == "index.md":
        return True
    return rest.count("/") == 1


def chapter_title(path: str) -> str:
    base = path.split("/")[-1]
    if base.endswith(".md"):
        base = base[:-3]
    if base == "index":
        parts = path.split("/")
        return parts[-2] if len(parts) >= 2 else "index"
    return base


def _chapter_sort_key(path: str):
    nums = tuple(int(x) for x in re.findall(r"(\d+)", path))
    if nums:
        return (0, nums, path)
    name = path.split("/")[-1]
    m = re.search(r"第\s*0*(\d+)\s*章", name)
    if m:
        return (1, (int(m.group(1)),), path)
    m = re.search(r"^0*(\d+)", name)
    if m:
        return (2, (int(m.group(1)),), path)
    return (3, (0,), path)


# ── 目录树 ──────────────────────────────────────────────────────────────────
def entry_type(path: str) -> str:
    if is_chapter_path(path):
        return "chapter"
    if path.startswith("lorebook/"):
        return "lore"
    if path.startswith("world/"):
        return "world"
    if path.startswith("agents/"):
        return "agent"
    if path.startswith("reference/"):
        return "reference"
    if path.startswith("upload/"):
        return "upload"
    return "file"


def file_icon(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext == ".md":
        return "file"
    if ext in (".json", ".yaml", ".yml"):
        return "database"
    return "file"


def walk(slug: str) -> list[dict]:
    """整棵文件的扁平清单（前端文件浏览器直接吃这个）。"""
    return walk_dir(book_dir(slug))


def walk_dir(base: Path) -> list[dict]:
    """任意根目录的扁平清单。书稿和「用户资产」两个工作区共用这一份实现。"""
    nodes: list[dict] = []
    if not base.is_dir():
        return nodes
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        rel_root = Path(root).relative_to(base).as_posix()
        rel_root = "" if rel_root == "." else rel_root + "/"
        for name in sorted(files):
            if name.startswith("."):
                continue
            rel = rel_root + name
            fp = base / rel
            try:
                st = fp.stat()
            except OSError:
                continue
            node = {
                "path": rel,
                "name": name,
                "isDirectory": False,
                "size": st.st_size,
                "mtimeMs": st.st_mtime * 1000.0,
                "entryType": entry_type(rel),
                "icon": file_icon(rel),
            }
            if node["entryType"] == "chapter":
                node["title"] = chapter_title(rel)
            nodes.append(node)
    nodes.sort(key=lambda n: n["path"])
    return nodes


def chapter_files(slug: str) -> list[dict]:
    """正文清单（顺序 = 阅读顺序），带字数与 mtime。"""
    from . import db as dbm
    base = book_dir(slug)
    rows = {r["path"]: r for r in dbm.db().query(
        "SELECT path, words, mtime_ms FROM chapter WHERE slug=?", (slug,))}
    out = []
    for node in walk(slug):
        p = node["path"]
        if not is_chapter_path(p):
            continue
        rec = rows.get(p)
        mtime = node["mtimeMs"]
        if not rec or abs((rec.get("mtime_ms") or 0) - mtime) > 1:
            try:
                text = read_text(slug, p)
            except Exception:
                text = ""
            out.append({"path": p, "name": chapter_title(p), "words": hanzi(text),
                        "mtimeMs": mtime})
        else:
            out.append({"path": p, "name": chapter_title(p), "words": rec["words"],
                        "mtimeMs": mtime})
    out.sort(key=lambda c: _chapter_sort_key(c["path"]))
    for i, c in enumerate(out):
        c["index"] = i + 1
    return out


# ── 读 / 写 ─────────────────────────────────────────────────────────────────
def read_bytes(slug: str, rel: str) -> bytes:
    return inner_path(slug, rel).read_bytes()


def read_text(slug: str, rel: str) -> str:
    p = inner_path(slug, rel)
    data = p.read_bytes()
    if len(data) > MAX_TEXT_BYTES:
        raise ValueError("文件太大，读不了")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", "replace")


def mtime_ms(slug: str, rel: str) -> int:
    """文件的修改时间（**整数**毫秒，单一出处）。

    以前返回的是 float（`st_mtime * 1000.0`），看着没事，但它会被拼进 URL query
    （对端同步的 `&since=`）—— 到那边的 FastAPI 是 `int` 参数，收到 "1789830488685.0"
    直接回 422，于是"这一章没取到"。全站毫秒都当整数用，这里就统一成整数。
    """
    return int(inner_path(slug, rel).stat().st_mtime * 1000)


def write_text(slug: str, rel: str, content: str, *, snapshot: bool = True,
               origin: str = "user", note: str = "", pending: bool | None = None) -> dict:
    """写文件。写之前先把旧内容留一份快照（可回滚），再落盘。"""
    p = inner_path(slug, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    before = ""
    if p.exists():
        if snapshot:
            try:
                before = p.read_text("utf-8")
            except Exception:
                before = ""
        mtime_before = p.stat().st_mtime * 1000.0
    else:
        mtime_before = 0.0
    tmp = p.with_name(p.name + ".tmp-write")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, p)
    if snapshot and before != content:
        _record_revision(slug, rel, before, content, origin=origin, note=note,
                         pending=pending)
    return {"mtimeMs": mtime_ms(slug, rel), "prevMtimeMs": mtime_before,
            "words": hanzi(content), "chars": len(content)}


def create_file(slug: str, rel: str, content: str = "") -> dict:
    p = inner_path(slug, rel)
    if p.exists():
        raise FileExistsError("已经有一个同名文件了")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    _record_revision(slug, rel, "", content, origin="user", note="新建")
    return {"ok": True, "path": rel, "mtimeMs": mtime_ms(slug, rel)}


def create_dir(slug: str, rel: str) -> dict:
    p = inner_path(slug, rel)
    if p.exists():
        raise FileExistsError("已经有一个同名目录了")
    p.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "path": rel}


def delete_path(slug: str, rel: str) -> dict:
    """删除 = 移进 data/trash（绝不真删，用户的东西不能丢）。"""
    p = inner_path(slug, rel)
    if not p.exists():
        raise FileNotFoundError("没有这个文件")
    dst = P.trash / slug / f"{int(time.time()*1000)}-{p.name}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(p), str(dst))
    return {"ok": True, "path": rel, "trashedTo": str(dst)}


def rename_path(slug: str, src: str, dst: str) -> dict:
    a = inner_path(slug, src)
    b = inner_path(slug, dst)
    if not a.exists():
        raise FileNotFoundError("原文件不在了")
    if b.exists():
        raise FileExistsError("目标已经存在")
    b.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(a), str(b))
    return {"ok": True, "from": src, "to": dst}


def copy_in(slug: str, dst_rel: str, data: bytes) -> dict:
    p = inner_path(slug, dst_rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return {"ok": True, "path": dst_rel, "size": len(data), "mtimeMs": mtime_ms(slug, dst_rel)}


# ── 版本快照 ────────────────────────────────────────────────────────────────
def _rev_dir(slug: str, rel: str) -> Path:
    key = re.sub(r"[^\w.-]+", "_", rel)[:80]
    return book_dir(slug) / ".novel" / "revisions" / key


def _record_revision(slug: str, rel: str, before: str, after: str, *,
                     origin: str = "user", note: str = "", pending: bool | None = None) -> None:
    from . import db as dbm
    d = dbm.db()
    rev = (d.scalar("SELECT MAX(rev) FROM revision WHERE slug=? AND path=?", (slug, rel)) or 0) + 1
    # 用户自己敲的字不进「改动收件箱」——那儿只等 AI 的改动（收/退）。见 docs/设计方案 §3.6
    # `pending`（新增，可选）：预设里「改动感知」选了"直接用"时，AI 的改动
    # 也直接算数（不再等确认）。不传就按老规矩（用户=算数，AI=等确认）。
    status = "accepted" if (pending is False or (pending is None and origin == "user")) else "pending"
    d.execute(
        "INSERT INTO revision(slug,path,rev,kind,actor,actor_kind,before_text,after_text,"
        "status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (slug, rel, rev, "write", "", origin, before, after, status, now_ms()))
    rd = _rev_dir(slug, rel)
    rd.mkdir(parents=True, exist_ok=True)
    (rd / f"{rev:05d}.md").write_text(after, encoding="utf-8")
    olds = sorted(rd.glob("*.md"))
    for f in olds[:-REV_KEEP]:
        try:
            f.unlink()
        except OSError:
            # 旧版本快照删不掉（被占用 / 已经没了）不算错：留在那儿也不影响新的。
            pass


def create_book(title: str, summary: str = "", kind: str = "novel") -> dict:
    from . import db as dbm
    title = (title or "").strip()
    if not title:
        raise ValueError("书名不能为空")
    slug = slugify(title)
    n = 1
    while exists(slug):
        n += 1
        slug = f"{slugify(title)}-{n}"
    ensure_dirs(slug)
    write_project_yaml(slug, {"kind": kind, "title": title, "summary": summary})
    (book_dir(slug) / ".novel" / "meta.json").write_text(
        json.dumps({"slug": slug, "title": title, "summary": summary, "kind": kind,
                    "createdAt": now_ms()}, ensure_ascii=False, indent=1), encoding="utf-8")
    now = now_ms()
    dbm.db().execute(
        "INSERT INTO book(slug,title,kind,summary,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        (slug, title, kind, summary, now, now))
    # 一本新书默认给一章，用户点进去就能写。
    # 正文留空：第 9 遍打磨实测过，以前模板写的是 `# {书名}` —— 自家质检的 ai.markdown 会把它
    # 当成"markdown 残留"（严重度 3），于是用户刚建好的书打开「质检」就是 **0 分 · 要改**。
    # 空章在阅读器里显示「（本章暂无正文）」，比一个假警报好。
    write_text(slug, "manuscript/第001章-未命名.md", "", snapshot=False)
    return {"ok": True, "slug": slug, "title": title}


# ── 任意根目录的读写（「用户资产」工作区用；书稿一律走 slug 版本）────────────
def resolve_in(root: Path, rel: str) -> Path:
    r = safe_rel(rel)
    if r is None:
        raise ValueError("路径不合法")
    base = Path(root).resolve()
    p = (base / r).resolve()
    if not str(p).startswith(str(base) + os.sep) and p != base:
        raise ValueError("路径越界")
    return p


def read_text_in(root: Path, rel: str) -> str:
    p = resolve_in(root, rel)
    data = p.read_bytes()
    if len(data) > MAX_TEXT_BYTES:
        raise ValueError("文件太大，读不了")
    return data.decode("utf-8", "replace")


def write_text_in(root: Path, rel: str, content: str) -> dict:
    p = resolve_in(root, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp-write")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, p)
    return {"mtimeMs": p.stat().st_mtime * 1000.0, "words": hanzi(content), "chars": len(content)}
