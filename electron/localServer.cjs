/* eslint-disable */
// Local HTTP server — 127.0.0.1 only, exposes the same API the Python runner
// previously called on the cloud edge functions. Auth uses a per-launch bearer
// token passed to the runner via TCRM_API_TOKEN.

const http = require('http');
const crypto = require('crypto');
const { handleApiCall } = require('./api.cjs');
const { getDb } = require('./db.cjs');

// Realtime emit — wired by main.cjs to fan runner-side writes to the renderer
// so the UI updates instantly instead of polling.
let _emit = null;
function setChangeEmitter(fn) { _emit = fn; }
function emit(table, eventType, row) {
  if (!_emit) return;
  try { _emit({ table, eventType, new: row || null, old: row || null }); } catch (_) {}
}

let server = null;
let port = 0;
let token = '';

function nowIso() { return new Date().toISOString(); }

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// --- Runner-facing endpoints (mirror old edge function shapes) ---

async function handleRoute(req, url, body, ctx) {
  const path = url.pathname;

  // Simple heartbeat — one runner per PC, no server_id checks.
  if (path === '/heartbeat' && req.method === 'POST') {
    const db = getDb();
    const runner = body.runner || 'unified';
    const stmt = db.prepare(`
      INSERT INTO runner_heartbeats (id, runner_name, last_seen, status, server_id)
      VALUES (?, ?, ?, 'online', ?)
      ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, status = 'online', server_id = excluded.server_id
    `);
    // Use runner name as stable id so there's exactly one row.
    stmt.run(runner, runner, nowIso(), body.server_id || 'local');
    emit('runner_heartbeats', 'UPDATE', { runner_name: runner, last_seen: nowIso(), status: 'online' });
    return { ok: true };
  }

  // Return active accounts + optional proxy join. Session data is included so
  // the runner can restore Telethon clients locally.
  if (path === '/accounts' && req.method === 'GET') {
    const db = getDb();
    const rows = db.prepare(`
      SELECT a.*, p.host AS proxy_host, p.port AS proxy_port, p.username AS proxy_username,
             p.password AS proxy_password, p.proxy_type AS proxy_type
      FROM telegram_accounts a
      LEFT JOIN proxies p ON p.id = a.proxy_id
      WHERE a.status = 'active' AND (a.auto_disabled IS NULL OR a.auto_disabled = 0)
    `).all();
    const accounts = rows.map((r) => {
      const proxy = r.proxy_host ? {
        host: r.proxy_host, port: r.proxy_port,
        username: r.proxy_username, password: r.proxy_password,
        proxy_type: r.proxy_type,
      } : null;
      delete r.proxy_host; delete r.proxy_port; delete r.proxy_username;
      delete r.proxy_password; delete r.proxy_type;
      return { ...r, proxy };
    });
    return { accounts };
  }

  // Task fetch — pending campaign_recipients ready to send.
  if (path === '/tasks/get' && req.method === 'POST') {
    const db = getDb();
    const limit = Math.min(parseInt(body.batch_size || 50, 10), 500);
    const rows = db.prepare(`
      SELECT cr.*, c.message_template, c.name AS campaign_name
      FROM campaign_recipients cr
      JOIN campaigns c ON c.id = cr.campaign_id
      WHERE cr.status = 'pending' AND c.status = 'running'
      ORDER BY cr.scheduled_at IS NULL, cr.scheduled_at
      LIMIT ?
    `).all(limit);
    // Mark as sending to avoid double-claiming.
    const mark = db.prepare(`UPDATE campaign_recipients SET status = 'sending', sending_started_at = ? WHERE id = ?`);
    const tx = db.transaction(() => rows.forEach((r) => mark.run(nowIso(), r.id)));
    tx();
    for (const r of rows) emit('campaign_recipients', 'UPDATE', { id: r.id, campaign_id: r.campaign_id, status: 'sending' });
    return { tasks: rows };
  }

  // Report task result.
  if (path === '/tasks/report' && req.method === 'POST') {
    const db = getDb();
    const { recipient_id, status, failed_reason, sent_by_account_id } = body;
    db.prepare(`
      UPDATE campaign_recipients
      SET status = ?, failed_reason = ?, sent_by_account_id = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
      WHERE id = ?
    `).run(status, failed_reason || null, sent_by_account_id || null, status, nowIso(), recipient_id);
    // Bump counters and lifetime stats.
    if (status === 'sent') {
      db.prepare(`UPDATE lifetime_stats SET stat_value = stat_value + 1, updated_at = ? WHERE stat_key = 'lifetime_messages_sent'`).run(nowIso());
      if (sent_by_account_id) {
        db.prepare(`UPDATE telegram_accounts SET messages_sent_today = COALESCE(messages_sent_today,0) + 1, last_active = ? WHERE id = ?`).run(nowIso(), sent_by_account_id);
      }
    }
    return { ok: true };
  }

  // Ingest an incoming message from Telethon.
  if (path === '/messages/incoming' && req.method === 'POST') {
    const db = getDb();
    const { account_id, from_phone, from_username, from_telegram_id, from_name, content, telegram_message_id } = body;
    // Find or create conversation.
    let conv = db.prepare(`
      SELECT * FROM conversations
      WHERE account_id = ? AND (recipient_telegram_id = ? OR recipient_phone = ?)
      LIMIT 1
    `).get(account_id, from_telegram_id || 0, from_phone || '');
    if (!conv) {
      const cid = crypto.randomUUID();
      db.prepare(`
        INSERT INTO conversations (id, account_id, recipient_phone, recipient_telegram_id, recipient_username, recipient_name, has_reply, last_message_at, last_message_content, last_message_direction, unread_count)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'incoming', 1)
      `).run(cid, account_id, from_phone || null, from_telegram_id || null, from_username || null, from_name || null, nowIso(), content);
      conv = { id: cid };
    } else {
      db.prepare(`
        UPDATE conversations
        SET last_message_at = ?, last_message_content = ?, last_message_direction = 'incoming',
            has_reply = 1, unread_count = COALESCE(unread_count,0) + 1, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), content, nowIso(), conv.id);
    }
    db.prepare(`
      INSERT INTO messages (id, account_id, conversation_id, telegram_message_id, content, direction, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'incoming', 'delivered', ?)
    `).run(crypto.randomUUID(), account_id, conv.id, telegram_message_id || null, content, nowIso());
    db.prepare(`UPDATE lifetime_stats SET stat_value = stat_value + 1, updated_at = ? WHERE stat_key = 'lifetime_replies_received'`).run(nowIso());
    return { ok: true, conversation_id: conv.id };
  }

  // Update account status (used when runner detects frozen/banned).
  if (path === '/accounts/status' && req.method === 'POST') {
    const db = getDb();
    const { account_id, status, ban_reason, auto_disabled } = body;
    db.prepare(`
      UPDATE telegram_accounts
      SET status = COALESCE(?, status), ban_reason = COALESCE(?, ban_reason),
          auto_disabled = COALESCE(?, auto_disabled), last_active = ?
      WHERE id = ?
    `).run(status || null, ban_reason || null, auto_disabled == null ? null : (auto_disabled ? 1 : 0), nowIso(), account_id);
    return { ok: true };
  }

  // Log line from runner.
  if (path === '/logs' && req.method === 'POST') {
    const db = getDb();
    db.prepare(`INSERT INTO vps_logs (id, runner_name, log_level, message) VALUES (?, ?, ?, ?)`)
      .run(crypto.randomUUID(), body.runner || 'unified', body.level || 'info', body.message || '');
    return { ok: true };
  }

  // Generic passthrough for anything using the existing SQL-shaped API.
  if (path === '/query' && req.method === 'POST') {
    return await handleApiCall(body, ctx);
  }

  return null;
}

function start(ctx) {
  if (server) return { port, token };
  token = crypto.randomBytes(24).toString('hex');
  server = http.createServer(async (req, res) => {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad url' }); }
    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad json' }); }
    }
    try {
      const result = await handleRoute(req, url, body, ctx);
      if (result == null) return send(res, 404, { error: 'not found', path: url.pathname });
      return send(res, 200, result);
    } catch (err) {
      return send(res, 500, { error: err.message || String(err) });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log(`[localServer] listening on 127.0.0.1:${port}`);
      resolve({ port, token });
    });
  });
}

function stop() {
  if (server) { try { server.close(); } catch (_) {} server = null; }
}

function getEndpoint() { return { port, token, url: port ? `http://127.0.0.1:${port}` : '' }; }

module.exports = { start, stop, getEndpoint };
