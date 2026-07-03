/* eslint-disable */
// Local SQLite database — mirrors the Postgres schema (single-user, no RLS).
// UUIDs are stored as TEXT, timestamps as ISO TEXT, arrays as JSON TEXT.

const path = require('path');
const Database = require('better-sqlite3');

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS telegram_api_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_id TEXT NOT NULL,
  api_hash TEXT NOT NULL,
  client_type TEXT NOT NULL DEFAULT 'telethon',
  accounts_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_validated_at TEXT,
  validation_error TEXT,
  usage_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  daily_usage INTEGER DEFAULT 0,
  daily_usage_reset_at TEXT
);

CREATE TABLE IF NOT EXISTS proxies (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT,
  password TEXT,
  proxy_type TEXT DEFAULT 'socks5',
  status TEXT DEFAULT 'active',
  assigned_account_id TEXT,
  last_checked TEXT,
  response_time INTEGER,
  country TEXT,
  detected_country TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proxy_errors (
  id TEXT PRIMARY KEY,
  proxy_id TEXT NOT NULL,
  error_message TEXT,
  error_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_accounts (
  id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  status TEXT DEFAULT 'inactive',
  proxy_id TEXT,
  session_data TEXT,
  api_id TEXT,
  api_hash TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_active TEXT,
  messages_sent_today INTEGER DEFAULT 0,
  daily_limit INTEGER DEFAULT 50,
  maturity_score INTEGER DEFAULT 0,
  maturity_days INTEGER DEFAULT 0,
  restricted_until TEXT,
  ban_reason TEXT,
  avatar_url TEXT,
  telegram_id INTEGER,
  last_spambot_check TEXT,
  device_model TEXT,
  system_version TEXT,
  app_version TEXT,
  lang_code TEXT,
  system_lang_code TEXT,
  api_credential_id TEXT,
  spambot_status TEXT,
  phone_country TEXT,
  geo_mismatch INTEGER DEFAULT 0,
  interaction_pair_id TEXT,
  tags TEXT DEFAULT '[]',
  last_campaign_send_at TEXT,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  auto_disabled INTEGER DEFAULT 0,
  disabled_reason TEXT,
  build_id TEXT,
  two_fa_password TEXT,
  cooldown_until TEXT,
  locked_by TEXT,
  locked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_status ON telegram_accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_proxy ON telegram_accounts(proxy_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_template TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  scheduled_at TEXT,
  recipient_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  pending_count INTEGER DEFAULT 0,
  batch_size INTEGER DEFAULT 0,
  seat_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_accounts (
  campaign_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (campaign_id, account_id)
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  name TEXT,
  status TEXT DEFAULT 'pending',
  sent_at TEXT,
  sent_by_account_id TEXT,
  failed_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  failed_account_ids TEXT DEFAULT '[]',
  api_credential_id TEXT,
  scheduled_at TEXT,
  seat_id TEXT,
  failed_api_ids TEXT DEFAULT '[]',
  sending_started_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipients_campaign ON campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipients_status ON campaign_recipients(status);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recipient_phone TEXT,
  recipient_telegram_id INTEGER,
  recipient_name TEXT,
  recipient_username TEXT,
  recipient_avatar TEXT,
  unread_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  last_message_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  blocked_by_recipient INTEGER DEFAULT 0,
  first_message_sent INTEGER DEFAULT 0,
  has_prior_contact INTEGER DEFAULT 0,
  seat_id TEXT,
  is_pinned INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
  last_message_content TEXT,
  last_message_direction TEXT,
  has_reply INTEGER DEFAULT 0,
  campaign_id TEXT,
  campaign_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_conv_account ON conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  telegram_message_id INTEGER,
  content TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,
  read_at TEXT,
  failed_reason TEXT,
  media_url TEXT,
  media_type TEXT,
  campaign_recipient_id TEXT,
  priority INTEGER DEFAULT 0,
  api_credential_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status);

CREATE TABLE IF NOT EXISTS material_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  item_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS material_names (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS material_pictures (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS material_data (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL,
  phone_number TEXT,
  username TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts_data (
  id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL,
  name TEXT,
  username TEXT,
  notes TEXT,
  is_used INTEGER DEFAULT 0,
  used_in_campaign_id TEXT,
  used_at TEXT,
  is_blocked INTEGER DEFAULT 0,
  blocked_at TEXT,
  tag_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_import_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  phone_numbers TEXT NOT NULL DEFAULT '[]',
  valid_numbers TEXT DEFAULT '[]',
  invalid_numbers TEXT DEFAULT '[]',
  remaining_numbers TEXT DEFAULT '[]',
  failed_account_ids TEXT DEFAULT '[]',
  current_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS blocked_contacts (
  id TEXT PRIMARY KEY,
  phone_number TEXT NOT NULL,
  name TEXT,
  blocked_by_account_id TEXT,
  reason TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS block_contact_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  target_phone TEXT NOT NULL,
  target_username TEXT,
  target_telegram_id INTEGER,
  action TEXT NOT NULL DEFAULT 'block',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS account_check_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'spambot_check',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maturation_tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  scheduled_at TEXT,
  completed_at TEXT,
  description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runner_heartbeats (
  id TEXT PRIMARY KEY,
  runner_name TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  ip_address TEXT,
  status TEXT,
  server_id TEXT,
  last_offline_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vps_logs (
  id TEXT PRIMARY KEY,
  vps_id TEXT,
  runner_name TEXT NOT NULL,
  log_level TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vps_logs_created ON vps_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS lifetime_stats (
  id TEXT PRIMARY KEY,
  stat_key TEXT NOT NULL UNIQUE,
  stat_value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS interaction_scheduler (
  id TEXT PRIMARY KEY,
  sender_account_id TEXT NOT NULL,
  receiver_account_id TEXT NOT NULL,
  next_run_at TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduled_interactions (
  id TEXT PRIMARY KEY,
  sender_account_id TEXT NOT NULL,
  receiver_account_id TEXT NOT NULL,
  scheduled_at TEXT,
  executed_at TEXT,
  status TEXT DEFAULT 'pending',
  action TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vps_commands (
  id TEXT PRIMARY KEY,
  vps_id TEXT,
  command TEXT NOT NULL,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS vps_connections (
  id TEXT PRIMARY KEY,
  name TEXT,
  host TEXT,
  status TEXT,
  last_seen TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Seed lifetime stats keys the UI expects.
INSERT OR IGNORE INTO lifetime_stats (id, stat_key, stat_value) VALUES
  (lower(hex(randomblob(16))), 'lifetime_messages_sent', 0),
  (lower(hex(randomblob(16))), 'lifetime_replies_received', 0),
  (lower(hex(randomblob(16))), 'lifetime_unique_recipients_messaged', 0),
  (lower(hex(randomblob(16))), 'lifetime_unique_recipients_replied', 0);

-- Backfill older local imports so they are visible in the Inactive tab.
UPDATE telegram_accounts
SET status = 'disconnected'
WHERE status = 'inactive';

UPDATE telegram_accounts
SET device_model = 'Telegram Desktop ' || COALESCE(NULLIF(substr(replace(phone_number, '+', ''), -4), ''), 'local'),
    system_version = COALESCE(system_version, 'Windows')
WHERE (device_model IS NULL OR device_model = '')
  AND session_data IS NOT NULL;
`;

function existingColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addMissingColumns(table, columns) {
  const existing = existingColumns(table);
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
    }
  }
}

function runMigrations() {
  // CREATE TABLE IF NOT EXISTS does not update older desktop SQLite files.
  // Keep existing local installs compatible with newer account import fields.
  addMissingColumns('telegram_accounts', {
    username: 'TEXT',
    first_name: 'TEXT',
    last_name: 'TEXT',
    status: "TEXT DEFAULT 'inactive'",
    proxy_id: 'TEXT',
    session_data: 'TEXT',
    api_id: 'TEXT',
    api_hash: 'TEXT',
    created_at: 'TEXT DEFAULT CURRENT_TIMESTAMP',
    last_active: 'TEXT',
    messages_sent_today: 'INTEGER DEFAULT 0',
    daily_limit: 'INTEGER DEFAULT 50',
    maturity_score: 'INTEGER DEFAULT 0',
    maturity_days: 'INTEGER DEFAULT 0',
    restricted_until: 'TEXT',
    ban_reason: 'TEXT',
    avatar_url: 'TEXT',
    telegram_id: 'INTEGER',
    last_spambot_check: 'TEXT',
    device_model: 'TEXT',
    system_version: 'TEXT',
    app_version: 'TEXT',
    lang_code: 'TEXT',
    system_lang_code: 'TEXT',
    api_credential_id: 'TEXT',
    spambot_status: 'TEXT',
    phone_country: 'TEXT',
    geo_mismatch: 'INTEGER DEFAULT 0',
    interaction_pair_id: 'TEXT',
    tags: "TEXT DEFAULT '[]'",
    last_campaign_send_at: 'TEXT',
    success_count: 'INTEGER DEFAULT 0',
    failure_count: 'INTEGER DEFAULT 0',
    success_rate: 'REAL DEFAULT 0',
    auto_disabled: 'INTEGER DEFAULT 0',
    disabled_reason: 'TEXT',
    build_id: 'TEXT',
    two_fa_password: 'TEXT',
    cooldown_until: 'TEXT',
    locked_by: 'TEXT',
    locked_at: 'TEXT',
  });

  db.prepare("UPDATE telegram_accounts SET status = 'disconnected' WHERE status = 'inactive'").run();
  db.prepare(`
    UPDATE telegram_accounts
    SET device_model = 'Telegram Desktop ' || COALESCE(NULLIF(substr(replace(phone_number, '+', ''), -4), ''), 'local'),
        system_version = COALESCE(system_version, 'Windows')
    WHERE (device_model IS NULL OR device_model = '')
      AND session_data IS NOT NULL
  `).run();
}

function initDb(userDataDir) {
  if (db) return db;
  const dbPath = path.join(userDataDir, 'data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  runMigrations();
  return db;
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

function ensureDb(userDataDir) {
  if (db) return db;
  if (!userDataDir) throw new Error('DB not initialized: missing userDataDir');
  return initDb(userDataDir);
}

function isDbReady() {
  return !!db;
}

function closeDb() {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
}

module.exports = { initDb, getDb, ensureDb, isDbReady, closeDb };
