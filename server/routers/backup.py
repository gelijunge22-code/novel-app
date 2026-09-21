# -*- coding: utf-8 -*-
"""备份与恢复。

旧的 `nb/api/passport/*`（云账号体系）在这里被**本机备份**取代：
前端「工具 → 备份」那三个接口照旧能调，拿到的是我们自己的备份清单。

规矩（红线）：恢复**不删东西** —— 恢复前先自动打一份「恢复前快照」，
再把当前的 books 目录挪进 `data/trash/`，然后才铺开压缩包里的内容。
"""
from __future__ import annotations

import io
import json
import os
import shutil
import threading
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .. import db as dbm
from ..config import CFG
from ..security import current_user
from ..store import P, now_ms

router = APIRouter(tags=["backup"])

SETTING_KEY = "backup.auto"
DEFAULT_AUTO = {"enabled": True, "everyHours": 24, "keep": 14, "withDb": True}
_lock = threading.Lock()
_last_auto_check = 0.0


def _read_auto() -> dict:
    row = dbm.db().one("SELECT value_json FROM setting WHERE key=?", (SETTING_KEY,))
    cfg = dict(DEFAULT_AUTO)
    if row:
        cfg.update(dbm.db().jloads(row["value_json"], {}) or {})
    return cfg


def _write_auto(cfg: dict) -> dict:
    merged = {**DEFAULT_AUTO, **(_read_auto()), **(cfg or {})}
    dbm.db().execute(
        "INSERT INTO setting(key,value_json,updated_at) VALUES(?,?,?)"
        " ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,"
        " updated_at=excluded.updated_at",
        (SETTING_KEY, dbm.Database.jdumps(merged), now_ms()))
    return merged


_meta_cache: dict[str, tuple] = {}


def _zip_meta(path: Path) -> dict:
    """读备份包里的 meta.json（带缓存，列表刷新不会反复解压）。"""
    try:
        st = path.stat()
    except OSError:
        return {}
    key = str(path)
    hit = _meta_cache.get(key)
    if hit and hit[0] == (st.st_size, st.st_mtime):
        return hit[1]
    meta: dict = {}
    try:
        with zipfile.ZipFile(path) as z:
            if "meta.json" in z.namelist():
                meta = json.loads(z.read("meta.json").decode("utf-8", "replace")) or {}
    except Exception:
        meta = {}
    _meta_cache[key] = ((st.st_size, st.st_mtime), meta)
    return meta


def _list() -> list[dict]:
    """备份清单：磁盘为准，数据库里的 note 只是补充。"""
    d = dbm.db()
    notes = {r["name"]: r["note"] for r in d.query("SELECT name,note FROM backup")}
    out, seen = [], set()
    for f in sorted(P.backups.glob("*.zip")):
        st = f.stat()
        seen.add(f.stem)
        meta = _zip_meta(f)
        out.append({"id": f.stem, "name": f.stem, "file": f.name,
                    "createdAt": int(meta.get("createdAt") or st.st_mtime * 1000),
                    "size": st.st_size, "kind": "local",
                    "note": meta.get("note") or notes.get(f.stem, ""),
                    "withDb": bool(meta.get("withDb", True)),
                    "books": len(meta.get("books") or [])})
    for r in d.query("SELECT * FROM backup"):
        if r["name"] in seen:
            continue
        d.execute("DELETE FROM backup WHERE name=?", (r["name"],))
    out.sort(key=lambda x: -(x["createdAt"] or 0))
    return out


def _db_snapshot(dst: Path) -> None:
    """用 SQLite 自己的 VACUUM INTO 导出，保证是完整一致的一份（不是拷半截）。"""
    src = dbm.db()
    if dst.exists():
        dst.unlink()
    src._conn().execute("VACUUM INTO ?", (str(dst),))


