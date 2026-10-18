// End-to-end tests: start `wrangler dev` on a throwaway local D1 database and
// exercise the API over HTTP. Run with `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'test-admin-token';
const NEW_THREAD_LIMIT = 20; // the tests before the rate-limit test create ~11 threads
const MAX_PENDING = 3;

let server;
let persistDir;

before(async () => {
  persistDir = mkdtempSync(join(tmpdir(), 'askbox-test-'));
  const migrate = spawnSync(
    process.execPath,
    [WRANGLER, 'd1', 'migrations', 'apply', 'askbox', '--local', '--persist-to', persistDir],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  );
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  server = spawn(
    process.execPath,
    [
      WRANGLER, 'dev', '--local', '--persist-to', persistDir, '--port', String(PORT), '--ip', '127.0.0.1',
      '--var', `ADMIN_TOKEN:${ADMIN}`,
      '--var', 'IP_SALT:test-salt',
      '--var', `RATE_NEW_THREADS_PER_HOUR:${NEW_THREAD_LIMIT}`,
      '--var', 'RATE_MESSAGES_PER_HOUR:1000',
      '--var', `MAX_PENDING_PER_THREAD:${MAX_PENDING}`,
      '--var', 'MAX_BODY_CHARS:200',
    ],
    { cwd: ROOT, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log}`);
});

after(() => {
  server?.kill();
  try { rmSync(persistDir, { recursive: true, force: true }); } catch {}
});

async function api(method, path, { body, admin, asker, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (admin) h.Authorization = `Bearer ${admin === true ? ADMIN : admin}`;
  if (asker) h['X-Asker-Token'] = asker;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

const ask = (text, extra = {}) => api('POST', '/api/threads', { body: { body: text, lang: 'zh', ...extra } });
const reply = (id, text) => api('POST', `/api/threads/${id}/messages`, { body: { body: text }, admin: true });
const followUp = (id, token, text) => api('POST', `/api/threads/${id}/messages`, { body: { body: text }, asker: token });

test('health', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test('question lifecycle: private until answered, follow-ups public only after the next reply', async () => {
  const created = await ask('  你最喜欢哪座城市？  ');
  assert.equal(created.status, 201);
  const { thread, askerToken } = created.data;
  assert.ok(askerToken.length >= 40);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].body, '你最喜欢哪座城市？', 'body is trimmed');
  assert.equal(thread.awaitingReply, true);
  assert.equal(thread.public, false);
  const id = thread.id;

  // Not visible to the public yet.
  assert.equal((await api('GET', `/api/threads/${id}`)).status, 404);
  assert.ok(!(await api('GET', '/api/threads')).data.threads.some((t) => t.id === id));
  // Visible to the asker.
  const mine = await api('GET', `/api/threads/${id}`, { asker: askerToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.thread.messages.length, 1);
  // A wrong token is just the public view (404 here).
  assert.equal((await api('GET', `/api/threads/${id}`, { asker: 'nope' })).status, 404);

  // Asker adds a detail before any reply.
  assert.equal((await followUp(id, askerToken, '补充：地球上的')).status, 201);

  // Owner answers -> thread and both asker messages become public.
  const answered = await reply(id, '南京。');
  assert.equal(answered.status, 201);
  assert.equal(answered.data.thread.awaitingReply, false);
  let pub = await api('GET', `/api/threads/${id}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.data.thread.messages.map((m) => m.author), ['asker', 'asker', 'owner']);
  assert.equal(pub.data.thread.awaitingReply, undefined, 'public view does not expose moderation fields');

  // Follow-up after the answer: asker sees it, public does not.
  const fu = await followUp(id, askerToken, '为什么是南京？');
  assert.equal(fu.status, 201);
  assert.equal(fu.data.thread.messages.length, 4);
  assert.equal(fu.data.thread.awaitingReply, true);
  pub = await api('GET', `/api/threads/${id}`);
  assert.equal(pub.data.thread.messages.length, 3);

  // Next reply publishes it.
  await reply(id, '因为那里有梧桐。');
  pub = await api('GET', `/api/threads/${id}`);
  assert.deepEqual(pub.data.thread.messages.map((m) => m.body), ['你最喜欢哪座城市？', '补充：地球上的', '南京。', '为什么是南京？', '因为那里有梧桐。']);

  const list = await api('GET', '/api/threads');
  assert.ok(list.data.threads.some((t) => t.id === id));
  assert.ok(list.data.total >= 1);
});

test('only the asker can follow up, and only the owner can reply as owner', async () => {
  const { thread } = (await ask('谁可以回复？')).data;
  const id = thread.id;
  const noToken = await api('POST', `/api/threads/${id}/messages`, { body: { body: 'hi' } });
  assert.equal(noToken.status, 401);
  const wrongToken = await followUp(id, 'not-the-token', 'hi');
  assert.equal(wrongToken.status, 401);
  const wrongAdmin = await api('POST', `/api/threads/${id}/messages`, { body: { body: 'hi' }, admin: 'wrong-admin' });
  assert.equal(wrongAdmin.status, 401);
  const anotherAsker = (await ask('另一个人')).data.askerToken;
  assert.equal((await followUp(id, anotherAsker, '冒充')).status, 401);
});

