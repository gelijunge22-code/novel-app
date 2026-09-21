# -*- coding: utf-8 -*-
"""听书引擎。接口只有一句：给我文本、音色、语速，还我一段 mp3 字节。"""
from .base import Engine, get_engine, list_engines, register  # noqa: F401
# 引擎靠 import 自己注册。**必须在这里显式导入**：没人 import 就一个引擎都没有，
# 前端点「听书」会得到「没有这个听书引擎：edge（可用：）」。这个坑踩过一次。
from . import edge as _edge          # noqa: F401,E402
from . import cosyvoice as _cosy     # noqa: F401,E402