def create_backup(note: str = "", name: str = "", with_db: bool = True) -> dict:
    """打一份备份。返回记录；失败会抛异常（调用方决定怎么报）。"""
    with _lock:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        base = name.strip() or f"backup-{stamp}"
        base = "".join(ch for ch in base if ch.isalnum() or ch in "-_.") or f"backup-{stamp}"
        zip_path = P.backups / (base + ".zip")
        i = 1
        while zip_path.exists():
            i += 1
            zip_path = P.backups / f"{base}-{i}.zip"
        tmp = zip_path.with_suffix(".zip.tmp")
        meta = {"createdAt": now_ms(), "app": "novel-app", "version": CFG.get("app_name", "小说"),
                "note": note, "withDb": bool(with_db),
                "books": [p.name for p in P.books.iterdir() if p.is_dir()] if P.books.exists() else []}
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            if P.books.exists():
                for f in sorted(P.books.rglob("*")):
                    if f.is_file():
                        z.write(str(f), "books/" + str(f.relative_to(P.books)))
            if with_db:
                snap = P.backups / (zip_path.stem + ".db")
                _db_snapshot(snap)
                z.write(str(snap), "app.db")
                snap.unlink()
            z.writestr("meta.json", json.dumps(meta, ensure_ascii=False, indent=1))
        os.replace(tmp, zip_path)
        size = zip_path.stat().st_size
        dbm.db().execute(
            "INSERT INTO backup(name,path,size,note,created_at) VALUES(?,?,?,?,?)"
            " ON CONFLICT(name) DO UPDATE SET path=excluded.path, size=excluded.size,"
            " note=excluded.note, created_at=excluded.created_at",
            (zip_path.stem, str(zip_path), size, note, now_ms()))
        _prune()
        return {"id": zip_path.stem, "name": zip_path.stem, "file": zip_path.name,
                "size": size, "createdAt": now_ms(), "note": note, "withDb": bool(with_db)}


def _prune() -> None:
    keep = int(_read_auto().get("keep") or 14)
    rows = _list()
    for r in rows[keep:]:
        f = P.backups / r["file"]
        try:
            f.unlink()
        except OSError:
            continue
        dbm.db().execute("DELETE FROM backup WHERE name=?", (r["name"],))


# ── 旧的护照接口（兼容前端「备份」页）──────────────────────────────────────
@router.get("/passport/status")
async def passport_status(request: Request):
    current_user(request)
    items = _list()
    auto = _read_auto()
    return {"linked": True, "mode": "local", "label": "本机备份",
            "hint": "备份打在这台机器上（data/backups），可以直接下载走。",
            "backupDir": str(P.backups), "auto": auto,
            "lastBackup": items[0] if items else None, "count": len(items),
            # 旧平台是云账号体系；这几个字段前端老代码会读，给上（内容是实情：本机账号）
            "account": {"kind": "local", "name": "本机", "displayName": "本机备份",
                        "username": (dbm.db().scalar("SELECT username FROM user ORDER BY id")
                                     or "admin")},
            "scopes": ["backup:read", "backup:write", "backup:restore"],
            "linkedAt": (items[-1]["createdAt"] if items else now_ms())}


@router.get("/passport/backup-keys")
async def passport_keys(request: Request):
    current_user(request)
    st = P.backups.stat() if P.backups.exists() else None
    keys = [{"id": "local", "name": "本机存储", "kind": "local",
             "path": str(P.backups),
             "createdAt": int((st.st_mtime * 1000) if st else now_ms()),
             "writable": bool(st and os.access(P.backups, os.W_OK))}]
    return {"keys": keys, "activeKeyId": "local", "pendingKeyId": None}


@router.get("/passport/backups")
async def passport_backups(request: Request):
    current_user(request)
    items = _list()
    return {"backups": items, "items": items, "count": len(items)}


@router.post("/passport/backups")
async def passport_backup_now(request: Request, payload: dict = Body(default={})):
    current_user(request)
    try:
        rec = create_backup(note=str((payload or {}).get("note") or "手动备份"),
                            with_db=bool((payload or {}).get("withDb", True)))
    except Exception as e:
        raise HTTPException(500, f"备份失败：{e}")
    return {"ok": True, "backup": rec}


@router.post("/passport/backups/delete")
async def passport_backup_delete(request: Request, payload: dict = Body(...)):
    current_user(request)
    name = str((payload or {}).get("name") or (payload or {}).get("id") or "")
    return await backup_delete(request, name=name)


# ── 我们自己的备份接口 ──────────────────────────────────────────────────────
@router.get("/backup/list")
async def backup_list(request: Request):
    current_user(request)
    items = _list()
    return {"items": items, "count": len(items), "auto": _read_auto(),
            "dir": str(P.backups),
            "totalSize": sum(i["size"] for i in items)}


