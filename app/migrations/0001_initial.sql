-- ChatBridge initial schema
-- 6 tables + 4 indexes, SQLite/D1 syntax

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  entry_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  tool_params TEXT,
  tool_result TEXT,
  app_id TEXT REFERENCES apps(id),
  sequence_num INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  app_id TEXT NOT NULL REFERENCES apps(id),
  status TEXT NOT NULL DEFAULT 'active',
  state_summary TEXT,
  state_raw TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE app_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  app_id TEXT NOT NULL REFERENCES apps(id),
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, sequence_num);
CREATE INDEX idx_app_sessions_conversation ON app_sessions(conversation_id, status);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at);
CREATE INDEX idx_app_tokens_user_app ON app_tokens(user_id, app_id);
