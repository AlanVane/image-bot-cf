-- D1 schema（DESIGN.md §7.1，两处需保持一致）

CREATE TABLE installations (
  installation_id INTEGER PRIMARY KEY,
  account_login   TEXT NOT NULL,
  account_type    TEXT,                  -- User | Organization
  plan_id         INTEGER,               -- P3 前恒 NULL
  created_at      TEXT NOT NULL
);

CREATE TABLE repos (
  installation_id     INTEGER NOT NULL,
  name                TEXT NOT NULL,     -- owner/repo
  default_branch      TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_run_at         TEXT,
  PRIMARY KEY (installation_id, name)
);
-- `repos.default_branch_override` 已废弃（分支覆盖以 `settings` 表为准，
-- 见 dashboard/api.ts 的 SETTING_DEFAULT_BRANCH）：既有库升级执行一次
--   ALTER TABLE repos DROP COLUMN default_branch_override;

CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,      -- = Workflow instance id
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  trigger         TEXT NOT NULL,         -- installation|push|schedule|manual|recovery
  state           TEXT NOT NULL,
  base_sha        TEXT,
  commit_sha      TEXT,
  pr_number       INTEGER,
  images_total    INTEGER,
  images_optimized INTEGER,
  bytes_before    INTEGER,
  bytes_after     INTEGER,
  min_kb_reduced  INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX idx_runs_repo ON runs(repo, created_at DESC);
-- 保留策略（maintenance.ts）：按 created_at 扫过期 run
CREATE INDEX idx_runs_created ON runs(created_at);

CREATE TABLE image_cache (
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  path            TEXT NOT NULL,
  source_hash     TEXT NOT NULL,         -- 原 blob sha
  result_hash     TEXT,
  source_size     INTEGER,
  result_size     INTEGER,
  optimized_at    TEXT,
  PRIMARY KEY (installation_id, repo, path, source_hash)
);

CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY,
  event       TEXT,
  received_at TEXT NOT NULL
);
-- 保留策略（maintenance.ts）：按 received_at 扫过期投递记录
CREATE INDEX idx_deliveries_received ON deliveries(received_at);

CREATE TABLE pulls (
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  head_sha        TEXT,
  state           TEXT,                  -- open|closed|merged
  opened_at       TEXT,
  closed_at       TEXT,
  PRIMARY KEY (installation_id, repo, pr_number)
);

CREATE TABLE settings (
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT,
  PRIMARY KEY (installation_id, repo, key)
);

-- P3 仪表盘：用户会话（cookie 只带 session_id，token 仅存服务端）
-- `expires_at` = 会话寿命（7 天）；`token_expires_at` = GitHub access token
-- 寿命（8 小时），到期前 5 分钟用 `refresh_token` 换新。两个 token 在配置
-- SESSION_ENCRYPTION_KEY 后以 AES-GCM 密文（v1:<iv>:<ct>）落库。
-- 已有库升级（CREATE TABLE 不会改既有表）：
--   ALTER TABLE sessions ADD COLUMN refresh_token TEXT;
--   ALTER TABLE sessions ADD COLUMN token_expires_at TEXT;
CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  user_login      TEXT NOT NULL,
  user_id         INTEGER,
  user_token      TEXT NOT NULL,
  refresh_token   TEXT,
  token_expires_at TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- DLQ 捕获：进入 router-dlq 的消息落库（默认不重试，只留证据供排查）
CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT,
  attempts INTEGER,
  body TEXT,
  error TEXT,
  received_at TEXT NOT NULL
);
