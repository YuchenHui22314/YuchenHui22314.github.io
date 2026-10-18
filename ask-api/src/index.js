// 提问箱 / Q&A box API — Cloudflare Worker + D1.
//
// Visibility model: a question stays private until the owner replies. The public
// view of a thread shows every message up to the owner's latest reply, so asker
// follow-ups only become public once the owner answers them. The asker proves
// ownership of a thread with a random token that is only ever stored hashed.

const DEFAULTS = {
  MAX_BODY_CHARS: 2000,
  MAX_PENDING_PER_THREAD: 5,
  RATE_NEW_THREADS_PER_HOUR: 5,
  RATE_MESSAGES_PER_HOUR: 20,
};
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_REQUEST_BYTES = 16 * 1024;
const HOUR = 60 * 60 * 1000;
const LANGS = ['zh', 'en', 'fr'];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        res = json({ error: err.code, message: err.message }, err.status);
      } else {
        console.error(err);
        res = json({ error: 'internal', message: 'Internal error' }, 500);
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  let m;

  if (path === '/api/health' && method === 'GET') return json({ ok: true });

  if (path === '/api/threads') {
    if (method === 'GET') return listPublic(env, url);
    if (method === 'POST') return createThread(request, env, ctx);
  }
  if (path === '/api/threads/lookup' && method === 'POST') return lookupMine(request, env);
  if ((m = path.match(/^\/api\/threads\/([A-Za-z0-9]{6,32})$/)) && method === 'GET') {
    return getThread(request, env, m[1]);
  }
  if ((m = path.match(/^\/api\/threads\/([A-Za-z0-9]{6,32})\/messages$/)) && method === 'POST') {
    return postMessage(request, env, ctx, m[1]);
  }

  if (path.startsWith('/api/admin/')) {
    if (!(await isAdmin(request, env))) throw new HttpError(401, 'unauthorized', 'Admin token required');
    if (path === '/api/admin/threads' && method === 'GET') return adminList(env, url);
    if ((m = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9]{6,32})$/))) {
      if (method === 'PATCH') return adminUpdateThread(request, env, m[1]);
      if (method === 'DELETE') return adminDeleteThread(env, m[1]);
    }
    if ((m = path.match(/^\/api\/admin\/messages\/(\d+)$/))) {
      if (method === 'PATCH') return adminEditMessage(request, env, Number(m[1]));
      if (method === 'DELETE') return adminDeleteMessage(env, Number(m[1]));
    }
  }

  throw new HttpError(404, 'not_found', 'Not found');
}

// ---------- public ----------

async function listPublic(env, url) {
  const limit = clampInt(url.searchParams.get('limit'), PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const cursor = parseCursor(url.searchParams.get('cursor'));

  // published_upto is an autoincrement message id, so it orders replies strictly by time.
  let sql = "SELECT * FROM threads WHERE status = 'open' AND published_upto IS NOT NULL";
  const binds = [];
  if (cursor) {
    sql += ' AND published_upto < ?';
    binds.push(cursor);
  }
  sql += ' ORDER BY published_upto DESC LIMIT ?';
  binds.push(limit + 1);

  const { results: rows } = await env.DB.prepare(sql).bind(...binds).all();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const threads = await withMessages(env, page, 'public');

  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM threads WHERE status = 'open' AND published_upto IS NOT NULL",
  ).first('n');

  const last = page[page.length - 1];
  return json({
    threads,
    total,
    nextCursor: hasMore && last ? String(last.published_upto) : null,
  });
}

async function getThread(request, env, id) {
  const t = await findThread(env, id);
  let view = 'public';
  if (t && (await isAdmin(request, env))) view = 'owner';
  else if (t && (await askerTokenMatches(request.headers.get('X-Asker-Token'), t))) view = 'asker';

  if (!t || (view === 'public' && !isPublic(t))) throw new HttpError(404, 'not_found', 'Not found');
  const [thread] = await withMessages(env, [t], view);
  return json({ thread });
}

