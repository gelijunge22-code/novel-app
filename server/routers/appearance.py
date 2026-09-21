# -*- coding: utf-8 -*-
"""自定义大背景图（第 43 轮）—— 用户可以用自己的图当整个前端的底纹。

用户原话（一字不改）：
  「以及**整个大背景要弄成可以自己上传图片的**，现在这样太丑了」
  「**我说的大背景是这整个前端**」

设计（为什么这么做，逐条）：
1. **只加一层，不动现有的四层纸纹**（第 35 轮的波纹/竹影/纸纹照旧在上面）——
   用户图当**最底那一层**，等于"给他一张自己的纸"，而不是把装饰顶掉。
2. **两张口子：全局 + 单本**，跟全站已有的「这本书 / 所有书默认」两档一个口径
   （第 26/27 轮那套）。单本没传就落到全局，全局也没有 = 默认纸纹。
3. **存文件、不存 base64**：图进 SQLite 会让库膨胀几十倍（备份/同步都跟着变慢），
   放 `data/appearance/` 下，每次上传**换名**（`bg-<时间戳>.<ext>`）+ 先删旧文件 ——
   前端拿 `?v=<更新时间>` 就能绕开缓存，不留垃圾文件。
4. **只认图片本体**（jpg/png/webp/gif），**按魔术字节判**，不看文件名后缀 ——
   后缀可以瞎写，SVG 更是能塞脚本的东西（当背景图用不着，一律不收）。
5. **大小上限 8MB**：手机拍的图压一压就在这个量级，再大传起来就是干等。
"""
from __future__ import annotations

import json
import os

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from .. import db as dbm
from ..security import current_user
from ..store import P, now_ms
from .config_models import _setting_get, _setting_set

router = APIRouter(tags=["appearance"])

# 铺法三种：铺满（cover）/ 平铺（tile）/ 居中（contain）
MODES = ("cover", "tile", "center")
MAX_BYTES = 8 * 1024 * 1024
# 魔术字节 → 扩展名与 Content-Type（不看文件名，看内容）
MAGIC = (
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
)


def _dir():
    d = P.data / "appearance"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _scope_of(scope: str, slug: str) -> tuple[str, str]:
    """把 (scope, slug) 归一成 (设置键后缀, 文件名前缀)。

    规矩：`scope=book` 必须带 slug（不然"这本书"是谁都不知道，宁可报错也别瞎猜）；
    别的值一律当全局 —— 前端只发这两个值，容错方式跟全站其它接口一致。
    """
    s = (scope or "global").strip().lower()
    if s == "book":
        slug = (slug or "").strip()
        if not slug:
            raise HTTPException(400, "选「这本书」的时候要带上书名说哪一本")
        if "/" in slug or "\\" in slug or slug.startswith("."):
            raise HTTPException(400, "书名不合法")
        return "book:" + slug, "book-" + slug
    return "global", "global"


def _kind(data: bytes) -> tuple[str, str] | None:
    for head, ext, ct in MAGIC:
        if data.startswith(head):
            return ext, ct
    # WEBP：RIFF....WEBP
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


def _one(key: str) -> dict:
    """读一条背景设置。返回 {has, mode, updatedAt, file}（没设过就是空壳）。"""
    raw = _setting_get("appearance.bg." + key)
    doc = {}
    if raw:
        try:
            doc = json.loads(raw) if raw.strip().startswith("{") else {}
        except Exception:
            doc = {}
    f = str(doc.get("file") or "")
    path = (_dir() / f) if f else None
    has = bool(path and path.exists())
    return {
        "has": has,
        "file": f if has else "",
        "mode": str(doc.get("mode") or "cover").lower() if str(doc.get("mode") or "").lower() in MODES else "cover",
        "updatedAt": int(doc.get("at") or 0),
    }


def _sweep(prefix: str, keep: str = "") -> int:
    """把这一档**旧**的图删掉，只留 keep 这一个文件名。

    ⚠ 第 43 轮踩到的真 bug（用户报「换背景图没办法好好换」的根因）：
       原来写的是 `d.glob(prefix + ".*")`，而落盘名是 `f"{prefix}-{now_ms()}{ext}"`
       （`global-1789964022862.jpg`）—— 模式 `global.*` 里的 `.` 是字面量，
       **一个都匹配不到**，于是"换一张"永远留着旧图、"移除"也清不掉，
       目录里堆了 9 张（监督人实测到 3 张残留就是这个）。
       实测对照：`glob('global.*')` → 0 个；`glob('global-*')` → 9 个。
    现在按 `prefix-*` 匹配（真实命名），并且**额外**认一下 keep 之外的同名残留。
    """
    # 反证开关（`APPEARANCE_FORCE=stale`）：把"不删旧文件"那个 bug 人为放回来，
    # 用来证明 甲7 / 丙0b 那两条判据不是空的（放回来必须报红）。
    if os.environ.get("APPEARANCE_FORCE") == "stale":
        return 0
    d = _dir()
    n = 0
    for old in list(d.glob(prefix + "-*")) + list(d.glob(prefix + ".*")):
        if keep and old.name == keep:
            continue
        try:
            old.unlink()
            n += 1
        except OSError:
            pass
    return n


