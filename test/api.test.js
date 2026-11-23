import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { boot } from './helpers/boot.js';
import { makeDeps, okInput, linksIn, signInput, META } from './helpers/deps.js';
import { makeFixtureMaster } from './helpers/fixture-master.js';
import { pngDataUrl } from './helpers/pdf.js';
import { createLocalAuth } from '../lib/auth-local.js';
import { createAuth } from '../lib/auth.js';

const USER = { id: '0b6f1c4e-1111-4000-8000-000000000001', email: 'jo@example.com', fullName: 'Jo Office', password: 'correct-horse-battery' };
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;

async function start(opts = {}) {
  const d = makeDeps(opts);
  const t = await boot({ ...d, auth: createLocalAuth([USER]), publicDir: path.resolve('public'), cronSecret: 'cron-secret', links: { keys: 'https://keys.example', windowCards: 'https://cards.example' } });
  const ip = freshIp();
  const call = (m, p, body, headers = {}) => t.call(m, p, body, { 'x-forwarded-for': ip, ...headers });
  async function login() {
    const r = await call('POST', '/api/auth/login', { email: 'JO@example.com', password: USER.password });
    assert.equal(r.status, 200);
    return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  }
  return { d, t, call, login };
}

test('staff routes need sign-in; wrong passwords fail; login is rate-limited; cross-origin writes are blocked', async () => {
  const { t, call, login } = await start();
  try {
    assert.equal((await call('GET', '/api/contracts')).status, 401);
    assert.equal((await call('GET', '/api/hub')).json.error, 'Sign in required');
    assert.equal((await call('POST', '/api/auth/login', { email: USER.email, password: 'nope' })).status, 401);
    const cookie = await login();
    const hub = await call('GET', '/api/hub', null, { cookie });
    assert.equal(hub.json.user.fullName, 'Jo Office'); assert.equal(hub.json.links.keys, 'https://keys.example');
    assert.equal((await call('POST', '/api/contracts', okInput(), { cookie, origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('POST', '/api/auth/logout', {}, { cookie })).status, 200);
    const ip = freshIp();
    for (let i = 0; i < 10; i++) await t.call('POST', '/api/auth/login', { email: USER.email, password: 'nope' }, { 'x-forwarded-for': ip });
    assert.equal((await t.call('POST', '/api/auth/login', { email: USER.email, password: USER.password }, { 'x-forwarded-for': ip })).status, 429);
  } finally { t.close(); }
});

test('full round trip over HTTP: master upload, signature, draft, send, open, sign', async () => {
  const { d, t, call, login } = await start();
  try {
    const cookie = await login();
    const up = await call('POST', '/api/templates/terms-of-sale', await makeFixtureMaster(), { cookie });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call('GET', `/api/templates/versions/${up.json.versionId}/sample.pdf`, null, { cookie })).headers.get('content-type'), 'application/pdf');
    assert.equal((await call('POST', `/api/templates/versions/${up.json.versionId}/activate`, {}, { cookie })).status, 200);
    assert.equal((await call('GET', '/api/templates', null, { cookie })).json[0].current, true);
    assert.equal((await call('PUT', '/api/me/signature', { png: 'nope' }, { cookie })).status, 400);
    assert.equal((await call('PUT', '/api/me/signature', { png: pngDataUrl() }, { cookie })).status, 200);
    assert.equal((await call('GET', '/api/me/signature', null, { cookie })).json.png, pngDataUrl());
    assert.equal((await call('PUT', '/api/settings', { officeCopyEmail: 'bad' }, { cookie })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { officeCopyEmail: 'office@example.com' }, { cookie })).status, 200);

    const bad = await call('POST', '/api/contracts', { ...okInput(), feePercent: 50 }, { cookie });
    assert.equal(bad.status, 400); assert.ok(bad.json.errors.feePercent);
    const created = await call('POST', '/api/contracts', okInput({ signers: 1 }), { cookie });
    assert.equal(created.status, 201);
    const id = created.json.id;
    const doc = await call('GET', `/api/contracts/${id}/document.pdf`, null, { cookie });
    assert.equal(doc.headers.get('content-type'), 'application/pdf');
    assert.match(doc.headers.get('content-disposition'), /^inline; filename="Terms of Sale - 12 Sample Road, Testville, AB1 2CD\.pdf"; filename\*=UTF-8''/);
    assert.equal((await call('POST', `/api/contracts/${id}/send`, {}, { cookie })).status, 200);
    const [token] = linksIn(d.mailer.sent);

    const view = await call('GET', `/api/sign/${token}`);
    assert.equal(view.status, 200); assert.equal(view.json.canSign, true);
    for (const h of ['referrer-policy', 'x-robots-tag', 'cache-control']) assert.ok(view.headers.get(h), h);
    assert.equal(view.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await call('GET', `/api/sign/${token}/document.pdf`)).headers.get('content-type'), 'application/pdf');
    const signed = await call('POST', `/api/sign/${token}`, signInput({ startMarketingNow: true }));
    assert.equal(signed.status, 200, signed.text); assert.equal(signed.json.allSigned, true);
    const det = await call('GET', `/api/contracts/${id}`, null, { cookie });
    assert.equal(det.json.state, 'signed'); assert.equal(det.json.signers[0].status, 'signed');
    const list = await call('GET', '/api/contracts?tab=signed&mine=1&q=anna', null, { cookie });
    assert.deepEqual(list.json.rows.map(r => r.id), [id]);
    assert.equal(d.mailer.sent.at(-1).to.includes('office@example.com'), true);
    assert.equal((await call('GET', '/api/sign/not-a-real-token')).status, 404);
  } finally { t.close(); }
});

