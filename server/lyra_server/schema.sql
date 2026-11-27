-- Lyra schema version 1. Applied once; later versions add numbered migrations.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  principal_id INTEGER NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  persistent INTEGER NOT NULL,
  created_at REAL NOT NULL,
  last_seen_at REAL NOT NULL,
  expires_at REAL NOT NULL
);

CREATE TABLE pools (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  reporter_principal_id INTEGER,
  usage TEXT,
  reported_at REAL,
  created_at REAL NOT NULL,
  UNIQUE (provider, label)
);

-- Durable identities; conversations attach here, never to credentials.
CREATE TABLE principals (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- owner | agent
  handle TEXT,
  display_name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL,            -- admitted | revoked
  pool_id INTEGER,
  created_at REAL NOT NULL,
  admitted_at REAL,
  revoked_at REAL
);
CREATE UNIQUE INDEX uq_principal_active_address
  ON principals(address) WHERE status = 'admitted' AND address IS NOT NULL;
CREATE UNIQUE INDEX uq_principal_active_handle
  ON principals(handle) WHERE status = 'admitted' AND handle IS NOT NULL;

-- Rotatable credentials; at most one active per principal.
CREATE TABLE credentials (
  id INTEGER PRIMARY KEY,
  principal_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invite_id INTEGER,
  status TEXT NOT NULL,            -- active | revoked
  created_at REAL NOT NULL,
  revoked_at REAL
);
CREATE UNIQUE INDEX uq_credential_active
  ON credentials(principal_id) WHERE status = 'active';

CREATE TABLE invites (
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
  cancelled_at REAL
);

CREATE TABLE presence (
  principal_id INTEGER PRIMARY KEY,
  instance_id TEXT,
  host TEXT,
  provider TEXT,
  runtime TEXT,
  connector TEXT,
  modes TEXT,
  status TEXT,
  last_checkin_at REAL,
  online INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- owner_agent | agent_agent
  dm_pair_key TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL
);

CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL,
  principal_id INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, principal_id)
);

CREATE TABLE messages (
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
CREATE INDEX ix_messages_queue ON messages(recipient_id, state, priority DESC, created_at);
CREATE INDEX ix_messages_conv ON messages(conversation_id, id);

CREATE TABLE delivery_attempts (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  claimed_at REAL NOT NULL,
  lease_until REAL NOT NULL,
  outcome TEXT,
  outcome_at REAL
);

CREATE TABLE reactions (
  message_id INTEGER NOT NULL,
  reactor_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at REAL NOT NULL,
  PRIMARY KEY (message_id, reactor_id, emoji)
);

-- Change log for SSE replay: transitions only, never routine check-ins.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
