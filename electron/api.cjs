/* eslint-disable */
// Local API — translates Supabase-shaped calls to SQLite.
// The frontend's localClient shim serializes each `.from().select().eq()...` chain
// into { op, table, select, filters, order, range, single } and this file executes it.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('./db.cjs');

// Change-event broadcaster: registered by main.cjs so writes fan out over IPC
// to renderer subscribers (localClient.channel().on('postgres_changes', ...)).
let _emitChange = null;
function setChangeEmitter(fn) { _emitChange = fn; }
function emitChange(table, eventType, row) {
  if (_emitChange) {
    try { _emitChange({ table, eventType, new: row || null, old: row || null }); } catch (_) {}
  }
}

const JSON_COLUMNS = new Set([
  'tags',
  'phone_numbers', 'valid_numbers', 'invalid_numbers',
  'remaining_numbers', 'failed_account_ids', 'failed_api_ids',
]);
const BOOL_COLUMNS = new Set([
  'is_active', 'is_pinned', 'is_hidden', 'is_used', 'is_blocked',
  'blocked_by_recipient', 'first_message_sent', 'has_prior_contact',
  'has_reply', 'geo_mismatch', 'auto_disabled',
]);

function newId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhoneNumber(value) {
  if (value == null) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw.startsWith('+unknown_')) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `+${digits}` : raw.startsWith('+') ? raw : `+${raw}`;
}

function generatedDeviceModel(phone) {
  const suffix = String(phone || '').replace(/\D/g, '').slice(-4) || 'local';
  return `Telegram Desktop ${suffix}`;
}

// Coerce a JS value to something SQLite accepts (JSON-encode arrays/objects,
// booleans -> 0/1, dates -> ISO strings).
function encode(col, val) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (JSON_COLUMNS.has(col) && Array.isArray(val)) return JSON.stringify(val);
  if (BOOL_COLUMNS.has(col) && typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
}

function decodeRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_COLUMNS.has(k) && typeof v === 'string') {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else if (BOOL_COLUMNS.has(k) && (v === 0 || v === 1)) {
      out[k] = v === 1;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Build a WHERE clause from a Supabase-shaped filter list.
// Each filter is { col, op, val } where op ∈ eq|neq|gt|gte|lt|lte|in|is|like|ilike|not.in|not.is
function buildWhere(filters) {
  if (!filters || !filters.length) return { sql: '', params: [] };
  const clauses = [];
  const params = [];
  for (const f of filters) {
    const col = f.col;
    const op = f.op;
    const val = f.val;
    switch (op) {
      case 'eq': clauses.push(`${col} = ?`); params.push(encode(col, val)); break;
      case 'neq': clauses.push(`${col} != ?`); params.push(encode(col, val)); break;
      case 'gt': clauses.push(`${col} > ?`); params.push(encode(col, val)); break;
      case 'gte': clauses.push(`${col} >= ?`); params.push(encode(col, val)); break;
      case 'lt': clauses.push(`${col} < ?`); params.push(encode(col, val)); break;
      case 'lte': clauses.push(`${col} <= ?`); params.push(encode(col, val)); break;
      case 'like': clauses.push(`${col} LIKE ?`); params.push(val); break;
      case 'ilike': clauses.push(`${col} LIKE ? COLLATE NOCASE`); params.push(val); break;
      case 'in': {
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) { clauses.push('0=1'); break; }
        clauses.push(`${col} IN (${arr.map(() => '?').join(',')})`);
        for (const v of arr) params.push(encode(col, v));
        break;
      }
      case 'not.in': {
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) { clauses.push('1=1'); break; }
        clauses.push(`${col} NOT IN (${arr.map(() => '?').join(',')})`);
        for (const v of arr) params.push(encode(col, v));
        break;
      }
      case 'is': {
        if (val === null) clauses.push(`${col} IS NULL`);
        else clauses.push(`${col} IS ?`), params.push(encode(col, val));
        break;
      }
      case 'not.is': {
        if (val === null) clauses.push(`${col} IS NOT NULL`);
        else clauses.push(`${col} IS NOT ?`), params.push(encode(col, val));
        break;
      }
      case 'or': {
        // val is a raw PostgREST-style string like "col1.eq.foo,col2.eq.bar" — not used yet.
        // Simple fallback: treat as always true; ignore.
        clauses.push('1=1');
        break;
      }
      default:
        clauses.push('1=1');
    }
  }
  return { sql: 'WHERE ' + clauses.join(' AND '), params };
}

