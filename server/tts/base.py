# -*- coding: utf-8 -*-
"""TTS 引擎接口。

换引擎只改这里（和 config.json 里的 `tts_engine`），路由层永远只认"段"。
见 docs/决策记录 D7。
"""
from __future__ import annotations

import re
from typing import Protocol

_RATE_RE = re.compile(r"^([+-])(\d{1,3})%$")


def norm_rate(v) -> str:
    """语速收口：`+25%` / `-10%` / `1.2`（倍数）都收，非法值退回正常语速，永不 500。"""
    s = str(v if v is not None else "").strip()
    if not s:
        return "+0%"
    try:
        n = float(s[:-1]) if s.endswith("%") else (float(s) - 1.0) * 100.0
    except ValueError:
        return "+0%"
    if n != n or n in (float("inf"), float("-inf")):
        return "+0%"
    n = max(-100.0, min(200.0, n))
    return f"{'+' if n >= 0 else '-'}{abs(n):.0f}%"


def rate_to_speed(rate: str) -> float:
    m = _RATE_RE.match(norm_rate(rate))
    if not m:
        return 1.0
    pct = int(m.group(2)) * (1 if m.group(1) == "+" else -1)
    return max(0.1, 1.0 + pct / 100.0)


class Engine(Protocol):
    key: str
    label: str

    def available(self) -> tuple[bool, str]:
        """能不能用；不能用就给一句中文原因（前端直接显示）。"""

    async def synth(self, text: str, voice: str, rate: str) -> bytes:
        """合成一段，返回 mp3 字节。"""


_ENGINES: dict[str, Engine] = {}


def register(e: Engine) -> None:
    _ENGINES[e.key] = e


def get_engine(key: str | None = None) -> Engine:
    from ..config import CFG
    k = (key or CFG.get("tts_engine") or "edge").strip()
    if k not in _ENGINES:
        raise KeyError(f"没有这个听书引擎：{k}（可用：{'、'.join(_ENGINES)}）")
    return _ENGINES[k]


def list_engines() -> list[dict]:
    out = []
    for k, e in _ENGINES.items():
        ok, why = e.available()
        out.append({"key": k, "label": e.label, "available": ok, "reason": why})
    return out
