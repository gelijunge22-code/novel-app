-- 提示词库要「全局默认 + 单书覆盖」，原来那张 prompt 表没有 scope/slug 这两列，
-- 而且从建表起就一直是空的（0 行），所以这里直接换掉，不去做半截的 ALTER。
-- 迁移脚本是幂等的：重跑也不会出现重复列/半截状态。
DROP TABLE IF EXISTS prompt;
DROP TABLE IF EXISTS prompt_version;
DROP TABLE IF EXISTS snippet;   -- 同样是空表：换成带 tags / use_count 的新形状

CREATE TABLE IF NOT EXISTS prompt (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL DEFAULT 'global',   -- global | book
  slug       TEXT NOT NULL DEFAULT '',         -- scope=book 时是哪本书
  key        TEXT NOT NULL,                    -- 对应 llm/prompts.py 的档案 key
  name       TEXT NOT NULL DEFAULT '',
  purpose    TEXT NOT NULL DEFAULT 'writer',
  body       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, slug, key)
);

CREATE TABLE IF NOT EXISTS prompt_version (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL DEFAULT 'global',
  slug       TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_version ON prompt_version(scope, slug, key, version DESC);

-- 片段（Snippet）：常用指令碎片，拼提示词时直接取用
CREATE TABLE IF NOT EXISTS snippet (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',
  use_count  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
