-- 第三批：补三件此前只有"说法"没有"实现"的东西。
-- 全部写成幂等的（IF NOT EXISTS），重跑不会留半截状态。

-- ① 笔记：书签是「读到哪」，笔记是「想到了什么」。
--    单独一张表，不去动 bookmark（bookmark 里已有用户的阅读位置，绝不删改）。
CREATE TABLE IF NOT EXISTS note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  path       TEXT NOT NULL DEFAULT '',
  percent    REAL NOT NULL DEFAULT 0,
  quote      TEXT NOT NULL DEFAULT '',    -- 摘录的原文（可为空）
  text       TEXT NOT NULL DEFAULT '',    -- 自己写的话
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_note_slug ON note(slug, created_at DESC);

-- ② 工作流：把「写正文 → 润色 → 质检」打包成一条可复用命令。
CREATE TABLE IF NOT EXISTS workflow (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL DEFAULT '',    -- 空 = 全局可用
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  UNIQUE(slug, name)
);

-- ③ 同步冲突：手机离线改了、服务器也改了 —— 两份都留着，等用户挑。
CREATE TABLE IF NOT EXISTS sync_conflict (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  path         TEXT NOT NULL,
  base_mtime   INTEGER NOT NULL DEFAULT 0,
  local_mtime  INTEGER NOT NULL DEFAULT 0,
  server_mtime INTEGER NOT NULL DEFAULT 0,
  local_text   TEXT NOT NULL DEFAULT '',
  server_text  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',   -- open | local | server | merged
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_conflict_open ON sync_conflict(slug, status, created_at DESC);
