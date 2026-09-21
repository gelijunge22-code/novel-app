# -*- coding: utf-8 -*-
"""登录、账号、健康检查、版本、日志、APK 下载。

这些是"门面"接口：前端 `api.js` 一进来就问 `api/app/status`，未登录就弹登录页。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Body, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from .. import db as dbm
from ..config import CFG
from ..paths import Paths
from ..security import (COOKIE, clear_login_fail, current_user, drop_token,
                        hash_password, issue_token, login_allowed, note_login_fail,
                        set_cookie, token_from, user_of, verify_password)
from ..store import P, now_ms, iso

router = APIRouter(tags=["core"])
VERSION = "1.0.0"


# ── 健康检查 ────────────────────────────────────────────────────────────────
@router.get("/health")
async def health():
    d = dbm.db()
    return {"ok": True, "version": VERSION, "time": now_ms(),
            "db": d.scalar("SELECT COUNT(*) FROM book") or 0,
            "uptimeSec": int(time.time() - STARTED_AT)}


# ── 门面 ────────────────────────────────────────────────────────────────────
@router.get("/app/info")
async def app_info():
    return {"name": CFG.get("app_name", "小说"), "authEnabled": True,
            "voice": CFG.get("default_voice")}


@router.get("/app/status")
async def app_status(request: Request):
    return {"loggedIn": bool(user_of(token_from(request)))}


@router.post("/app/login")
async def app_login(request: Request, response: Response, payload: dict = Body(...)):
    ip = request.client.host if request.client else "?"
    if not login_allowed(ip):
        raise HTTPException(429, "密码输错太多次，等 10 分钟再试")
    pw = str(payload.get("password", ""))
    row = dbm.db().one("SELECT * FROM user WHERE status='active' ORDER BY id LIMIT 1")
    # 手机上（App 自带后端）网页是本地起的，让用户输密码没意义：
    # 启动时后端生成一串**每台机器一份**的 local_token，WebView 带着它自动登录。
    # 只有配置里开了 local_trust（手机端才开）并且请求确实来自本机才认这串口令。
    tok = str(payload.get("token") or "")
    if row and tok and CFG.get("local_trust"):
        ip = request.client.host if request.client else ""
        if ip in ("127.0.0.1", "::1", "localhost") and tok == str(CFG.get("local_token") or ""):
            raw = issue_token(row["id"], request.headers.get("user-agent", ""))
            set_cookie(response, raw)
            return {"ok": True, "local": True, "token": raw,
                    "user": {"username": row["username"], "role": row["role"]}}
    if not row or not verify_password(pw, row["password_hash"], row["salt"]):
        note_login_fail(ip)
        time.sleep(1.0)
        raise HTTPException(401, "密码不对")
    clear_login_fail(ip)
    raw = issue_token(row["id"], request.headers.get("user-agent", ""))
    set_cookie(response, raw)
    dbm.db().execute("UPDATE user SET last_login_at=?, last_seen_at=? WHERE id=?",
                     (now_ms(), now_ms(), row["id"]))
    # 返回体里也带一份会话口令（除了 httponly cookie）。
    # **为什么需要**：App 的界面是从安装包里加载的（file:// 来源），跟服务器不同源 ——
    # 跨源拿不到 cookie，字节流（封面/听书音频/导出下载）和 EventSource 只能把口令挂在
    # URL 上（服务端认 ?token=，见 security.token_from）。
    # 安全性：这个 App 是单用户自用的写作工具、没有任何第三方内容；
    # 会话 cookie 依然是 SameSite=Lax + httponly 那一套，网页版行为不变。
    return {"ok": True, "token": raw,
            "user": {"username": row["username"], "role": row["role"]}}


@router.post("/app/logout")
async def app_logout(request: Request, response: Response):
    drop_token(token_from(request) or "")
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/auth/me")
async def auth_me(request: Request):
    u = user_of(token_from(request))
    if not u:
        # 与旧层一致：未登录也回 200，只是 user=null（前端据此决定弹不弹登录）
        return {"authEnabled": True, "user": None}
    return {"authEnabled": True, "user": {
        "id": str(u["id"]), "username": u["username"], "displayName": u["display_name"] or u["username"],
        "role": u["role"], "sessionVersion": u["session_version"]}}


@router.post("/app/change-password")
async def change_password(request: Request, payload: dict = Body(...)):
    me = current_user(request)
    old = str(payload.get("oldPassword") or payload.get("old") or "")
    new = str(payload.get("newPassword") or payload.get("new") or "")
    if len(new) < 4:
        raise HTTPException(400, "新密码太短（至少 4 位）")
    row = dbm.db().one("SELECT * FROM user WHERE id=?", (me["id"],))
    if not verify_password(old, row["password_hash"], row["salt"]):
        raise HTTPException(400, "原密码不对")
    h, salt = hash_password(new)
    dbm.db().execute("UPDATE user SET password_hash=?, salt=?, session_version=session_version+1,"
                     " updated_at=? WHERE id=?", (h, salt, now_ms(), me["id"]))
    dbm.db().execute("UPDATE session_token SET revoked=1 WHERE user_id=?", (me["id"],))
    return {"ok": True, "note": "密码改了，请重新登录"}


@router.get("/admin/users")
async def admin_users(request: Request):
    me = current_user(request)
    if me["role"] != "admin":
        raise HTTPException(403, "只有管理员能看账号列表")
    rows = dbm.db().query("SELECT * FROM user ORDER BY id")
    out = []
    for r in rows:
        out.append({
            "id": str(r["id"]), "username": r["username"],
            "displayName": r["display_name"] or r["username"], "role": r["role"],
            "status": r["status"], "sessionVersion": r["session_version"],
            "lastLoginAt": iso(r["last_login_at"]), "lastSeenAt": iso(r["last_seen_at"]),
            "createdAt": iso(r["created_at"]), "updatedAt": iso(r["updated_at"]),
        })
    return out


@router.post("/admin/users")
async def admin_user_create(request: Request, payload: dict = Body(...)):
    me = current_user(request)
    if me["role"] != "admin":
        raise HTTPException(403, "只有管理员能建账号")
    name = (payload.get("username") or "").strip()
    pw = str(payload.get("password") or "")
    if not name or len(pw) < 4:
        raise HTTPException(400, "用户名不能空，密码至少 4 位")
    if dbm.db().one("SELECT id FROM user WHERE username=?", (name,)):
        raise HTTPException(400, "这个名字已经有了")
    h, salt = hash_password(pw)
    n = now_ms()
    dbm.db().execute(
        "INSERT INTO user(username,display_name,password_hash,salt,role,status,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        (name, payload.get("displayName") or name, h, salt,
         payload.get("role") or "user", "active", n, n))
    return {"ok": True}




# ── 版本与日志 ──────────────────────────────────────────────────────────────
@router.get("/app/version")
async def app_version():
    return {"versionLabel": f"小说 App 自研后端 {VERSION}",
            "versionKind": "release", "githubUrl": ""}


@router.get("/app/logs/status")
async def logs_status(request: Request):
    current_user(request)
    files = []
    total = 0
    for f in sorted(P.logs.glob("*")):
        if not f.is_file():
            continue
        st = f.stat()
        total += st.st_size
        files.append({"path": str(f), "name": f.name, "size": st.st_size,
                      "mtimeMs": st.st_mtime * 1000.0})
    return {"directory": str(P.logs), "currentFile": str(P.logs / "server.jsonl"),
            "files": files[-12:], "fileCount": len(files), "totalBytes": total,
            "latestMtimeMs": files[-1]["mtimeMs"] if files else None}


@router.get("/app/logs/download")
async def logs_download(request: Request, file: str = ""):
    current_user(request)
    name = Path(file or "server.jsonl").name          # 只认文件名，防穿越
    f = P.logs / name
    if not f.exists():
        raise HTTPException(404, "没有这个日志文件")
    return FileResponse(str(f), media_type="application/octet-stream", filename=name)


# ── APK 版本（**唯一出处**：build.sh 用 aapt2 从安装包里读出来写进 apk-version.json）──
@router.get("/apk/version")
async def apk_version():
    for cand in (P.apk / "apk-version.json", P.repo / "apk-version.json"):
        if cand.exists():
            try:
                d = json.loads(cand.read_text("utf-8"))
                d["available"] = bool(d.get("versionCode"))
                # 注意：路由挂在 /api 前缀下，**下载地址是 /api/apk**。
                # 以前这里写 "/apk" —— 前端照着这个地址去下更新，下回来的是 404 页面，
                # 表现成"点了下载/更新，更新不了"。这个字段不许再写错。
                d.setdefault("url", "/api/apk")
                return d
            except Exception:
                raise HTTPException(500, "版本清单读不出来")
    return {"versionCode": None, "versionName": None, "available": False}


@router.get("/apk")
async def apk_download():
    for cand in (P.apk / "手机写作台.apk", P.apk / "app-release.apk",
                 P.repo / "apk" / "手机写作台.apk"):
        if cand.exists():
            return FileResponse(str(cand), media_type="application/vnd.android.package-archive",
                                filename="xiezuotai.apk")
    raise HTTPException(404, "apk 还没打包")


STARTED_AT = time.time()


# ── 通知 ────────────────────────────────────────────────────────────────────
@router.get("/notifications")
async def notifications(request: Request, limit: int = 30):
    current_user(request)
    rows = dbm.db().query("SELECT * FROM notification ORDER BY created_at DESC LIMIT ?", (limit,))
    return {"items": rows,
            "unread": dbm.db().scalar("SELECT COUNT(*) FROM notification WHERE read_at IS NULL") or 0}


@router.post("/notifications/read")
async def notifications_read(request: Request, payload: dict = Body(default={})):
    current_user(request)
    if payload.get("all"):
        dbm.db().execute("UPDATE notification SET read_at=? WHERE read_at IS NULL", (now_ms(),))
    elif payload.get("id"):
        dbm.db().execute("UPDATE notification SET read_at=? WHERE id=?", (now_ms(), payload["id"]))
    return {"ok": True}


def notify(kind: str, title: str, body: str = "", slug: str = "") -> None:
    dbm.db().execute(
        "INSERT INTO notification(kind,title,body,slug,created_at) VALUES(?,?,?,?,?)",
        (kind, title, body, slug, now_ms()))
