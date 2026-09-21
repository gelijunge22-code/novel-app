-- 第 16 轮：三个新功能要落的地方。
--   ① 故事线：每章一句"这章发生了什么"（用户能自己改，也能让 AI 写）
--   ② 小批注：看正文时给自己留的待办 —— **不进正文**，所以必须单独一张表（放正文里就污染稿子了）
--   ③ 常用指令：写正文那排一键指令，按书存
-- 说明：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，所以迁移脚本必须只跑一次（本项目的迁移表保证这点）。
--       中途失败重跑会卡在 duplicate column —— 所以这里一次只加一列，失败了肉眼能看出来。

ALTER TABLE chapter_meta ADD COLUMN summary TEXT NOT NULL DEFAULT '';   -- 这一章的一句话（故事线用）

CREATE TABLE IF NOT EXISTS margin_note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  path       TEXT NOT NULL,               -- 挂在哪一章
  quote      TEXT NOT NULL DEFAULT '',    -- 正文里那一小段的原文（用来认位置 + 显示）
  note       TEXT NOT NULL DEFAULT '',    -- 我自己写的那句话
  at_ms      INTEGER NOT NULL DEFAULT 0,  -- 大概在这一章的哪个位置（排序 / 跳转用）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_margin_note ON margin_note(slug, path, at_ms);

CREATE TABLE IF NOT EXISTS quick_cmd (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  text       TEXT NOT NULL,
  order_no   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_quick_cmd ON quick_cmd(slug, order_no);
