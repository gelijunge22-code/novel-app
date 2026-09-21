-- 多 Agent 真分工：把"一句话"拆成一条**有角色、有交接、可见范围不同**的流水线。
--
-- 为什么落库：一次编排跑完，用户要能回头看"这一步是谁做的、它拿到了什么、它交出了什么"，
-- 而不是只看到一坨拼在一起的文本。断线重连也要能把这串角色步骤补回来。
--
-- 可见范围与写权限：每个角色的工具集不一样，且 writer 只能写 manuscript/（正文），
-- 设定/世界观（lorebook、world、预设）只有 leader 能改 —— 这一条在 engine/orchestra.py 里
-- 由 scope_allows() 强制，拒绝的尝试也落库（step.rejected_json），不是嘴上说说。

CREATE TABLE IF NOT EXISTS orchestra_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL DEFAULT '',
  session_id    INTEGER NOT NULL DEFAULT 0,
  invocation_id TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL DEFAULT 'execute',   -- discuss | plan | execute
  goal          TEXT NOT NULL DEFAULT '',
  target_path   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',   -- running | done | error | aborted
  wrote_json    TEXT NOT NULL DEFAULT '[]',
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_orch_run_session ON orchestra_run(session_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_orch_run_slug ON orchestra_run(slug, id DESC);

CREATE TABLE IF NOT EXISTS orchestra_step (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES orchestra_run(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,                      -- leader | retriever | researcher | writer | critic
  role_name    TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',           -- 这一步在干什么（排计划/取上下文/挑刺…）
  profile_key  TEXT NOT NULL DEFAULT '',
  sees_json    TEXT NOT NULL DEFAULT '[]',         -- 这一步看得见什么（范围声明，界面上也显示）
  tools_json   TEXT NOT NULL DEFAULT '[]',         -- 这一步能用的工具
  handoff_from TEXT NOT NULL DEFAULT '',           -- 上一棒是谁
  handoff_text TEXT NOT NULL DEFAULT '',           -- 上一棒交给它的东西（它实际读到的）
  output       TEXT NOT NULL DEFAULT '',
  calls_json   TEXT NOT NULL DEFAULT '[]',         -- 真跑过的工具调用
  rejected_json TEXT NOT NULL DEFAULT '[]',        -- 被权限挡下来的调用（可见范围的证据）
  wrote_json   TEXT NOT NULL DEFAULT '[]',
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'done',
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_orch_step_run ON orchestra_step(run_id, seq);
