# -*- coding: utf-8 -*-
"""CosyVoice 引擎（可选，音色可克隆）。

CosyVoice 需要本机或局域网里有一个在跑的推理服务（它自己不提供 HTTP 服务，
所以我们按最常见的两种部署都支持）：
  A. 兼容 `text2speech` 的一步式 HTTP 接口：POST {base}/inference_sft
  B. 兼容 OpenAI `/v1/audio/speech` 的封装服务

配置写进 `server/config.json`：
    "tts_engine": "cosyvoice",
    "cosyvoice": { "base_url": "http://127.0.0.1:50000", "api": "cosyvoice",
                   "prompt_wav": "", "speed": 1.0 }
没配 / 连不上时给出**明确中文原因**，不静默失败。
"""
from __future__ import annotations

import json

import httpx

from .base import Engine, rate_to_speed, register


class CosyVoiceEngine(Engine):
    key = "cosyvoice"
    label = "CosyVoice（可克隆音色，需要本机推理服务）"

    def _cfg(self) -> dict:
        from ..config import CFG
        return dict(CFG.get("cosyvoice") or {})

    def available(self) -> tuple[bool, str]:
        c = self._cfg()
        if not c.get("base_url"):
            return False, "还没配 CosyVoice 服务地址（server/config.json 里的 cosyvoice.base_url）"
        return True, ""

    async def synth(self, text: str, voice: str, rate: str) -> bytes:
        c = self._cfg()
        base = str(c.get("base_url") or "").rstrip("/")
        if not base:
            raise RuntimeError("还没配 CosyVoice 服务地址")
        api = c.get("api") or "cosyvoice"
        text = (text or "").strip()
        if not text:
            raise ValueError("这一段没有可读的文字")
        speed = rate_to_speed(rate) * float(c.get("speed") or 1.0)
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=5.0)) as cli:
                if api == "openai":
                    r = await cli.post(base + "/v1/audio/speech", json={
                        "model": c.get("model") or "cosyvoice",
                        "input": text, "voice": voice or c.get("voice") or "default",
                        "speed": speed, "response_format": "mp3",
                    })
                else:
                    payload = {"tts_text": text, "spk_id": voice or c.get("spk_id") or "中文女"}
                    if c.get("prompt_wav"):
                        payload["prompt_wav"] = c["prompt_wav"]
                    r = await cli.post(base + "/inference_sft", data=payload)
                if r.status_code >= 400:
                    raise RuntimeError(f"CosyVoice 返回 {r.status_code}：{r.text[:120]}")
                if not r.content:
                    raise RuntimeError("CosyVoice 没返回音频（是不是模型还没加载完？）")
                return r.content
        except httpx.HTTPError as e:
            raise RuntimeError(f"连不上 CosyVoice（{base}）：{e.__class__.__name__}")


register(CosyVoiceEngine())