@router.get("/appearance/bg")
async def bg_get(request: Request, slug: str = ""):
    """这一屏要用哪张图：全局的、这本书的、以及"最后生效的是哪张"。"""
    current_user(request)
    g = _one("global")
    b = _one("book:" + slug) if (slug or "").strip() else {"has": False, "file": "", "mode": "cover", "updatedAt": 0}
    eff = b if b["has"] else g
    return {"global": g, "book": b, "effective": {"scope": "book" if b["has"] else "global", **eff},
            "modes": list(MODES)}


@router.post("/appearance/bg")
async def bg_put(request: Request, file: UploadFile = File(...),
                 scope: str = Form("global"), slug: str = Form(""), mode: str = Form("cover")):
    """上传/更换。**先校验再落盘**：格式不对、太大、空文件都在动盘之前挡掉。"""
    current_user(request)
    key, prefix = _scope_of(scope, slug)
    data = await file.read()
    if not data:
        raise HTTPException(400, "收到的文件是空的，换一张试试")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "图太大（超过 8MB），先压一压再传")
    kind = _kind(data)
    if not kind:
        raise HTTPException(415, "这不是一张图（只认 jpg / png / webp / gif）")
    ext, ct = kind
    m = str(mode or "cover").lower()
    if m not in MODES:
        m = "cover"
    d = _dir()
    name = f"{prefix}-{now_ms()}{ext}"
    (d / name).write_bytes(data)
    # 落盘之后再扫旧的（keep=新文件），顺序反过来就不会把刚写的删掉
    _sweep(prefix, keep=name)
    at = now_ms()
    _setting_set("appearance.bg." + key, json.dumps({"file": name, "mode": m, "at": at}, ensure_ascii=False))
    return {"ok": True, "contentType": ct, "bytes": len(data), "scope": "book" if key.startswith("book:") else "global", **bg_of(scope, slug)}


def bg_of(scope: str, slug: str) -> dict:
    key, _ = _scope_of(scope, slug)
    return {"saved": _one(key), "global": _one("global")}


@router.post("/appearance/bg/mode")
async def bg_mode(request: Request, payload: dict = Body(default={})):
    """只改铺法，不用重传图。"""
    current_user(request)
    p = payload or {}
    key, _ = _scope_of(str(p.get("scope") or "global"), str(p.get("slug") or ""))
    m = str(p.get("mode") or "").lower()
    if m not in MODES:
        raise HTTPException(400, "铺法只有这三种：铺满 / 平铺 / 居中")
    cur = _one(key)
    if not cur["has"]:
        raise HTTPException(404, "这一档还没有图，先传一张")
    _setting_set("appearance.bg." + key,
                 json.dumps({"file": cur["file"], "mode": m, "at": cur["updatedAt"]}, ensure_ascii=False))
    return {"ok": True, "mode": m}


@router.delete("/appearance/bg")
async def bg_del(request: Request, scope: str = "global", slug: str = ""):
    """移除：连文件一起清掉（不然 `data/appearance/` 会越堆越多）。"""
    current_user(request)
    key, prefix = _scope_of(scope, slug)
    cur = _one(key)
    _sweep(prefix)
    _setting_set("appearance.bg." + key, json.dumps({"file": "", "mode": cur["mode"], "at": now_ms()}))
    return {"ok": True, "removed": bool(cur["has"])}


@router.get("/appearance/bg/file")
async def bg_file(request: Request, scope: str = "global", slug: str = ""):
    """把图发出去。**地址要能塞进 CSS**，所以口令只能挂在 URL 上（`media()` 会带）。"""
    current_user(request)
    key, _ = _scope_of(scope, slug)
    one = _one(key)
    if not one["has"]:
        # 单本没传 → 落回全局（前端一般不会走到这儿，但直接贴链接的人会）
        one = _one("global")
        if not one["has"]:
            raise HTTPException(404, "还没有自定义背景图")
    p = _dir() / one["file"]
    ext = p.suffix.lower()
    ct = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")
    return FileResponse(str(p), media_type=ct,
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})
