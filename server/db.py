# -*- coding: utf-8 -*-
"""SQLite 访问层：连接管理 + 迁移执行 + 一组顺手的小函数。

为什么不用 ORM：表不多、SQL 不长，ORM 的抽象在这里只增加调试成本（见 docs/决策记录 D2）。
写入串行化（一把锁），读取走线程本地连接 —— WAL 下读写不互相阻塞。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._local = threading.local()
        self._write_lock = threading.RLock()
        self._init_schema()

    # ── 连接 ────────────────────────────────────────────────────────────
    def _conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(str(self.path), timeout=15.0, isolation_level=None)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("PRAGMA busy_timeout=15000")
            self._local.conn = c
        return c

    # ── 迁移 ────────────────────────────────────────────────────────────
    def _init_schema(self) -> None:
        c = self._conn()
        c.execute("CREATE TABLE IF NOT EXISTS schema_migration("
                  "name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
        done = {r["name"] for r in c.execute("SELECT name FROM schema_migration")}
        for f in sorted(MIGRATIONS.glob("*.sql")):
            if f.name in done:
                continue
            sql = f.read_text("utf-8")
            with self._write_lock:
                # 注意：sqlite3 的 executescript() 自己会先提交一次事务，
                # 所以这里**不能再套** BEGIN/COMMIT（会报 "cannot rollback"）。
                # 迁移脚本全部写成幂等的（IF NOT EXISTS），中途失败重跑也不会有半截状态。
                try:
                    c.executescript(sql)
                except Exception as e:
                    raise RuntimeError(f"迁移 {f.name} 执行失败：{e}") from e
                c.execute("INSERT INTO schema_migration(name, applied_at) VALUES(?,?)",
                          (f.name, now_ms()))

    # ── 查询 ────────────────────────────────────────────────────────────
    def query(self, sql: str, params=()) -> list[dict]:
        cur = self._conn().execute(sql, params)
        return [dict(r) for r in cur.fetchall()]

    def one(self, sql: str, params=()) -> dict | None:
        cur = self._conn().execute(sql, params)
        r = cur.fetchone()
        return dict(r) if r else None

    def scalar(self, sql: str, params=(), default=None):
        r = self._conn().execute(sql, params).fetchone()
        return r[0] if r and r[0] is not None else default

    def execute(self, sql: str, params=()) -> int:
        with self._write_lock:
            cur = self._conn().execute(sql, params)
            return cur.lastrowid if cur.lastrowid is not None else cur.rowcount

    def rowcount(self, sql: str, params=()) -> int:
        """执行一条改/删语句，返回**真正受影响的行数**。

        为什么不用 `execute()`：sqlite3 的 `cursor.lastrowid` 在 UPDATE 之后给的是
        **上一次 INSERT 留下的 rowid**（不是 0），拿它当「改了几行」会莫名其妙地判成真
        —— 「任务不在暂停中也照样回 200」就是这么来的（自测抓到的）。
        """
        with self._write_lock:
            return self._conn().execute(sql, params).rowcount

    def executemany(self, sql: str, seq) -> None:
        with self._write_lock:
            self._conn().executemany(sql, seq)

    def tx(self):
        """事务上下文（写操作一律走它，避免写到一半断电留下半条数据）。"""
        return _Tx(self)

    # ── 便捷：JSON 字段 ─────────────────────────────────────────────────
    @staticmethod
    def jloads(s, default=None):
        if not s:
            return default if default is not None else {}
        try:
            return json.loads(s)
        except Exception:
            return default if default is not None else {}

    @staticmethod
    def jdumps(v) -> str:
        return json.dumps(v, ensure_ascii=False)


class _Tx:
    def __init__(self, db: Database):
        self.db = db

    def __enter__(self):
        self.db._write_lock.acquire()
        self.conn = self.db._conn()
        self.conn.execute("BEGIN")
        return self.conn

    def __exit__(self, et, ev, tb):
        try:
            if et is None:
                self.conn.execute("COMMIT")
            else:
                self.conn.execute("ROLLBACK")
        finally:
            self.db._write_lock.release()
        return False


_db: Database | None = None


def init(path: Path) -> Database:
    global _db
    _db = Database(path)
    return _db


def db() -> Database:
    assert _db is not None, "db.init() 没被调用"
    return _db
