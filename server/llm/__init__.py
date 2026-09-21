# -*- coding: utf-8 -*-
"""大模型接入：只做两件事 —— 把消息发出去、把流式增量收回来。"""
from .providers import LLMError, stream_chat, complete  # noqa: F401
