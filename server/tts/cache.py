# -*- coding: utf-8 -*-
"""分段音频缓存：同一段（同书、同章、同音色、同语速、同序号、同字数）只合成一次。

落盘在 `data/cache/tts/`，可以直接删掉重置。
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from ..store import P

_DIR = P.cache / "tts"
_DIR.mkdir(parents=True, exist_ok=True)


def seg_path(slug: str, path: str, i: int, voice: str, rate: str, nchars: int,
             engine: str = "") -> Path:
    key = hashlib.sha1(
        f"{engine}|{slug}|{path}|{voice}|{rate}|{i}|{nchars}".encode("utf-8")).hexdigest()[:24]
    return _DIR / f"seg-{key}.mp3"


def whole_path(slug: str, path: str, voice: str, rate: str, engine: str = "") -> Path:
    key = hashlib.sha1(f"{engine}|{slug}|{path}|{voice}|{rate}".encode("utf-8")).hexdigest()[:24]
    return _DIR / f"full-{key}.mp3"


def write_atomic(dst: Path, data: bytes) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    tmp.write_bytes(data)
    os.replace(tmp, dst)


def size() -> dict:
    total = 0
    count = 0
    for f in _DIR.glob("*.mp3"):
        total += f.stat().st_size
        count += 1
    return {"files": count, "bytes": total, "dir": str(_DIR)}


def clear() -> dict:
    n = 0
    for f in _DIR.glob("*.mp3"):
        f.unlink()
        n += 1
    return {"ok": True, "removed": n}

def preview_path(voice: str, rate: str, text: str, engine: str = "") -> Path:
    """试听用的短音频缓存：同一句话 + 同音色 + 同语速只合成一次。

    试听是"点一下就要出声"的动作，不能每点一次都等一两秒重新合成
    （用户会把"没反应"当成坏了 —— 见 docs/03 A 节那次教训）。
    """
    key = hashlib.sha1(
        f"try|{engine}|{voice}|{rate}|{text}".encode("utf-8")).hexdigest()[:24]
    return _DIR / f"try-{key}.mp3"