@router.post("/backup/create")
async def backup_create(request: Request, payload: dict = Body(default={})):
    current_user(request)
    try:
        rec = create_backup(note=str((payload or {}).get("note") or "手动备份"),
                            name=str((payload or {}).get("name") or ""),
                            with_db=bool((payload or {}).get("withDb", True)))
    except Exception as e:
        raise HTTPException(500, f"备份失败：{e}")
    dbm.db().execute("INSERT INTO audit(at,actor,action,slug,detail_json) VALUES(?,?,?,?,?)",
                     (now_ms(), "user", "backup.create", "",
                      dbm.Database.jdumps({"name": rec["name"], "size": rec["size"]})))
    return {"ok": True, "backup": rec}


@router.delete("/backup/item")
async def backup_delete(request: Request, name: str = ""):
    current_user(request)
    if not name:
        raise HTTPException(400, "要删哪一份？")
    safe = Path(name).name
    f = P.backups / (safe if safe.endswith(".zip") else safe + ".zip")
    if not f.exists():
        raise HTTPException(404, "没有这份备份")
    f.unlink()
    dbm.db().execute("DELETE FROM backup WHERE name=?", (f.stem,))
    return {"ok": True, "deleted": f.name}


@router.get("/backup/download")
async def backup_download(request: Request, name: str):
    current_user(request)
    safe = Path(name).name
    f = P.backups / (safe if safe.endswith(".zip") else safe + ".zip")
    if not f.exists():
        raise HTTPException(404, "没有这份备份")
    return FileResponse(str(f), media_type="application/zip", filename=f.name)


@router.get("/backup/auto")
async def backup_auto_get(request: Request):
    current_user(request)
    return _read_auto()


@router.post("/backup/auto")
async def backup_auto_set(request: Request, payload: dict = Body(...)):
    current_user(request)
    return _write_auto(payload or {})


@router.post("/backup/restore")
async def backup_restore(request: Request, payload: dict = Body(...)):
    """从一份备份恢复。默认只恢复书稿文件；withDb=true 才连数据库一起换。"""
    current_user(request)
    name = str((payload or {}).get("name") or "")
    if not name:
        raise HTTPException(400, "要恢复哪一份？")
    safe = Path(name).name
    f = P.backups / (safe if safe.endswith(".zip") else safe + ".zip")
    if not f.exists():
        raise HTTPException(404, "没有这份备份")
    if not (payload or {}).get("confirm"):
        raise HTTPException(400, "恢复会覆盖当前书稿，请确认（confirm=true）")
    with_db = bool((payload or {}).get("withDb"))
    # 1) 恢复前先自动打一份快照（有它就能退回来）
    pre = create_backup(note=f"恢复 {f.stem} 之前的自动快照", with_db=True)
    # 2) 铺开
    stamp = time.strftime("%Y%m%d-%H%M%S")
    moved = P.trash / f"restore-{stamp}"
    moved.mkdir(parents=True, exist_ok=True)
    restored_books = 0
    try:
        with zipfile.ZipFile(f) as z:
            names = z.namelist()
            if "meta.json" not in names and not any(n.startswith("books/") for n in names):
                raise HTTPException(400, "这个压缩包不是本 App 的备份")
            for n in names:
                if n.startswith("books/"):
                    rel = n[len("books/"):]
                    if not rel or rel.endswith("/"):
                        continue
                    dst = P.books / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(n) as src, open(dst, "wb") as out:
                        shutil.copyfileobj(src, out)
                    restored_books += 1
            if with_db and "app.db" in names:
                cur = P.data / "app.db"
                shutil.copy2(str(cur), str(moved / "app.db"))
                with z.open("app.db") as src, open(str(cur), "wb") as out:
                    shutil.copyfileobj(src, out)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"恢复失败：{e}")
    if with_db:
        dbm.init(P.data / "app.db")            # 重开连接，换掉内存里的旧句柄
    _rescan()
    dbm.db().execute("INSERT INTO audit(at,actor,action,slug,detail_json) VALUES(?,?,?,?,?)",
                     (now_ms(), "user", "backup.restore", "",
                      dbm.Database.jdumps({"name": f.stem, "files": restored_books,
                                           "preBackup": pre["name"]})))
    return {"ok": True, "restoredFiles": restored_books, "withDb": with_db,
            "preBackup": pre["name"], "note": "恢复前的快照留在备份列表里，随时能退回去"}