async function createThread(request, env, ctx) {
  const input = await readJson(request);
  rejectHoneypot(input);
  const body = cleanBody(input.body, env);
  await verifyTurnstile(env, input.turnstileToken, request);

  const ipHash = await hashIp(request, env);
  await enforceRateLimits(env, ipHash, { newThread: true });

  const id = randomId(10);
  const token = randomToken();
  const now = Date.now();
  const lang = LANGS.includes(input.lang) ? input.lang : null;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO threads (id, created_at, updated_at, awaiting_reply, asker_token_hash, ip_hash, lang)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).bind(id, now, now, await sha256Hex(token), ipHash, lang),
    env.DB.prepare(
      "INSERT INTO messages (thread_id, author, body, created_at, ip_hash) VALUES (?, 'asker', ?, ?, ?)",
    ).bind(id, body, now, ipHash),
  ]);

  ctx.waitUntil(notifyOwner(env, 'New question', body, id));
  const [thread] = await withMessages(env, [await findThread(env, id)], 'asker');
  return json({ thread, askerToken: token }, 201);
}

async function postMessage(request, env, ctx, id) {
  const input = await readJson(request);
  const t = await findThread(env, id);
  if (!t) throw new HttpError(404, 'not_found', 'Not found');

  if (await isAdmin(request, env)) {
    const body = cleanBody(input.body, env);
    const now = Date.now();
    const res = await env.DB.prepare(
      "INSERT INTO messages (thread_id, author, body, created_at) VALUES (?, 'owner', ?, ?)",
    ).bind(id, body, now).run();
    await env.DB.prepare(
      'UPDATE threads SET updated_at = ?, published_at = ?, published_upto = ?, awaiting_reply = 0 WHERE id = ?',
    ).bind(now, now, res.meta.last_row_id, id).run();
    const [thread] = await withMessages(env, [await findThread(env, id)], 'owner');
    return json({ thread }, 201);
  }

  if (!(await askerTokenMatches(request.headers.get('X-Asker-Token'), t))) {
    throw new HttpError(401, 'unauthorized', 'Only the person who asked can continue this conversation');
  }
  if (t.status === 'hidden' || t.closed) {
    throw new HttpError(403, 'closed', 'This conversation is closed');
  }
  rejectHoneypot(input);
  const body = cleanBody(input.body, env);

  const streak = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND author = 'asker' AND id > ?",
  ).bind(id, t.published_upto ?? 0).first('n');
  if (streak >= limitOf(env, 'MAX_PENDING_PER_THREAD')) {
    throw new HttpError(429, 'too_many_pending', 'Please wait for a reply before sending more messages');
  }

  const ipHash = await hashIp(request, env);
  await enforceRateLimits(env, ipHash, { newThread: false });

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (thread_id, author, body, created_at, ip_hash) VALUES (?, 'asker', ?, ?, ?)",
    ).bind(id, body, now, ipHash),
    env.DB.prepare('UPDATE threads SET updated_at = ?, awaiting_reply = 1 WHERE id = ?').bind(now, id),
  ]);

  ctx.waitUntil(notifyOwner(env, 'New follow-up', body, id));
  const [thread] = await withMessages(env, [await findThread(env, id)], 'asker');
  return json({ thread }, 201);
}

// The asker's browser keeps {id, token} pairs; this returns all of their threads at once.
async function lookupMine(request, env) {
  const input = await readJson(request);
  const items = Array.isArray(input.items) ? input.items.slice(0, MAX_PAGE_SIZE) : [];
  const owned = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9]{6,32}$/.test(item.id)) continue;
    const t = await findThread(env, item.id);
    if (t && (await askerTokenMatches(item.token, t))) owned.push(t);
  }
  owned.sort((a, b) => b.updated_at - a.updated_at);
  return json({ threads: await withMessages(env, owned, 'asker') });
}

// ---------- admin ----------

