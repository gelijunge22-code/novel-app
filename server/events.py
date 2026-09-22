# -*- coding: utf-8 -*-
"""会话事件总线：SSE 广播 + 落库 + 断线按 seq 回放。

为什么落库：手机上切后台、切网、锁屏都会断流。断了之后前端拿 `after=<最后收到的 seq>`
重连，就能把漏掉的事件补齐 —— 不会出现"AI 说了半句话就不动了"。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import AsyncIterator

from . import db as dbm


def new_epoch() -> str:
    return uuid.uuid4().hex


class Bus:
    def __init__(self) -> None:
        self._subs: dict[int, set[asyncio.Queue]] = {}

    def subscribe(self, session_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.setdefault(session_id, set()).add(q)
        return q

    def unsubscribe(self, session_id: int, q: asyncio.Queue) -> None:
        self._subs.get(session_id, set()).discard(q)

    def push(self, session_id: int, payload: dict) -> None:
        for q in list(self._subs.get(session_id, ())):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass


class SessionGone(RuntimeError):
    """这个会话已经不在了（用户把对话删了）。

    打磨抓到的真 bug：会话删掉之后，编排还在跑 —— 它每写一条 entry / 每发一个事件
    都撞 `sqlite3.IntegrityError: FOREIGN KEY constraint failed`（chat_entry.session_id 指向
    已经删掉的会话）。更糟的是**出错处理本身也在写 entry**，于是异常一层套一层，
    日志里一次运行能刷出几十行 traceback，真正的错因反而被埋了。
    现在：写不进去就抛这个，编排那边catch住安静收尾。
    """


BUS = Bus()


def session_alive(session_id: int) -> bool:
    """会话还在不在（写事件/写 entry 前用它判断"该不该安静收尾"）。"""
    try:
        return bool(dbm.db().scalar("SELECT 1 FROM chat_session WHERE id=?", (session_id,)))
    except Exception:
        return True                     # 查不了就别拦（宁可写失败也不误杀正常流程）


def emit(session_id: int, kind: str, event: dict, *, invocation_id: str = "",
         epoch: str = "") -> dict:
    """写一条事件：先落库拿到 seq，再广播（前端靠 seq 去重）。"""
    d = dbm.db()
    seq = (d.scalar("SELECT MAX(seq) FROM chat_event WHERE session_id=?", (session_id,)) or 0) + 1
    if not epoch:
        epoch = d.scalar("SELECT epoch FROM chat_event WHERE session_id=? AND epoch!=''"
                         " ORDER BY seq DESC LIMIT 1", (session_id,)) or new_epoch()
    payload = {"seq": seq, "sessionId": session_id, "invocationId": invocation_id,
               "eventEpoch": epoch, "kind": kind, "event": event}
    try:
        d.execute("INSERT INTO chat_event(session_id,seq,epoch,kind,payload_json,created_at)"
                  " VALUES(?,?,?,?,?,?)",
                  (session_id, seq, epoch, kind, json.dumps(payload, ensure_ascii=False),
                   dbm.now_ms()))
    except Exception as e:
        if not session_alive(session_id):
            raise SessionGone(f"会话 {session_id} 已经被删掉，事件不再写入") from e
        raise
    BUS.push(session_id, payload)
    return payload


def backlog(session_id: int, after: int) -> list[dict]:
    rows = dbm.db().query(
        "SELECT payload_json FROM chat_event WHERE session_id=? AND seq>? ORDER BY seq",
        (session_id, int(after or 0)))
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["payload_json"]))
        except Exception:
            continue
    return out


def trim(session_id: int, keep: int = 2000) -> None:
    dbm.db().execute(
        "DELETE FROM chat_event WHERE session_id=? AND seq <= "
        "(SELECT MAX(seq) FROM chat_event WHERE session_id=?) - ?",
        (session_id, session_id, keep))


async def sse(session_id: int, after: int) -> AsyncIterator[bytes]:
    """SSE 生成器：先补历史，再实时推；每 15 秒一个心跳包防中间层掐连接。"""
    q = BUS.subscribe(session_id)
    try:
        for ev in backlog(session_id, after):
            yield _fmt("message", ev)
        yield _fmt("connected", {"event": {"type": "connected"}})
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=15.0)
                yield _fmt(ev.get("kind") or "message", ev)
            except asyncio.TimeoutError:
                yield b": ping\n\n"
    finally:
        BUS.unsubscribe(session_id, q)


def _fmt(name: str, payload: dict) -> bytes:
    return (f"event: {name}\ndata: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode()
