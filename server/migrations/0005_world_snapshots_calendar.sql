-- 世界引擎做「真事件溯源」需要三样此前没有的东西：
--   ① 切面（snapshot）—— 不然每次问"第 30 章时他是什么状态"都要从头重放全书事实；
--   ② 自定义历法 —— 架空世界（"开元 1024 年 3 月 15 日"）与公元前都要能换算成**绝对序号**排序；
--   ③ 时刻上的绝对序号 —— 挂在 moment 上，但**不 ALTER TABLE**（SQLite 的 ADD COLUMN
--      没有 IF NOT EXISTS，中途失败重跑会卡在 duplicate column，见 0004 的教训）。
--
-- 另外把 rag_index 里三个**从来没写过、也没人读**的死字段（embedding_json / model / dims）去掉：
-- 留着一个填不上的向量列，就是在骗下一个读代码的人（"语义检索"因此实现为本地词法检索，
-- 见 engine/memory.py 的 _index / search，不需要向量列）。

CREATE TABLE IF NOT EXISTS world_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  cutoff_order  INTEGER NOT NULL,          -- 算到哪个时刻（含）为止
  state_json    TEXT NOT NULL DEFAULT '{}',-- 这个切面上的状态（key→value，已算好）
  hist_json     TEXT NOT NULL DEFAULT '{}',-- 每个属性的状态栈（带出处），"值结束了要退回上一个"就靠它
  fact_ids_json TEXT NOT NULL DEFAULT '[]',-- 参与计算的事实 id（按先后）
  base_id       INTEGER,                   -- 由哪个切面推算来的（NULL = 从零重放）
  fact_count    INTEGER NOT NULL DEFAULT 0,-- 累计吃进多少条事实（用来决定要不要再切一刀）
  created_at    INTEGER NOT NULL,
  UNIQUE(slug, entity_id, cutoff_order)
);

CREATE TABLE IF NOT EXISTS calendar (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  def_json   TEXT NOT NULL DEFAULT '{}',
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(slug, name)
);

-- 时刻 ↔ 绝对序号（第几天）。abs_day 是整数，可为负 —— 公元前就是负数。
CREATE TABLE IF NOT EXISTS moment_abs (
  slug        TEXT NOT NULL,
  moment_id   INTEGER NOT NULL,
  abs_day     INTEGER NOT NULL,
  calendar_id INTEGER,
  time_text   TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, moment_id)
);
CREATE INDEX IF NOT EXISTS ix_moment_abs ON moment_abs(slug, abs_day);

-- rag_index 去掉死字段：老表照抄一遍、换名，保证幂等（重跑时 rag_index_v2 已不存在，
-- 会重新建空表再抄一次，列名对得上，不丢索引）。
CREATE TABLE IF NOT EXISTS rag_index_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  source_path  TEXT NOT NULL DEFAULT '',
  search_text  TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  updated_at   INTEGER NOT NULL,
  UNIQUE(slug, source_path, subject)
);
INSERT OR IGNORE INTO rag_index_v2(slug,subject,source_path,search_text,content_hash,updated_at)
  SELECT slug,subject,source_path,search_text,content_hash,updated_at FROM rag_index;
DROP TABLE IF EXISTS rag_index;
ALTER TABLE rag_index_v2 RENAME TO rag_index;
CREATE INDEX IF NOT EXISTS ix_rag_subject ON rag_index(slug, subject);
