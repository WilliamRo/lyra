-- Current schema. Versioned migrations add missing columns before applying this DDL.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  principal_id INTEGER NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  persistent INTEGER NOT NULL,
  created_at REAL NOT NULL,
  last_seen_at REAL NOT NULL,
  expires_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  account_label TEXT,
  subscription TEXT,
  notes TEXT,
  reporter_principal_id INTEGER,
  usage TEXT,
  reported_at REAL,
  created_at REAL NOT NULL,
  UNIQUE (provider, label)
);

-- Durable identities; conversations attach here, never to credentials.
CREATE TABLE IF NOT EXISTS principals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- owner | agent
  handle TEXT,
  display_name TEXT NOT NULL,
  avatar TEXT,
  address TEXT,
  status TEXT NOT NULL,            -- admitted | revoked
  role TEXT,                       -- NULL | consul (single active holder)
  pool_id INTEGER,
  created_at REAL NOT NULL,
  admitted_at REAL,
  revoked_at REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_active_address
  ON principals(address) WHERE status = 'admitted' AND address IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_active_handle
  ON principals(handle) WHERE status = 'admitted' AND handle IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_consul
  ON principals(role) WHERE role = 'consul';

-- Rotatable credentials; at most one active per principal.
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY,
  principal_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invite_id INTEGER,
  status TEXT NOT NULL,            -- active | revoked
  created_at REAL NOT NULL,
  revoked_at REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credential_active
  ON credentials(principal_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  display_name TEXT,
  handle TEXT,
  pool_id INTEGER,
  target_principal_id INTEGER,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  redeemed_at REAL,
  redeemed_principal_id INTEGER,
  client_key_hash TEXT,
  cancelled_at REAL,
  issued_by_principal_id INTEGER,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS presence (
  principal_id INTEGER PRIMARY KEY,
  instance_id TEXT,
  host TEXT,
  provider TEXT,
  runtime TEXT,
  connector TEXT,
  modes TEXT,
  status TEXT,
  capabilities TEXT,
  host_metrics TEXT,
  last_checkin_at REAL,
  online INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- owner_agent | agent_agent
  dm_pair_key TEXT NOT NULL UNIQUE,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at REAL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL,
  principal_id INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, principal_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  reply_to_id INTEGER,
  mode TEXT NOT NULL,              -- queue | jump
  priority INTEGER NOT NULL,
  state TEXT NOT NULL,             -- waiting | delivered | unconfirmed | failed
  state_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until REAL,
  client_msg_id TEXT,
  created_at REAL NOT NULL,
  delivered_at REAL,
  failed_at REAL,
  UNIQUE (sender_id, client_msg_id)
);
CREATE INDEX IF NOT EXISTS ix_messages_queue ON messages(recipient_id, state, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  claimed_at REAL NOT NULL,
  lease_until REAL NOT NULL,
  outcome TEXT,
  outcome_at REAL
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL,
  reactor_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (message_id, reactor_id, emoji)
);

-- Change log for SSE replay: transitions only, never routine check-ins.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploader_id INTEGER NOT NULL REFERENCES principals(id),
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_relpath TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  attachment_id INTEGER NOT NULL UNIQUE REFERENCES attachments(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS ix_message_attachments_msg ON message_attachments(message_id, position);

CREATE TABLE IF NOT EXISTS conversation_reads (
  principal_id INTEGER NOT NULL REFERENCES principals(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL,
  PRIMARY KEY (principal_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS message_progress (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  phase TEXT NOT NULL,
  summary TEXT,
  bullets TEXT,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  pm_principal_id INTEGER REFERENCES principals(id),
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  principal_id INTEGER NOT NULL REFERENCES principals(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at REAL NOT NULL,
  PRIMARY KEY (project_id, principal_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  created_by_principal_id INTEGER REFERENCES principals(id),
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tasks_project ON tasks(project_id, id);
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  principal_id INTEGER NOT NULL REFERENCES principals(id),
  assigned_at REAL NOT NULL,
  PRIMARY KEY (task_id, principal_id)
);