async function adminList(env, url) {
  const filter = url.searchParams.get('filter') || 'pending';
  const limit = clampInt(url.searchParams.get('limit'), PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1e9);
  const where = {
    pending: "status = 'open' AND awaiting_reply = 1",
    answered: "status = 'open' AND published_upto IS NOT NULL",
    hidden: "status = 'hidden'",
    all: '1 = 1',
  }[filter];
  if (!where) throw new HttpError(400, 'bad_filter', 'filter must be pending, answered, hidden or all');

  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM threads WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();

  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'open' AND awaiting_reply = 1 THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'open' AND published_upto IS NOT NULL THEN 1 ELSE 0 END) AS answered,
       SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden,
       COUNT(*) AS "all"
     FROM threads`,
  ).first();

  return json({
    threads: await withMessages(env, rows, 'owner'),
    counts: {
      pending: counts.pending ?? 0,
      answered: counts.answered ?? 0,
      hidden: counts.hidden ?? 0,
      all: counts.all ?? 0,
    },
    nextOffset: rows.length === limit ? offset + limit : null,
  });
}

async function adminUpdateThread(request, env, id) {
  const input = await readJson(request);
  if (!(await findThread(env, id))) throw new HttpError(404, 'not_found', 'Not found');

  const sets = [];
  const binds = [];
  if (input.status !== undefined) {
    if (!['open', 'hidden'].includes(input.status)) throw new HttpError(400, 'bad_status', 'status must be open or hidden');
    sets.push('status = ?');
    binds.push(input.status);
  }
  if (input.closed !== undefined) {
    sets.push('closed = ?');
    binds.push(input.closed ? 1 : 0);
  }
  if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Provide status and/or closed');

  await env.DB.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  const [thread] = await withMessages(env, [await findThread(env, id)], 'owner');
  return json({ thread });
}

async function adminDeleteThread(env, id) {
  if (!(await findThread(env, id))) throw new HttpError(404, 'not_found', 'Not found');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE thread_id = ?').bind(id),
    env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function adminEditMessage(request, env, messageId) {
  const input = await readJson(request);
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(messageId).first();
  if (!msg) throw new HttpError(404, 'not_found', 'Not found');
  if (msg.author !== 'owner') throw new HttpError(403, 'forbidden', "Only the owner's own replies can be edited");

  const body = cleanBody(input.body, env);
  await env.DB.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').bind(body, Date.now(), messageId).run();
  const [thread] = await withMessages(env, [await findThread(env, msg.thread_id)], 'owner');
  return json({ thread });
}

async function adminDeleteMessage(env, messageId) {
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(messageId).first();
  if (!msg) throw new HttpError(404, 'not_found', 'Not found');

  const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').bind(msg.thread_id).first('n');
  if (remaining <= 1) return adminDeleteThread(env, msg.thread_id);

  await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(messageId).run();
  await recomputeThread(env, msg.thread_id);
  const [thread] = await withMessages(env, [await findThread(env, msg.thread_id)], 'owner');
  return json({ thread });
}

async function recomputeThread(env, id) {
  const lastOwner = await env.DB.prepare(
    "SELECT id, created_at FROM messages WHERE thread_id = ? AND author = 'owner' ORDER BY id DESC LIMIT 1",
  ).bind(id).first();
  const last = await env.DB.prepare(
    'SELECT author FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1',
  ).bind(id).first();
  await env.DB.prepare(
    'UPDATE threads SET published_upto = ?, published_at = ?, awaiting_reply = ? WHERE id = ?',
  ).bind(lastOwner?.id ?? null, lastOwner?.created_at ?? null, last?.author === 'asker' ? 1 : 0, id).run();
}

// ---------- data helpers ----------

function findThread(env, id) {
  return env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first();
}

function isPublic(t) {
  return t.status === 'open' && t.published_upto != null;
}

async function withMessages(env, threadRows, view) {
  if (!threadRows.length) return [];
  const ids = threadRows.map((t) => t.id);
  const { results } = await env.DB.prepare(
    `SELECT id, thread_id, author, body, created_at, edited_at FROM messages
     WHERE thread_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`,
  ).bind(...ids).all();

  const byThread = new Map(ids.map((id) => [id, []]));
  for (const m of results) byThread.get(m.thread_id).push(m);
  return threadRows.map((t) => shapeThread(t, byThread.get(t.id), view));
}

function shapeThread(t, messages, view) {
  const visible = view === 'public' ? messages.filter((m) => m.id <= t.published_upto) : messages;
  const out = {
    id: t.id,
    createdAt: t.created_at,
    publishedAt: t.published_at,
    closed: !!t.closed,
    messages: visible.map((m) => ({
      id: m.id,
      author: m.author,
      body: m.body,
      createdAt: m.created_at,
      edited: m.edited_at != null,
    })),
  };
  if (view !== 'public') {
    out.updatedAt = t.updated_at;
    out.awaitingReply = !!t.awaiting_reply;
    out.public = isPublic(t);
    out.hidden = t.status === 'hidden';
  }
  if (view === 'owner') out.lang = t.lang;
  return out;
}

// ---------- validation, abuse protection ----------

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'bad_content_type', 'Send JSON');
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) throw new HttpError(413, 'too_large', 'Request too large');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, 'bad_json', 'Invalid JSON');
}

function cleanBody(raw, env) {
  if (typeof raw !== 'string') throw new HttpError(400, 'empty', 'Message is empty');
  const body = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!body) throw new HttpError(400, 'empty', 'Message is empty');
  if ([...body].length > limitOf(env, 'MAX_BODY_CHARS')) {
    throw new HttpError(400, 'too_long', `Message is longer than ${limitOf(env, 'MAX_BODY_CHARS')} characters`);
  }
  return body;
}

// Bots fill every field; the page keeps this one hidden from people.
function rejectHoneypot(input) {
  if (input.website) throw new HttpError(400, 'rejected', 'Rejected');
}

async function enforceRateLimits(env, ipHash, { newThread }) {
  const since = Date.now() - HOUR;
  if (newThread) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE ip_hash = ? AND created_at > ?').bind(ipHash, since).first('n');
    if (n >= limitOf(env, 'RATE_NEW_THREADS_PER_HOUR')) {
      throw new HttpError(429, 'rate_limited', 'Too many questions from your network, please try again later');
    }
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE ip_hash = ? AND created_at > ?').bind(ipHash, since).first('n');
  if (n >= limitOf(env, 'RATE_MESSAGES_PER_HOUR')) {
    throw new HttpError(429, 'rate_limited', 'Too many messages from your network, please try again later');
  }
}

async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET) return;
  if (typeof token !== 'string' || !token) throw new HttpError(400, 'captcha_required', 'Please complete the verification');

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new HttpError(400, 'captcha_failed', 'Verification failed, please try again');
}

function limitOf(env, name) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULTS[name];
}

// ---------- auth ----------

async function isAdmin(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/);
  if (!m || !env.ADMIN_TOKEN) return false;
  return timingSafeEqualStr(await sha256Hex(m[1]), await sha256Hex(env.ADMIN_TOKEN));
}

async function askerTokenMatches(token, thread) {
  if (typeof token !== 'string' || !token || token.length > 200) return false;
  return timingSafeEqualStr(await sha256Hex(token), thread.asker_token_hash);
}

function timingSafeEqualStr(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

// Raw IPs are never stored; a salted hash is enough for rate limiting.
async function hashIp(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return (await sha256Hex(`${env.IP_SALT || ''}|${ip}`)).slice(0, 32);
}

// ---------- notifications ----------

// Plain-text POST in the format ntfy.sh expects (https://ntfy.sh/<your-secret-topic>).
async function notifyOwner(env, title, body, threadId) {
  if (!env.NOTIFY_URL) return;
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: title };
  if (env.ADMIN_PAGE_URL) headers.Click = `${env.ADMIN_PAGE_URL}#${threadId}`;
  try {
    await fetch(env.NOTIFY_URL, { method: 'POST', headers, body: body.slice(0, 500) });
  } catch (err) {
    console.error('notify failed', err);
  }
}

// ---------- utils ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function corsHeaders(request, env) {
  const headers = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Asker-Token';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseCursor(raw) {
  return /^\d{1,15}$/.test(raw || '') ? Number(raw) : null;
}

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomId(length) {
  const out = [];
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && out.length < length) out.push(ALPHABET[b % 62]);
    }
  }
  return out.join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