test('office actions over HTTP: chase, cancel with a reason, fee change, seller cancellation', async () => {
  const { d, t, call, login } = await start();
  try {
    const cookie = await login();
    await d.seedTemplate();
    const { id } = await d.contracts.createDraft(d.user, okInput());
    await d.contracts.send(d.user, id);
    assert.deepEqual((await call('POST', `/api/contracts/${id}/chase`, {}, { cookie })).json, { emailed: 1 });
    assert.equal((await call('POST', `/api/contracts/${id}/chase`, {}, { cookie })).status, 429);
    assert.equal((await call('POST', `/api/contracts/${id}/cancel`, { reason: '' }, { cookie })).status, 400);
    assert.equal((await call('POST', `/api/contracts/${id}/cancel`, { reason: 'Withdrawn' }, { cookie })).status, 200);

    const { id: id2 } = await d.contracts.createDraft(d.user, okInput());
    await d.contracts.send(d.user, id2);
    await d.contracts.sign(linksIn(d.mailer.sent).at(-1), signInput({ startMarketingNow: false }), META);
    const fc = await call('POST', `/api/contracts/${id2}/fee-change`, { feePercent: 1.25, note: 'Agreed' }, { cookie });
    assert.equal(fc.status, 201); assert.ok(fc.json.id);
    assert.equal((await call('POST', `/api/contracts/${id2}/seller-cancelled`, { date: '2030-01-01' }, { cookie })).status, 409);
  } finally { t.close(); }
});

test('stale links: cancelled, expired, replaced, already signed, and old signed copies', async () => {
  const { d, t, call } = await start();
  try {
    await d.seedTemplate();
    const sendOne = async (signers = 1) => {
      const { id } = await d.contracts.createDraft(d.user, okInput({ signers }));
      const before = d.mailer.sent.length;
      await d.contracts.send(d.user, id);
      return { id, tokens: linksIn(d.mailer.sent.slice(before)) };
    };
    const expect = async (token, message) => {
      const r = await call('GET', `/api/sign/${token}`);
      assert.equal(r.status, 200); assert.equal(r.json.canSign, false); assert.equal(r.json.message, message);
      const s = await call('POST', `/api/sign/${token}`, signInput());
      assert.equal(s.status, 409); assert.equal(s.json.error, message);
    };
    const c = await sendOne(); await d.contracts.cancel(d.user, c.id, 'Withdrawn');
    await expect(c.tokens[0], 'This contract was cancelled by Berkeleys Drummond.');
    const a = await sendOne(2); await d.contracts.sign(a.tokens[0], signInput(), META);
    await expect(a.tokens[0], 'Thank you, you’ve signed. We’ll email the signed copy when everyone has signed.');
    const v1 = await sendOne(); await d.contracts.sign(v1.tokens[0], signInput(), META);
    const { id: v2 } = await d.contracts.startFeeChange(d.user, v1.id, { feePercent: 1.2 });
    const before = d.mailer.sent.length;
    await d.contracts.send(d.user, v2); await d.contracts.sign(linksIn(d.mailer.sent.slice(before))[0], signInput(), META);
    await expect(v1.tokens[0], 'This contract has been replaced by a newer version.');
    const old = await sendOne(); await d.contracts.sign(old.tokens[0], signInput(), META);
    assert.equal((await call('GET', `/api/sign/${old.tokens[0]}/document.pdf`)).status, 200);
    const e = await sendOne();
    d.clock.advanceDays(31);
    await d.contracts.runDaily();
    await expect(e.tokens[0], 'This link has expired. Please contact the office.');
    const gone = await call('GET', `/api/sign/${old.tokens[0]}/document.pdf`);
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error, 'The signed copy was emailed to you. Please contact the office for another copy.');
  } finally { t.close(); }
});