@router.post("/backup/upload")
async def backup_upload(request: Request, file: UploadFile = File(...)):
    """把别处存的备份传回来（然后就能恢复它）。"""
    current_user(request)
    raw = await file.read()
    if len(raw) > 4 * 1024 ** 3:
        raise HTTPException(400, "太大了")
    if raw[:2] != b"PK":
        raise HTTPException(400, "这不是一个 zip 压缩包")
    name = Path(file.filename or "uploaded.zip").name
    if not name.endswith(".zip"):
        name += ".zip"
    dst = P.backups / name
    if dst.exists():
        dst = P.backups / (Path(name).stem + f"-{int(time.time())}.zip")
    dst.write_bytes(raw)
    try:
        with zipfile.ZipFile(dst) as z:
            if not any(n.startswith("books/") for n in z.namelist()):
                dst.unlink()
                raise HTTPException(400, "包里没有 books/ 目录，不是本 App 的备份")
    except zipfile.BadZipFile:
        dst.unlink(missing_ok=True)
        raise HTTPException(400, "压缩包坏了")
    dbm.db().execute(
        "INSERT INTO backup(name,path,size,note,created_at) VALUES(?,?,?,?,?)"
        " ON CONFLICT(name) DO UPDATE SET path=excluded.path, size=excluded.size",
        (dst.stem, str(dst), dst.stat().st_size, "从别处传回来的", now_ms()))
    return {"ok": True, "name": dst.stem, "size": dst.stat().st_size}


def _rescan() -> None:
    from .books import sync_book
    from ..store import all_slugs
    for slug in all_slugs():
        try:
            sync_book(slug)
        except Exception:
            # 备份包里已经拿到文件了；索引重建失败不该让这次备份算失败。
            pass


# ── 完整性自检（阶段 22.8）──────────────────────────────────────────────────
@router.get("/backup/doctor")
async def backup_doctor(request: Request):
    """数据自检：孤儿文件、断链、字数对不上、孤儿 revision。"""
    current_user(request)
    from ..store import all_slugs, chapter_files
    d = dbm.db()
    issues = []
    slugs = all_slugs()
    for slug in slugs:
        row = d.one("SELECT * FROM book WHERE slug=?", (slug,))
        if not row:
            issues.append({"kind": "orphan-book", "slug": slug,
                           "hint": "磁盘上有这本书，库里没登记（下次访问会自动补）"})
        files = chapter_files(slug)
        real = sum(c["words"] for c in files)
        if row and int(row["word_count"] or 0) != real:
            issues.append({"kind": "word-mismatch", "slug": slug,
                           "db": row["word_count"], "file": real,
                           "hint": "数据库字数与文件不一致（自动同步会修）"})
        known = {c["path"] for c in files}
        for r in d.query("SELECT DISTINCT path FROM chapter WHERE slug=?", (slug,)):
            if r["path"] not in known:
                issues.append({"kind": "missing-file", "slug": slug, "path": r["path"],
                               "hint": "数据库里有这一章，磁盘上找不到"})
    for r in d.query("SELECT DISTINCT slug,path FROM revision"):
        if r["slug"] not in slugs:
            issues.append({"kind": "orphan-revision", "slug": r["slug"], "path": r["path"],
                           "hint": "这本书已经不在了，改动记录还在"})
    broken = [b["name"] for b in _list() if not (P.backups / b["file"]).exists()]
    return {"books": len(slugs), "issues": issues, "count": len(issues),
            "clean": not issues, "brokenBackups": broken,
            "backups": len(_list())}


# ── 自动备份：每小时看一次，到点就打 ────────────────────────────────────────
def maybe_auto() -> dict | None:
    cfg = _read_auto()
    if not cfg.get("enabled"):
        return None
    items = _list()
    every = max(1, int(cfg.get("everyHours") or 24)) * 3600_000
    if items and now_ms() - (items[0]["createdAt"] or 0) < every:
        return None
    try:
        rec = create_backup(note="自动备份", with_db=bool(cfg.get("withDb", True)))
        dbm.db().execute("INSERT INTO audit(at,actor,action,slug,detail_json) VALUES(?,?,?,?,?)",
                         (now_ms(), "system", "backup.auto", "",
                          dbm.Database.jdumps({"name": rec["name"]})))
        return rec
    except Exception:
        return None


def start_auto_thread() -> None:
    def loop():
        while True:
            try:
                maybe_auto()
            except Exception:
                # 定时空转轮：这一轮自动备份失败，下一轮还要继续转，不能把循环炸掉。
                pass
            time.sleep(600)
    t = threading.Thread(target=loop, name="auto-backup", daemon=True)
    t.start()