function buildOrder(order) {
  if (!order || !order.length) return '';
  return 'ORDER BY ' + order
    .map((o) => `${o.col} ${o.ascending ? 'ASC' : 'DESC'}${o.nullsFirst ? ' NULLS FIRST' : ''}`)
    .join(', ');
}

function opSelect(payload) {
  const db = getDb();
  const cols = payload.select && payload.select !== '*' ? payload.select : '*';
  const where = buildWhere(payload.filters);
  const order = buildOrder(payload.order);
  let sql = `SELECT ${cols} FROM ${payload.table} ${where.sql} ${order}`.trim();
  if (payload.range) {
    const { from, to } = payload.range;
    const limit = to - from + 1;
    sql += ` LIMIT ${limit} OFFSET ${from}`;
  } else if (payload.limit) {
    sql += ` LIMIT ${payload.limit}`;
    if (payload.offset) sql += ` OFFSET ${payload.offset}`;
  }
  const rows = db.prepare(sql).all(...where.params).map(decodeRow);
  if (payload.count === 'exact') {
    const countSql = `SELECT COUNT(*) as c FROM ${payload.table} ${where.sql}`;
    const c = db.prepare(countSql).get(...where.params).c;
    return { data: payload.single ? (rows[0] || null) : rows, count: c, error: null };
  }
  if (payload.single) return { data: rows[0] || null, error: rows.length ? null : { code: 'PGRST116', message: 'No rows' } };
  if (payload.maybeSingle) return { data: rows[0] || null, error: null };
  return { data: rows, error: null };
}

function opInsert(payload) {
  const db = getDb();
  const list = Array.isArray(payload.values) ? payload.values : [payload.values];
  const results = [];
  const insertOne = (raw) => {
    const values = { ...raw };
    if (!values.id) values.id = newId();
    if ('updated_at' in values || tableHasUpdatedAt(payload.table)) values.updated_at = nowIso();
    if (!values.created_at && tableHasCreatedAt(payload.table)) values.created_at = nowIso();
    const cols = Object.keys(values);
    const placeholders = cols.map(() => '?').join(',');
    const params = cols.map((c) => encode(c, values[c]));
    const sql = `INSERT INTO ${payload.table} (${cols.join(',')}) VALUES (${placeholders})`;
    db.prepare(sql).run(...params);
    if (payload.returning !== 'minimal') {
      const row = db.prepare(`SELECT * FROM ${payload.table} WHERE id = ?`).get(values.id);
      results.push(decodeRow(row));
    }
  };
  const tx = db.transaction(() => list.forEach(insertOne));
  tx();
  for (const r of results) emitChange(payload.table, 'INSERT', r);
  if (payload.returning === 'minimal') { emitChange(payload.table, 'INSERT', null); return { data: null, error: null }; }
  if (payload.single) return { data: results[0] || null, error: null };
  return { data: results, error: null };
}

function opUpdate(payload) {
  const db = getDb();
  const values = { ...payload.values };
  if (tableHasUpdatedAt(payload.table)) values.updated_at = nowIso();
  const setCols = Object.keys(values);
  const setSql = setCols.map((c) => `${c} = ?`).join(', ');
  const setParams = setCols.map((c) => encode(c, values[c]));
  const where = buildWhere(payload.filters);
  const sql = `UPDATE ${payload.table} SET ${setSql} ${where.sql}`;
  const info = db.prepare(sql).run(...setParams, ...where.params);
  const rows = db.prepare(`SELECT * FROM ${payload.table} ${where.sql}`).all(...where.params).map(decodeRow);
  for (const r of rows) emitChange(payload.table, 'UPDATE', r);
  if (info.changes && rows.length === 0) emitChange(payload.table, 'UPDATE', null);
  if (payload.returning === 'minimal') return { data: null, error: null, count: info.changes };
  if (payload.single) return { data: rows[0] || null, error: null };
  return { data: rows, error: null };
}

