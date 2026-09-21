# -*- coding: utf-8 -*-
"""探针：直接走我们自己的模型客户端（server/llm/providers.py）问一句话，把过程打出来。

为什么要有它：用户报的"AI 出不了字"发生在**模型层→界面**这条链上。
这个探针把链子最里面那一段（渠道/API/分片）单独量一遍，
再配合界面判据（tools/e2e-chatstream.js），出错时一眼看出是哪一段的锅。

用法：
  server/venv/bin/python tools/probe_llm.py                     # 用当前默认模型
  server/venv/bin/python tools/probe_llm.py "渠道-shim/xxx"    # 指定 model_key
  server/venv/bin/python tools/probe_llm.py --api completions   # 强改渠道 API 再试（查"渠道声明错没"）
"""
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server import db as dbm                      # noqa: E402
from server.llm.providers import provider_of, stream_chat   # noqa: E402

from server.store import P                           # noqa: E402

dbm.init(P.db)                               # 探针自己起库，不依赖服务进程

PROMPT = "请只回一句话：今天天气不错。"


async def main() -> int:
    args = [a for a in sys.argv[1:]]
    force_api = ""
    if "--api" in args:
        i = args.index("--api")
        force_api = args[i + 1] if len(args) > i + 1 else ""
        del args[i:i + 2]
    mk = args[0] if args else ""
    if not mk:
        row = dbm.db().one("SELECT model_key FROM chat_session WHERE model_key!='' "
                           "ORDER BY updated_at DESC LIMIT 1")
        mk = (row or {}).get("model_key") or ""
    if not mk:
        print("没有可用的 model_key（也没传参）")
        return 2
    provider, mid = provider_of(mk)
    provider = dict(provider)
    if force_api:
        provider["model_api"] = force_api
    print(f"渠道={provider['name']} api={provider['model_api']} base={provider['base_url']}")
    print(f"模型={mid}")
    t0 = time.time()
    deltas, errs, ttft = [], [], 0
    async for ev in stream_chat(provider, mid, [{"role": "user", "content": PROMPT}],
                                system="你是助手，回答要短。", temperature=0.3):
        if ev["type"] == "delta":
            if not ttft:
                ttft = int((time.time() - t0) * 1000)
            deltas.append(ev["delta"])
        elif ev["type"] == "error":
            errs.append(ev["error"])
        elif ev["type"] == "usage":
            print("usage", json.dumps(ev["usage"], ensure_ascii=False))
        elif ev["type"] == "done":
            print("done", json.dumps({k: v for k, v in ev.items() if k != "type"}, ensure_ascii=False))
    text = "".join(deltas)
    dt = int((time.time() - t0) * 1000)
    print(f"\n分片={len(deltas)} 首字={ttft}ms 总耗时={dt}ms 字数={len(text)}")
    print("正文：" + (text[:200] if text else "（空）"))
    for e in errs:
        print("错误：" + e)
    ok = bool(text.strip()) and not errs
    print("\n结论：" + ("✅ 出字了" if ok else "❌ 没出字（这就是用户看到的现象）"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
