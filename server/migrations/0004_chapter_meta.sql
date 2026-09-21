-- 15.2「每章可挂：目标字数、出场角色、关键事件、埋/收的伏笔」里，
-- 出场角色与关键事件此前没有落处（目标字数在 chapter 表、伏笔在 promise 表）。
--
-- 不用 ALTER TABLE 加列：SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，
-- 中途失败再跑就会卡在「duplicate column name」，反而更脆。
-- 单独一张按 (slug, path) 认人的侧表，建表幂等，删章时也不影响正文。
CREATE TABLE IF NOT EXISTS chapter_meta (
  slug        TEXT NOT NULL,
  path        TEXT NOT NULL,
  cast_json   TEXT NOT NULL DEFAULT '[]',   -- 出场角色（名字数组）
  events_json TEXT NOT NULL DEFAULT '[]',   -- 关键事件（一行一条）
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, path)
);
