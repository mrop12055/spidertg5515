/* eslint-disable */
// Local API — translates Supabase-shaped calls to SQLite.
// The frontend's localClient shim serializes each `.from().select().eq()...` chain
// into { op, table, select, filters, order, range, single } and this file executes it.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('./db.cjs');

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
  if (payload.returning === 'minimal') return { data: null, error: null };
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
  if (payload.returning === 'minimal') return { data: null, error: null, count: info.changes };
  const rows = db.prepare(`SELECT * FROM ${payload.table} ${where.sql}`).all(...where.params).map(decodeRow);
  if (payload.single) return { data: rows[0] || null, error: null };
  return { data: rows, error: null };
}

function opDelete(payload) {
  const db = getDb();
  const where = buildWhere(payload.filters);
  const sql = `DELETE FROM ${payload.table} ${where.sql}`;
  const info = db.prepare(sql).run(...where.params);
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
  if (payload.returning === 'minimal') return { data: null, error: null };
  if (payload.single) return { data: results[0] || null, error: null };
  return { data: results, error: null };
}

// ---- helpers ----
const TABLES_WITH_UPDATED_AT = new Set([
  'telegram_accounts', 'conversations', 'campaigns', 'contacts_data', 'account_check_tasks', 'lifetime_stats',
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
  // Placeholder — real edge functions get ported here in Phase 1.5.
  ping: async () => ({ ok: true, at: nowIso() }),
};

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

module.exports = { handleApiCall };