test('validation: empty, too long, honeypot, bad JSON', async () => {
  assert.equal((await ask('   ')).status, 400);
  assert.equal((await ask('x'.repeat(201))).status, 400);
  assert.equal((await ask('ok'.repeat(100))).status, 201, '200 chars is allowed');
  assert.equal((await ask('hello', { website: 'http://spam' })).status, 400);
  const res = await fetch(`${BASE}/api/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  const notJson = await fetch(`${BASE}/api/threads`, { method: 'POST', body: 'body=hi' });
  assert.equal(notJson.status, 415);
});

test('pending streak limit stops an asker from flooding an unanswered thread', async () => {
  const { thread, askerToken } = (await ask('第一条')).data;
  for (let i = 1; i < MAX_PENDING; i++) assert.equal((await followUp(thread.id, askerToken, `第${i + 1}条`)).status, 201);
  assert.equal((await followUp(thread.id, askerToken, '太多了')).status, 429);
  await reply(thread.id, '收到');
  assert.equal((await followUp(thread.id, askerToken, '谢谢')).status, 201, 'a reply resets the streak');
});

test('lookup returns only threads whose token matches', async () => {
  const a = (await ask('A')).data;
  const b = (await ask('B')).data;
  const r = await api('POST', '/api/threads/lookup', {
    body: { items: [{ id: a.thread.id, token: a.askerToken }, { id: b.thread.id, token: 'wrong' }, { id: '../etc', token: 'x' }] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.threads.map((t) => t.id), [a.thread.id]);
});

test('admin endpoints require the admin token', async () => {
  assert.equal((await api('GET', '/api/admin/threads')).status, 401);
  assert.equal((await api('GET', '/api/admin/threads', { admin: 'wrong' })).status, 401);
  const r = await api('GET', '/api/admin/threads?filter=pending', { admin: true });
  assert.equal(r.status, 200);
  assert.ok(r.data.counts.pending >= 1);
  assert.ok(r.data.threads.every((t) => t.awaitingReply && !t.hidden));
  assert.equal((await api('GET', '/api/admin/threads?filter=bogus', { admin: true })).status, 400);
});

test('hide, close, edit and delete', async () => {
  const { thread, askerToken } = (await ask('可以隐藏吗？')).data;
  const id = thread.id;
  await reply(id, '可以。');
  assert.equal((await api('GET', `/api/threads/${id}`)).status, 200);

  // Hide: gone from public, asker cannot continue.
  assert.equal((await api('PATCH', `/api/admin/threads/${id}`, { admin: true, body: { status: 'hidden' } })).status, 200);
  assert.equal((await api('GET', `/api/threads/${id}`)).status, 404);
  assert.ok(!(await api('GET', '/api/threads')).data.threads.some((t) => t.id === id));
  assert.equal((await followUp(id, askerToken, '还在吗')).status, 403);
  await api('PATCH', `/api/admin/threads/${id}`, { admin: true, body: { status: 'open' } });
  assert.equal((await api('GET', `/api/threads/${id}`)).status, 200);

  // Close: still public, but no more follow-ups.
  await api('PATCH', `/api/admin/threads/${id}`, { admin: true, body: { closed: true } });
  assert.equal((await followUp(id, askerToken, '还在吗')).status, 403);
  assert.equal((await api('GET', `/api/threads/${id}`)).data.thread.closed, true);
  await api('PATCH', `/api/admin/threads/${id}`, { admin: true, body: { closed: false } });

  // Edit an owner reply; asker messages cannot be edited.
  const full = (await api('GET', `/api/threads/${id}`, { admin: true })).data.thread;
  const ownerMsg = full.messages.find((m) => m.author === 'owner');
  const askerMsg = full.messages.find((m) => m.author === 'asker');
  const edited = await api('PATCH', `/api/admin/messages/${ownerMsg.id}`, { admin: true, body: { body: '当然可以。' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.thread.messages.find((m) => m.id === ownerMsg.id).edited, true);
  assert.equal((await api('PATCH', `/api/admin/messages/${askerMsg.id}`, { admin: true, body: { body: 'x' } })).status, 403);

  // Deleting the only owner reply makes the thread private again.
  const del = await api('DELETE', `/api/admin/messages/${ownerMsg.id}`, { admin: true });
  assert.equal(del.status, 200);
  assert.equal(del.data.thread.public, false);
  assert.equal(del.data.thread.awaitingReply, true);
  assert.equal((await api('GET', `/api/threads/${id}`)).status, 404);

  // Delete the thread.
  assert.equal((await api('DELETE', `/api/admin/threads/${id}`, { admin: true })).status, 200);
  assert.equal((await api('GET', `/api/threads/${id}`, { admin: true })).status, 404);
});

test('public list paginates newest answer first', async () => {
  const ids = [];
  for (const q of ['P1', 'P2', 'P3']) {
    const { thread } = (await ask(q)).data;
    await reply(thread.id, `answer ${q}`);
    ids.push(thread.id);
  }
  const first = await api('GET', '/api/threads?limit=2');
  assert.equal(first.data.threads.length, 2);
  assert.deepEqual(first.data.threads.map((t) => t.id), [ids[2], ids[1]]);
  assert.ok(first.data.nextCursor);
  const second = await api('GET', `/api/threads?limit=2&cursor=${first.data.nextCursor}`);
  assert.equal(second.data.threads[0].id, ids[0]);
});

test('CORS allows the site origins only', async () => {
  const ok = await fetch(`${BASE}/api/threads`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:1313', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'http://localhost:1313');
  const bad = await fetch(`${BASE}/api/threads`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

// Keep last: it uses up this IP's new-question allowance.
test('rate limit on new questions per network', async () => {
  let status;
  for (let i = 0; i < NEW_THREAD_LIMIT + 1; i++) {
    status = (await ask(`rate ${i}`)).status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
});
