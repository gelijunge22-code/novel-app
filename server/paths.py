# -*- coding: utf-8 -*-
"""路径解析：整个后端只有这一处知道文件该放哪。

规矩（docs/设计方案 §2）：数据全在 `data/` 下，程序全在 `server/` 下，
把 `data/books/<slug>/` 拷走就等于把这本书带走。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent


class Paths:
    def __init__(self, cfg):
        self.repo = REPO_ROOT
        self.server = SERVER_DIR
        self.data = self._abs(cfg.get("data_root", "data"))
        self.logs = self._abs(cfg.get("log_dir", "logs"))
        self.frontend = self._abs(cfg.get("frontend_dir", "frontend"))
        self.apk = self._abs(cfg.get("apk_dir", "apk"))
        self.books = self.data / "books"
        self.backups = self.data / "backups"
        self.cache = self.data / "cache"
        self.uploads = self.data / "uploads"
        self.trash = self.data / "trash"
        self.db = self.data / "app.db"
        for d in (self.data, self.books, self.backups, self.cache, self.uploads,
                  self.trash, self.logs):
            d.mkdir(parents=True, exist_ok=True)

    def _abs(self, p: str) -> Path:
        q = Path(p)
        return q if q.is_absolute() else (REPO_ROOT / q).resolve()


# ── slug / 路径安全 ────────────────────────────────────────────────────────
_SLUG_BAD = re.compile(r"[^\w\u4e00-\u9fa5.-]+")


def slugify(title: str) -> str:
    """书名 → 目录名。中文保留（用户看得到目录名才安心），空格换横杠。"""
    s = (title or "").strip().lower()
    s = s.replace(" ", "-").replace("　", "-")
    s = _SLUG_BAD.sub("-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-.")
    return s or "book"


def safe_slug(slug: str) -> str | None:
    """作品标识必须是单个干净目录名，防目录穿越。

    打磨：**非文字一律当没给**。以前 `slug=["数组"]` 会一路走到 `.strip()`
    变成 HTTP 500（`'list' object has no attribute 'strip'`）—— 用户的错填不该是"服务器内部错误"。
    """
    if not isinstance(slug, str):
        return None
    s = slug.strip()
    if not s or len(s) > 120:
        return None
    if s in (".", "..") or "/" in s or "\\" in s or "\x00" in s:
        return None
    if s.startswith("."):
        return None
    return s


def safe_rel(path: str) -> str | None:
    """书内相对路径：不许绝对路径、不许 ..、不许空段。非文字一律当没给（同 safe_slug）。"""
    if not isinstance(path, str):
        return None
    p = path.strip().replace("\\", "/")
    if not p or p.startswith("/") or "\x00" in p:
        return None
    parts = [x for x in p.split("/") if x not in ("", ".")]
    if any(x == ".." for x in parts) or not parts:
        return None
    if len(p) > 400:
        return None
    return "/".join(parts)
