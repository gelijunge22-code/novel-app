-- ⑧ 对端同步（App ↔ 服务器）：手机里那份后端自己去跟服务器对账。
--
-- 背景（GOAL C2）：App 把整份后端装在手机里，所以"跟服务器同步"这件事必须由**手机上的后端**
-- 作为客户端去 push/pull，而不是前端去调服务器。这里记两样东西：
--   ① 每本书上次跟哪个服务器、同步到什么时候（增量起点）；
--   ② 每条推上去的结果（审计：什么时候推的、成没成、冲突没冲突）。
CREATE TABLE IF NOT EXISTS peer_state (
  slug        TEXT PRIMARY KEY,
  base_url    TEXT NOT NULL DEFAULT '',   -- 服务器地址，例如 http://192.168.1.9:8899
  last_time   INTEGER NOT NULL DEFAULT 0, -- 上次同步结束时的服务器时间（增量起点）
  last_sync   INTEGER NOT NULL DEFAULT 0,
  last_result TEXT NOT NULL DEFAULT ''    -- 一句话摘要，界面上直接显示
);

CREATE TABLE IF NOT EXISTS peer_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  base_url   TEXT NOT NULL DEFAULT '',
  direction  TEXT NOT NULL,               -- pull | push
  path       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL,               -- ok | unchanged | conflict | skipped | error
  detail     TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_peer_log ON peer_log(slug, at DESC);