function opDelete(payload) {
  const db = getDb();
  const where = buildWhere(payload.filters);
  // Capture rows before delete so subscribers can react.
  const doomed = db.prepare(`SELECT * FROM ${payload.table} ${where.sql}`).all(...where.params).map(decodeRow);
  const sql = `DELETE FROM ${payload.table} ${where.sql}`;
  const info = db.prepare(sql).run(...where.params);
  for (const r of doomed) emitChange(payload.table, 'DELETE', r);
  return { data: null, error: null, count: info.changes };
}

function opUpsert(payload) {
  const db = getDb();
  const list = Array.isArray(payload.values) ? payload.values : [payload.values];
  const conflictCols = (payload.onConflict || 'id').split(',').map((s) => s.trim());
  const results = [];
  const upsertOne = (raw) => {
    const values = { ...raw };
    if (!values.id) values.id = newId();
    if (tableHasUpdatedAt(payload.table)) values.updated_at = nowIso();
    if (!values.created_at && tableHasCreatedAt(payload.table)) values.created_at = nowIso();
    const cols = Object.keys(values);
    const placeholders = cols.map(() => '?').join(',');
    const params = cols.map((c) => encode(c, values[c]));
    const updateCols = cols.filter((c) => !conflictCols.includes(c));
    const updateSql = updateCols.length
      ? `DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')}`
      : 'DO NOTHING';
    const sql = `INSERT INTO ${payload.table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT(${conflictCols.join(',')}) ${updateSql}`;
    db.prepare(sql).run(...params);
    if (payload.returning !== 'minimal') {
      const rows = db.prepare(`SELECT * FROM ${payload.table} WHERE ${conflictCols.map((c) => `${c} = ?`).join(' AND ')}`)
        .all(...conflictCols.map((c) => encode(c, values[c])));
      if (rows[0]) results.push(decodeRow(rows[0]));
    }
  };
  const tx = db.transaction(() => list.forEach(upsertOne));
  tx();
  for (const r of results) emitChange(payload.table, 'UPDATE', r);
  if (payload.returning === 'minimal') return { data: null, error: null };
  if (payload.single) return { data: results[0] || null, error: null };
  return { data: results, error: null };
}

// ---- helpers ----
const TABLES_WITH_UPDATED_AT = new Set([
  'conversations', 'campaigns', 'contacts_data', 'account_check_tasks', 'lifetime_stats',
]);
const TABLES_WITH_CREATED_AT = new Set([
  'telegram_accounts', 'proxies', 'proxy_errors', 'conversations', 'messages', 'campaigns',
  'campaign_recipients', 'material_tags', 'material_names', 'material_pictures', 'material_data',
  'contacts_data', 'contact_tags', 'contact_import_tasks', 'blocked_contacts',
  'block_contact_tasks', 'account_check_tasks', 'maturation_tasks', 'runner_heartbeats',
  'vps_logs', 'telegram_api_credentials',
]);
function tableHasUpdatedAt(t) { return TABLES_WITH_UPDATED_AT.has(t); }
function tableHasCreatedAt(t) { return TABLES_WITH_CREATED_AT.has(t); }