test('daily cron needs the secret; public routes are rate-limited', async () => {
  const { t, call } = await start();
  try {
    assert.equal((await call('GET', '/api/cron/daily')).status, 401);
    assert.equal((await call('GET', '/api/cron/daily', null, { authorization: 'Bearer wrong' })).status, 401);
    assert.deepEqual((await call('GET', '/api/cron/daily', null, { authorization: 'Bearer cron-secret' })).json, { reminded: 0, expired: 0, refreshed: 0 });
    const ip = freshIp();
    for (let i = 0; i < 30; i++) await t.call('GET', '/api/sign/abc', null, { 'x-forwarded-for': ip });
    const r = await t.call('GET', '/api/sign/abc', null, { 'x-forwarded-for': ip });
    assert.equal(r.status, 429); assert.equal(r.json.error, 'Too many requests. Please wait a minute.');
  } finally { t.close(); }
});

test('signing page is served with no-referrer and noindex headers', async () => {
  const { t, call } = await start();
  try {
    fs.mkdirSync('public', { recursive: true });
    const r = await call('GET', '/s/abc123');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  } finally { t.close(); }
});

// --- Supabase sign-in, with a fake fetch ---
function supabaseFake({ row }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === '/auth/v1/token') return new Response(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', user: { id: 'u1', email: 'jo@example.com' } }), { status: 200 });
    if (u.pathname === '/rest/v1/key_users') return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    if (u.pathname === '/rest/v1/key_security_log') return new Response(null, { status: 201 });
    return new Response('{}', { status: 404 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('Supabase sign-in: needs an active key_users row, sets bo_ cookies, logs to key_security_log', async () => {
  const none = createAuth({ url: 'https://abc.supabase.co', serviceKey: 'k', fetchImpl: supabaseFake({ row: null }) });
  await assert.rejects(none.login('jo@example.com', 'pw'), e => e.status === 403 && e.message === 'Your account is not set up. Ask Lewis.');
  const off = createAuth({ url: 'https://abc.supabase.co', serviceKey: 'k', fetchImpl: supabaseFake({ row: { id: 'u1', email: 'jo@example.com', full_name: 'Jo Office', active: false } }) });
  await assert.rejects(off.login('jo@example.com', 'pw'), e => e.status === 403 && e.message === 'This account is disabled.');
  const f = supabaseFake({ row: { id: 'u1', email: 'jo@example.com', full_name: 'Jo Office', active: true } });
  const ok = createAuth({ url: 'https://abc.supabase.co', serviceKey: 'k', fetchImpl: f });
  const r = await ok.login('jo@example.com', 'pw');
  assert.deepEqual(r.user, { id: 'u1', email: 'jo@example.com', fullName: 'Jo Office' });
  assert.deepEqual(r.cookies.map(c => c.split('=')[0]), ['bo_session', 'bo_refresh']);
  assert.ok(r.cookies.every(c => /HttpOnly/.test(c) && /SameSite=Strict/.test(c)));
  const log = f.calls.find(c => c.path === '/rest/v1/key_security_log');
  assert.equal(log.body.action, 'office.login.success');
});

test('hosted entry reports missing settings; vercel.json has the cron and the signing rewrite', async () => {
  const { default: handler } = await import('../api/index.js');
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /missing SUPABASE_URL/);
  } finally { server.close(); }
  const v = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
  assert.deepEqual(v.crons, [{ path: '/api/cron/daily', schedule: '0 8 * * *' }]);
  assert.ok(v.rewrites.some(x => x.source === '/s/:token' && x.destination === '/sign.html'));
  assert.ok(v.rewrites.some(x => x.source === '/api/(.*)' && x.destination === '/api/index.js'));
});
