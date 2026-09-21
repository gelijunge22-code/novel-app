-- ============================================================================
-- 0001_init —— 全部基础表（设计见 docs/设计方案.md §3）
-- 约定：时间戳是毫秒整数；JSON 字段一律 *_json；书内表都带 slug 做按书隔离。
-- ============================================================================

-- ── 账号与会话 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  display_name   TEXT    NOT NULL DEFAULT '',
  password_hash  TEXT    NOT NULL,
  salt           TEXT    NOT NULL,
  role           TEXT    NOT NULL DEFAULT 'admin',      -- admin | user
  status         TEXT    NOT NULL DEFAULT 'active',     -- active | banned
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  last_seen_at   INTEGER
);

CREATE TABLE IF NOT EXISTS session_token (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ua_hash      TEXT NOT NULL DEFAULT '',
  last_used_at INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_session_user ON session_token(user_id);

-- ── 全局配置 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS setting (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── 模型渠道 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  grp         TEXT NOT NULL DEFAULT '',
  model_api   TEXT NOT NULL DEFAULT 'openai-completions',
  base_url    TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  options_json TEXT NOT NULL DEFAULT '{}',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_model (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id    INTEGER NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  model_id       TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  grp            TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  reasoning      INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  max_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_json      TEXT NOT NULL DEFAULT '{}',
  updated_at     INTEGER NOT NULL,
  UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS model_set (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_set_member (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id       INTEGER NOT NULL REFERENCES model_set(id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL DEFAULT 'writer',   -- planner | writer | polish | fast | embed
  provider_id  INTEGER NOT NULL,
  model_id     TEXT NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- ── 提示词与片段 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompt (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  purpose    TEXT NOT NULL DEFAULT 'writer',
  body       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_version (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_key TEXT NOT NULL,
  version    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_promptver_key ON prompt_version(prompt_key, version);

CREATE TABLE IF NOT EXISTS snippet (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- ── 预设（类酒馆：全局默认 + 单书覆盖） ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS preset (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL DEFAULT 'global',   -- global | book
  slug        TEXT NOT NULL DEFAULT '',         -- scope=book 时有效
  profile_key TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}',
  model_json  TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL,
  UNIQUE(scope, slug, profile_key)
);

-- ── 任务 / 账本 / 审计 / 通知 / 备份 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  slug         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|canceled
  progress     INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json  TEXT NOT NULL DEFAULT '{}',
  error        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_job_status ON job(status, updated_at);

CREATE TABLE IF NOT EXISTS trace (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL DEFAULT '',
  invocation_id TEXT NOT NULL DEFAULT '',
  slug          TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'turn',
  stop_reason   TEXT NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  ttft_ms       INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  cost_json     TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trace_created ON trace(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_trace_slug ON trace(slug, created_at DESC);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  slug        TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit(at DESC);

CREATE TABLE IF NOT EXISTS notification (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  slug       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);

CREATE TABLE IF NOT EXISTS backup (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- ── 书 ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS book (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'novel',
  summary     TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  cover       TEXT NOT NULL DEFAULT '',        -- .novel/ 下的相对文件名
  status      TEXT NOT NULL DEFAULT 'writing', -- writing | paused | done
  target_words INTEGER NOT NULL DEFAULT 0,
  word_count  INTEGER NOT NULL DEFAULT 0,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  settings_json TEXT NOT NULL DEFAULT '{}',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS act (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  label_ids_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(slug, number)
);

CREATE TABLE IF NOT EXISTS chapter (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  path       TEXT NOT NULL,
  act_number INTEGER NOT NULL DEFAULT 1,
  order_no   INTEGER NOT NULL DEFAULT 0,
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft',
  words      INTEGER NOT NULL DEFAULT 0,
  target_words INTEGER NOT NULL DEFAULT 0,
  pov        TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  info_control_json TEXT NOT NULL DEFAULT '{}',
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(slug, path)
);
CREATE INDEX IF NOT EXISTS ix_chapter_slug ON chapter(slug, order_no);

CREATE TABLE IF NOT EXISTS scene (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL,
  chapter_path  TEXT NOT NULL,
  order_no      INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  world_moment_id INTEGER,
  location_id   INTEGER,
  cast_json     TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'outline',
  label_ids_json TEXT NOT NULL DEFAULT '[]',
  words         INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_scene_chapter ON scene(slug, chapter_path, order_no);

CREATE TABLE IF NOT EXISTS outline (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  chapter_path TEXT NOT NULL DEFAULT '',
  level        TEXT NOT NULL DEFAULT 'chapter',  -- act | chapter | detail
  body         TEXT NOT NULL DEFAULT '',
  approved     INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_outline_slug ON outline(slug, chapter_path);

CREATE TABLE IF NOT EXISTS chapter_version (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  path         TEXT NOT NULL,
  rev          INTEGER NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT '',
  origin       TEXT NOT NULL DEFAULT 'user',    -- user | model | import
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  UNIQUE(slug, path, rev)
);

-- ── 世界引擎 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS moment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  order_no    INTEGER NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  time_text   TEXT NOT NULL DEFAULT '',
  calendar_json TEXT NOT NULL DEFAULT '{}',
  source_scene TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  UNIQUE(slug, order_no)
);

CREATE TABLE IF NOT EXISTS episode (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  moment_id   INTEGER,
  title       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  scene_path  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_episode_slug ON episode(slug, moment_id);

CREATE TABLE IF NOT EXISTS entity (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'character',
  name             TEXT NOT NULL,
  data_json        TEXT NOT NULL DEFAULT '{}',
  first_moment_id  INTEGER,
  first_seen_path  TEXT NOT NULL DEFAULT '',
  updated_at       INTEGER NOT NULL,
  UNIQUE(slug, kind, name)
);
CREATE INDEX IF NOT EXISTS ix_entity_slug ON entity(slug, kind);

CREATE TABLE IF NOT EXISTS entity_alias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL,
  entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,
  note      TEXT NOT NULL DEFAULT '',
  UNIQUE(slug, entity_id, alias)
);
CREATE INDEX IF NOT EXISTS ix_alias_slug ON entity_alias(slug, alias);

CREATE TABLE IF NOT EXISTS entity_relation (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL,
  from_id   INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  to_id     INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT '',
  strength  INTEGER NOT NULL DEFAULT 3,
  since_moment_id INTEGER,
  until_moment_id INTEGER,
  note      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rel_slug ON entity_relation(slug, from_id);

CREATE TABLE IF NOT EXISTS fact (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  entity_id  INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '',
  valid_from_moment_id INTEGER,
  valid_to_moment_id   INTEGER,
  source_path TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'stated',  -- stated | inferred | uncertain
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fact_entity ON fact(slug, entity_id, key);

CREATE TABLE IF NOT EXISTS fact_evidence (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  path    TEXT NOT NULL DEFAULT '',
  line    INTEGER NOT NULL DEFAULT 0,
  quote   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS arc (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL,
  entity_id INTEGER NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  goal      TEXT NOT NULL DEFAULT '',
  motive    TEXT NOT NULL DEFAULT '',
  turning_points_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  UNIQUE(slug, entity_id)
);

-- ── 剧情工坊 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS thread (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  slug      TEXT NOT NULL,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'main',
  status    TEXT NOT NULL DEFAULT 'open',
  summary   TEXT NOT NULL DEFAULT '',
  order_no  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(slug, name)
);

CREATE TABLE IF NOT EXISTS thread_scene (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  thread_id   INTEGER NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  scene_path  TEXT NOT NULL DEFAULT '',
  order_no    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promise (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'foreshadow',
  status       TEXT NOT NULL DEFAULT 'open',   -- open | advanced | paid | dropped
  setup_scene  TEXT NOT NULL DEFAULT '',
  payoff_scene TEXT NOT NULL DEFAULT '',
  due_chapter  TEXT NOT NULL DEFAULT '',
  advance_json TEXT NOT NULL DEFAULT '[]',
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(slug, name)
);
CREATE INDEX IF NOT EXISTS ix_promise_slug ON promise(slug, status);

CREATE TABLE IF NOT EXISTS decision (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  at           INTEGER NOT NULL,
  chapter_path TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',
  risks        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',  -- active | superseded
  superseded_by INTEGER
);
CREATE INDEX IF NOT EXISTS ix_decision_slug ON decision(slug, at DESC);

-- ── AI 会话 ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_session (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  identity      TEXT NOT NULL UNIQUE,
  slug          TEXT NOT NULL DEFAULT '',
  profile_key   TEXT NOT NULL DEFAULT 'leader.default',
  title         TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'idle',
  model_key     TEXT NOT NULL DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chat_session_slug ON chat_session(slug, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_entry (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,            -- user | assistant | tool_result | system
  blocks_json TEXT NOT NULL DEFAULT '[]',
  usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS chat_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  epoch        TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS attachment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'file',
  name       TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ── 记忆 / 检索 ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  view_text   TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  source_path TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE(slug, subject, topic)
);
CREATE INDEX IF NOT EXISTS ix_memory_slug ON memory(slug, subject);

CREATE TABLE IF NOT EXISTS memory_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  tick        TEXT NOT NULL DEFAULT '',
  time_text   TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_memevent_slug ON memory_event(slug, subject);

CREATE TABLE IF NOT EXISTS rag_index (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  subject      TEXT NOT NULL DEFAULT '',
  source_path  TEXT NOT NULL DEFAULT '',
  search_text  TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  embedding_json TEXT NOT NULL DEFAULT '',
  model        TEXT NOT NULL DEFAULT '',
  dims         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  UNIQUE(slug, source_path, subject)
);

-- ── 术语 / 素材 / 统计 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS term (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  kind       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE(slug, name)
);

CREATE TABLE IF NOT EXISTS material (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  tags_json  TEXT NOT NULL DEFAULT '[]',
  path       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS writing_day (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL,
  date_key       TEXT NOT NULL,         -- YYYY-MM-DD（本地时区）
  net_words      INTEGER NOT NULL DEFAULT 0,
  ending_words   INTEGER NOT NULL DEFAULT 0,
  seconds        INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  UNIQUE(slug, date_key)
);

CREATE TABLE IF NOT EXISTS achievement (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  unlocked_at INTEGER,
  progress   INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(slug, key)
);

-- ── 改动历史 / 收件箱 ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revision (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  path        TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'write',   -- write | create | delete | rename | model
  actor       TEXT NOT NULL DEFAULT '',
  actor_kind  TEXT NOT NULL DEFAULT 'user',    -- user | model | agent | import
  before_text TEXT NOT NULL DEFAULT '',
  after_text  TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | reverted
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_revision_slug ON revision(slug, path, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_revision_status ON revision(slug, status);

-- ── 质检 / 书签 / 阅读进度 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lint_run (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  path       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  hits_json  TEXT NOT NULL DEFAULT '[]',
  stats_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_lint_slug ON lint_run(slug, created_at DESC);

CREATE TABLE IF NOT EXISTS bookmark (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  path       TEXT NOT NULL,
  percent    REAL NOT NULL DEFAULT 0,
  text       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_bookmark_slug ON bookmark(slug, created_at DESC);

CREATE TABLE IF NOT EXISTS reading_progress (
  slug       TEXT PRIMARY KEY,
  path       TEXT NOT NULL DEFAULT '',
  percent    REAL NOT NULL DEFAULT 0,
  extra_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