// ---- storage: save a base64/uint8 blob to disk and return a file:// URL ----
function opStorageUpload(payload, ctx) {
  const bucket = payload.bucket || 'files';
  const rel = payload.path.replace(/[^a-zA-Z0-9/_.-]/g, '_');
  const abs = path.join(ctx.userDataDir, 'files', bucket, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const buf = payload.data instanceof Uint8Array
    ? Buffer.from(payload.data)
    : Buffer.from(payload.data, 'base64');
  fs.writeFileSync(abs, buf);
  const url = 'file://' + abs.replace(/\\/g, '/');
  return { data: { path: rel, publicUrl: url }, error: null };
}

// ---- ported edge functions live here (add as needed) ----
async function opFunction(payload) {
  const { name, body } = payload;
  const handler = FUNCTIONS[name];
  if (!handler) return { data: null, error: { message: `Unknown function: ${name}` } };
  try {
    const result = await handler(body || {});
    return { data: result, error: null };
  } catch (err) {
    return { data: null, error: { message: err.message || String(err) } };
  }
}

const FUNCTIONS = {
  ping: async () => ({ ok: true, at: nowIso() }),

  // Ported from supabase/functions/admin-api. Router dispatches on body.path so the
  // frontend keeps working with { body: { path: '/foo', ...args } }.
  'admin-api': async (body) => {
    const p = body && body.path;
    switch (p) {
      case '/upload-accounts': return adminUploadAccounts(body);
      case '/verify-sessions': return adminVerifySessions(body);
      case '/campaigns/start': return adminCampaignsStart(body);
      case '/campaigns/pause': return adminCampaignsPause(body);
      default: throw new Error(`admin-api: unknown path ${p}`);
    }
  },

  // Ported from supabase/functions/utilities.
  utilities: async (body) => {
    const p = body && body.path;
    switch (p) {
      case '/test-proxies': return utilTestProxies(body);
      default: throw new Error(`utilities: unknown path ${p}`);
    }
  },
};

// ==============================================================================
// admin-api ports
// ==============================================================================

function adminUploadAccounts(body) {
  const db = getDb();
  const accounts = body.accounts || [];
  const tags = body.tags || [];
  let imported = 0, skipped = 0, failed = 0;
  const errors = [];
  const accountIds = [];
  const metadataStats = {
    with_json_api: 0,
    with_json_fingerprint: 0,
    with_generated_fingerprint: 0,
    with_2fa: 0,
  };
  const upsertOne = db.transaction((a) => {
    const phone = normalizePhoneNumber(a.phone_number || a.phone || a.phone_num);
    if (!phone) throw new Error('Missing phone number');

    const resolvedApiId = (a.api_id || a.app_id)?.toString() || null;
    const resolvedApiHash = a.api_hash || a.app_hash || null;
    const resolvedDeviceModel = a.device_model || a.device || generatedDeviceModel(phone);
    const resolvedSystemVersion = a.system_version || a.sdk || 'Windows';

    if (resolvedApiId && resolvedApiHash) metadataStats.with_json_api++;
    if (a.device_model || a.device || a.system_version || a.sdk) metadataStats.with_json_fingerprint++;
    else metadataStats.with_generated_fingerprint++;
    if (a.two_fa_password || a.twoFA || a['2fa']) metadataStats.with_2fa++;

    const existing = db.prepare('SELECT id FROM telegram_accounts WHERE phone_number = ?').get(phone);
    const id = existing?.id || newId();
    const cols = {
      id,
      phone_number: phone,
      username: a.username || null,
      first_name: a.first_name || null,
      last_name: a.last_name || null,
      api_id: resolvedApiId,
      api_hash: resolvedApiHash,
      device_model: resolvedDeviceModel,
      system_version: resolvedSystemVersion,
      app_version: a.app_version || null,
      lang_code: a.lang_code || null,
      system_lang_code: a.system_lang_code || null,
      session_data: a.session_data || null,
      status: a.status || 'disconnected',
      tags: JSON.stringify(tags),
      created_at: existing ? undefined : nowIso(),
    };
    const setCols = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (existing) {
      const sql = `UPDATE telegram_accounts SET ${setCols.filter(k=>k!=='id').map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...setCols.filter(k=>k!=='id').map((k) => cols[k]), id);
    } else {
      const sql = `INSERT INTO telegram_accounts (${setCols.join(',')}) VALUES (${setCols.map(() => '?').join(',')})`;
      db.prepare(sql).run(...setCols.map((k) => cols[k]));
    }
    imported++;
    accountIds.push(id);
  });
  for (const a of accounts) {
    try {
      upsertOne(a);
    } catch (e) {
      failed++;
      errors.push({ phone: a.phone_number || a.phone || a.phone_num || null, error: e.message });
    }
  }
  return {
    success: true,
    successful: imported,
    imported,
    skipped,
    failed,
    errors,
    account_ids: accountIds,
    metadata_stats: metadataStats,
  };
}

function adminVerifySessions(body) {
  // Real verification requires Telethon (runner-side). For now mark accounts we
  // can find as "valid" and any missing IDs as "invalid" so the UI flow works.
  const db = getDb();
  const ids = body.account_ids || [];
  const results = [];
  let valid = 0, invalid = 0;
  for (const id of ids) {
    const row = db.prepare('SELECT id, phone_number, session_data FROM telegram_accounts WHERE id = ?').get(id);
    if (row && row.session_data) { results.push({ account_id: id, ok: true }); valid++; }
    else { results.push({ account_id: id, ok: false, error: 'No session' }); invalid++; }
  }
  return { results, summary: { valid, invalid, total: ids.length } };
}

function adminCampaignsStart(body) {
  const db = getDb();
  const cid = body.campaign_id;
  if (!cid) throw new Error('campaign_id required');
  db.prepare("UPDATE campaigns SET status = 'running', updated_at = ? WHERE id = ?").run(nowIso(), cid);
  const info = db.prepare("UPDATE campaign_recipients SET status = 'pending' WHERE campaign_id = ? AND status = 'queued'").run(cid);
  // Auto-enrol active, non-frozen accounts under their daily limit.
  const accounts = db.prepare(`
    SELECT id FROM telegram_accounts
    WHERE status = 'active'
      AND (auto_disabled IS NULL OR auto_disabled = 0)
      AND messages_sent_today < daily_limit
  `).all();
  const insert = db.prepare('INSERT OR IGNORE INTO campaign_accounts (campaign_id, account_id) VALUES (?, ?)');
  const tx = db.transaction((rows) => rows.forEach((r) => insert.run(cid, r.id)));
  tx(accounts);
  return { ok: true, promoted_count: info.changes, enrolled_accounts: accounts.length };
}

function adminCampaignsPause(body) {
  const db = getDb();
  const cid = body.campaign_id;
  if (!cid) throw new Error('campaign_id required');
  db.prepare("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?").run(nowIso(), cid);
  return { ok: true };
}

// ==============================================================================
// utilities ports
// ==============================================================================

async function utilTestProxies(body) {
  // Real socket testing lives in the runner. For now record a "checked" timestamp
  // and mark proxies as active so the UI reflects the tap.
  const db = getDb();
  const ids = body.proxy_ids || [];
  const results = [];
  const upd = db.prepare("UPDATE proxies SET status = 'active', last_checked = ?, response_time = ? WHERE id = ?");
  for (const id of ids) {
    upd.run(nowIso(), 0, id);
    results.push({ proxy_id: id, ok: true, response_time_ms: 0 });
  }
  return { results, tested: ids.length };
}


// ---- top-level dispatcher ----
async function handleApiCall(payload, ctx) {
  switch (payload.op) {
    case 'select': return opSelect(payload);
    case 'insert': return opInsert(payload);
    case 'update': return opUpdate(payload);
    case 'delete': return opDelete(payload);
    case 'upsert': return opUpsert(payload);
    case 'storage.upload': return opStorageUpload(payload, ctx);
    case 'function': return await opFunction(payload);
    default: return { data: null, error: { message: `Unknown op: ${payload.op}` } };
  }
}

module.exports = { handleApiCall, setChangeEmitter };
