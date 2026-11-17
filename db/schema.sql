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
  default_branch_override TEXT,          -- 原版 settings.DefaultBranchOverride
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_run_at         TEXT,
  PRIMARY KEY (installation_id, name)
);

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
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  user_login TEXT NOT NULL,
  user_id    INTEGER,
  user_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
