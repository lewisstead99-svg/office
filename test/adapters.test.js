import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMemoryStore } from '../lib/store-memory.js';
import { createSupabaseStore } from '../lib/store-supabase.js';
import { ConflictError } from '../lib/store-errors.js';
import { createMemoryBlobs, createSupabaseBlobs } from '../lib/blobs.js';
import { createMemoryMailer, createResendMailer } from '../lib/mailer.js';
import { signingRequestEmail, reminderEmail, signedCopyEmail, cancelledEmail, expiredNoticeEmail } from '../lib/emails.js';

const contract = (over = {}) => ({
  id: 'c1', familyId: 'c1', version: 1, kind: 'new', replacesId: null, templateVersionId: null,
  fields: { propertyAddress: '12 Sample Road', basis: 'sole', otherAgent: null, feePercent: 1.5, guidePrice: 1250000 },
  note: null, createdBy: { id: 'u1', name: 'Jo Office' }, sender: null, presentedPath: null, presentedSha256: null,
  finalPath: null, finalSha256: null, state: 'draft', rev: 1, createdAt: '2026-11-23T10:00:00Z', sentAt: null, completedAt: null, ...over,
});
const signer = (over = {}) => ({ id: 's1', contractId: 'c1', position: 0, name: 'Anna Example', email: 'anna@example.com', mobile: '07700900123',
  sharedEmail: false, status: 'pending', signedAt: null, signaturePng: null, initials: null, startMarketingNow: null, ...over });
const event = (over = {}) => ({ contractId: 'c1', signerId: null, type: 'created', at: '2026-11-23T10:00:00Z', actorId: null, actorEmail: null, ip: null, userAgent: null, data: {}, ...over });

test('memory store: commit then read back, sorted', async () => {
  const s = createMemoryStore();
  await s.commit({ contracts: [contract()], signers: [signer({ id: 's2', position: 1, name: 'Ben' }), signer()], events: [event(), event({ type: 'sent' })] });
  const got = await s.getContract('c1');
  assert.equal(got.contract.fields.feePercent, 1.5);
  assert.deepEqual(got.signers.map(x => x.id), ['s1', 's2']);
  assert.deepEqual(got.events.map(e => e.type), ['created', 'sent']);
  assert.ok(got.events[0].id < got.events[1].id);
  got.contract.fields.feePercent = 99;                      // callers cannot mutate stored data
  assert.equal((await s.getContract('c1')).contract.fields.feePercent, 1.5);
  assert.equal(await s.getContract('nope'), null);
});

test('memory store: stale rev throws ConflictError and saves nothing', async () => {
  const s = createMemoryStore();
  await s.commit({ contracts: [contract()] });
  await s.commit({ contracts: [contract({ rev: 2, state: 'out' })], events: [event({ type: 'sent' })] });
  await assert.rejects(s.commit({ contracts: [contract({ rev: 2, state: 'cancelled' })], events: [event({ type: 'cancelled' })] }), ConflictError);
  const got = await s.getContract('c1');
  assert.equal(got.contract.state, 'out');
  assert.deepEqual(got.events.map(e => e.type), ['sent']);
  await assert.rejects(s.commit({ contracts: [contract({ id: 'c9', rev: 3 })] }), ConflictError);   // unknown contract, rev > 1
});

test('memory store: commit can remove sellers from a draft', async () => {
  const s = createMemoryStore();
  await s.commit({ contracts: [contract()], signers: [signer(), signer({ id: 's2', position: 1 })] });
  await s.commit({ contracts: [contract({ rev: 2 })], removeSignerIds: ['s2'] });
  assert.deepEqual((await s.getContract('c1')).signers.map(x => x.id), ['s1']);
});

test('memory store: every token for a signer resolves to the whole contract', async () => {
  const s = createMemoryStore();
  await s.commit({ contracts: [contract()], signers: [signer()], tokens: [{ hash: 'h1', signerId: 's1' }] });
  await s.commit({ contracts: [contract({ rev: 2 })], tokens: [{ hash: 'h2', signerId: 's1' }] });
  for (const h of ['h1', 'h2']) {
    const r = await s.findByTokenHash(h);
    assert.equal(r.signer.id, 's1'); assert.equal(r.contract.id, 'c1'); assert.equal(r.signers.length, 1);
  }
  assert.equal(await s.findByTokenHash('h3'), null);
});

test('memory store: lists, counts, family, templates, settings, signatures', async () => {
  const s = createMemoryStore();
  await s.commit({ contracts: [contract({ state: 'out', createdAt: '2026-11-20T10:00:00Z' }), contract({ id: 'c2', familyId: 'c1', version: 2, state: 'draft', createdAt: '2026-11-22T10:00:00Z' }), contract({ id: 'c3', familyId: 'c3', state: 'out', createdAt: '2026-11-23T10:00:00Z' })],
    signers: [signer(), signer({ id: 's3', contractId: 'c3' })], events: [event({ type: 'sent' })] });
  assert.deepEqual((await s.listContracts({ states: ['out'] })).map(r => r.contract.id), ['c3', 'c1']);
  assert.equal((await s.listContracts({ states: ['out'] }))[1].signers[0].id, 's1');
  assert.deepEqual(await s.countByState(), { out: 2, draft: 1 });
  assert.deepEqual((await s.getFamily('c1')).map(c => c.version), [1, 2]);
  assert.equal((await s.listWithEvents(['out'])).find(r => r.contract.id === 'c1').events.length, 1);

  await s.addTemplateVersion({ id: 't1', templateId: 'terms-of-sale', version: 1, path: 'templates/t1.pdf', sha256: 'x', bytes: 10, fieldRects: {}, uploadedBy: { id: 'u1', name: 'Jo' }, uploadedAt: '2026-11-23T10:00:00Z', activatedAt: null });
  assert.equal(await s.currentTemplateVersion('terms-of-sale'), null);
  await s.activateTemplateVersion('t1', '2026-11-23T11:00:00Z');
  assert.equal((await s.currentTemplateVersion('terms-of-sale')).id, 't1');
  await s.addTemplateVersion({ id: 't2', templateId: 'terms-of-sale', version: 2, path: 'p', sha256: 'y', bytes: 1, fieldRects: {}, uploadedBy: null, uploadedAt: '2026-11-24T10:00:00Z', activatedAt: null });
  assert.equal((await s.currentTemplateVersion('terms-of-sale')).id, 't1');     // unactivated upload ignored
  assert.deepEqual((await s.listTemplateVersions('terms-of-sale')).map(v => v.version), [2, 1]);

  assert.deepEqual(await s.getSettings(), { officeCopyEmail: null });
  await s.saveSettings({ officeCopyEmail: 'office@example.com' });
  assert.equal((await s.getSettings()).officeCopyEmail, 'office@example.com');
  assert.equal(await s.getSignature('u1'), null);
  await s.saveSignature('u1', 'data:image/png;base64,AAA');
  assert.equal(await s.getSignature('u1'), 'data:image/png;base64,AAA');
});

// --- Supabase store: request and response shapes ---
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname, search: decodeURIComponent(u.search), body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const hit = routes.find(r => (r.method || 'GET') === (init.method || 'GET') && u.pathname === r.path && (!r.match || r.match(decodeURIComponent(u.search))));
    const res = hit ? hit.reply : { status: 404, body: { message: 'no route' } };
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status || 200 });
  };
  fn.calls = calls;
  return fn;
}

test('supabase store: commit posts snake_case rows to bo_commit and maps bo_conflict', async () => {
  const f = fakeFetch([{ method: 'POST', path: '/rest/v1/rpc/bo_commit', reply: { status: 204 } }]);
  const s = createSupabaseStore({ url: 'https://abc.supabase.co', key: 'k', fetchImpl: f });
  await s.commit({ contracts: [contract()], signers: [signer()], events: [event()], tokens: [{ hash: 'h', signerId: 's1' }] });
  const call = f.calls[0];
  assert.equal(call.headers.Authorization, 'Bearer k');
  assert.equal(call.body.p_contracts[0].family_id, 'c1');
  assert.deepEqual(call.body.p_contracts[0].fields, contract().fields);         // jsonb contents untouched
  assert.equal(call.body.p_contracts[0].created_by.name, 'Jo Office');
  assert.equal(call.body.p_signers[0].start_marketing_now, null);
  assert.equal(call.body.p_tokens[0].signer_id, 's1');
  assert.equal(call.body.p_events[0].contract_id, 'c1');
  assert.deepEqual(call.body.p_remove_signers, []);

  const g = fakeFetch([{ method: 'POST', path: '/rest/v1/rpc/bo_commit', reply: { status: 400, body: { message: 'bo_conflict' } } }]);
  await assert.rejects(createSupabaseStore({ url: 'https://abc.supabase.co', key: 'k', fetchImpl: g }).commit({ contracts: [contract({ rev: 2 })] }), ConflictError);
});

test('supabase store: getContract, findByTokenHash, lists and counts map rows back', async () => {
  const row = { id: 'c1', family_id: 'c1', version: 1, kind: 'new', fields: { feePercent: 1.5 }, created_by: { id: 'u1' }, state: 'out', rev: 2, created_at: '2026-11-23T10:00:00Z',
    signers: [{ id: 's2', contract_id: 'c1', position: 1, start_marketing_now: null }, { id: 's1', contract_id: 'c1', position: 0, start_marketing_now: true }],
    events: [{ id: 7, contract_id: 'c1', type: 'sent', data: {} }, { id: 3, contract_id: 'c1', type: 'created', data: {} }] };
  const f = fakeFetch([
    { path: '/rest/v1/bo_contracts', match: q => q.includes('id=eq.c1'), reply: { body: [row] } },
    { path: '/rest/v1/bo_contracts', match: q => q.includes('state=in.(out,cooling)'), reply: { body: [row] } },
    { path: '/rest/v1/bo_signer_tokens', match: q => q.includes('hash=eq.h1'), reply: { body: [{ signer_id: 's1', signer: { contract_id: 'c1' } }] } },
    { method: 'POST', path: '/rest/v1/rpc/bo_state_counts', reply: { body: [{ state: 'out', n: 2 }, { state: 'draft', n: 1 }] } },
  ]);
  const s = createSupabaseStore({ url: 'https://abc.supabase.co', key: 'k', fetchImpl: f });
  const got = await s.getContract('c1');
  assert.equal(got.contract.familyId, 'c1'); assert.equal(got.contract.createdBy.id, 'u1');
  assert.deepEqual(got.signers.map(x => x.id), ['s1', 's2']); assert.equal(got.signers[0].startMarketingNow, true);
  assert.deepEqual(got.events.map(e => e.id), [3, 7]);
  assert.equal(got.contract.signers, undefined);
  assert.equal((await s.findByTokenHash('h1')).signer.id, 's1');
  const list = await s.listContracts({ states: ['out', 'cooling'] });
  assert.equal(list[0].contract.id, 'c1'); assert.equal(list[0].signers.length, 2);
  assert.deepEqual(await s.countByState(), { out: 2, draft: 1 });
});

test('supabase store: list queries do not fetch signature images', async () => {
  const f = fakeFetch([{ path: '/rest/v1/bo_contracts', reply: { body: [] } }]);
  const s = createSupabaseStore({ url: 'https://abc.supabase.co', key: 'k', fetchImpl: f });
  await s.listContracts({ states: ['signed'] });
  await s.listWithEvents(['out', 'cooling']);
  for (const c of f.calls) {
    assert.ok(c.search.includes('signers:bo_signers('), c.search);
    assert.ok(!c.search.includes('bo_signers(*)'), c.search);
    assert.ok(!c.search.includes('signature_png'), c.search);
  }
});

test('SETUP-SUPABASE.sql is additive and only touches bo_ tables', () => {
  const sql = fs.readFileSync('SETUP-SUPABASE.sql', 'utf8').toLowerCase().replace(/--.*$/gm, '');
  assert.ok(!/drop\s+table/.test(sql));
  assert.ok(!/(alter|drop|truncate|delete\s+from|update)\s+(table\s+)?(public\.)?key_/.test(sql));
  assert.ok(!/insert\s+into\s+(public\.)?key_/.test(sql));
  const tables = [...sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+(?:public\.)?(\w+)/g)].map(m => m[1]);
  assert.deepEqual(tables.sort(), ['bo_contracts', 'bo_events', 'bo_settings', 'bo_signer_tokens', 'bo_signers', 'bo_template_versions', 'bo_user_signatures']);
  for (const t of tables) assert.match(sql, new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`), t);
  assert.match(sql, /function\s+public\.bo_commit\(p_contracts jsonb, p_signers jsonb, p_events jsonb, p_tokens jsonb, p_remove_signers jsonb\)/);
  assert.match(sql, /delete\s+from\s+bo_signers/);
  assert.match(sql, /revoke\s+execute\s+on\s+function\s+public\.bo_commit/);
  assert.match(sql, /insert\s+into\s+storage\.buckets/);
});

test('memory blobs round-trip; supabase blobs use the storage API', async () => {
  const b = createMemoryBlobs();
  await b.put('contracts/c1/final.pdf', new Uint8Array([1, 2, 3]));
  assert.deepEqual([...(await b.get('contracts/c1/final.pdf'))], [1, 2, 3]);
  await b.del('contracts/c1/final.pdf');
  assert.equal(await b.get('contracts/c1/final.pdf'), null);

  const f = fakeFetch([
    { method: 'POST', path: '/storage/v1/object/contracts/contracts/c1/final.pdf', reply: { body: { Key: 'x' } } },
    { path: '/storage/v1/object/contracts/contracts/c1/final.pdf', reply: { body: 'pdf' } },
    { path: '/storage/v1/object/contracts/missing.pdf', reply: { status: 400, body: { statusCode: '404', error: 'not_found' } } },
    { method: 'DELETE', path: '/storage/v1/object/contracts', reply: { body: [] } },
  ]);
  const s = createSupabaseBlobs({ url: 'https://abc.supabase.co', key: 'k', fetchImpl: f });
  await s.put('contracts/c1/final.pdf', new Uint8Array([1]));
  assert.equal(f.calls[0].headers['x-upsert'], 'true');
  assert.equal(f.calls[0].headers['content-type'], 'application/pdf');
  assert.ok((await s.get('contracts/c1/final.pdf')).length > 0);
  assert.equal(await s.get('missing.pdf'), null);
  await s.del('contracts/c1/final.pdf');
  assert.deepEqual(f.calls.at(-1).body, { prefixes: ['contracts/c1/final.pdf'] });
});

test('memory mailer records and can fail on demand', async () => {
  const m = createMemoryMailer();
  m.failNext(1);
  await assert.rejects(m.send({ to: ['a@example.com'], subject: 'x', text: 'x', html: 'x' }));
  await m.send({ to: ['a@example.com'], subject: 'y', text: 'y', html: 'y' });
  assert.deepEqual(m.sent.map(x => x.subject), ['y']);
});

test('resend mailer posts the documented body with base64 attachments', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'e1' }), { status: 200 }); };
  const m = createResendMailer({ apiKey: 'key', from: 'Berkeleys Drummond <contracts@example.com>', fetchImpl });
  assert.deepEqual(await m.send({ to: ['a@example.com'], subject: 'S', text: 'T', html: '<p>T</p>', attachments: [{ filename: 'a.pdf', content: new Uint8Array([1, 2]) }] }), { id: 'e1' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer key');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { from: 'Berkeleys Drummond <contracts@example.com>', to: ['a@example.com'], subject: 'S', text: 'T', html: '<p>T</p>', attachments: [{ filename: 'a.pdf', content: 'AQI=' }] });
  const bad = createResendMailer({ apiKey: 'k', from: 'f', fetchImpl: async () => new Response('{"message":"nope"}', { status: 422 }) });
  await assert.rejects(bad.send({ to: ['a@example.com'], subject: 'S', text: 'T', html: 'T' }), /Email failed/);
});

test('email copy: subjects, escaping and links', () => {
  const link = 'https://office.example/s/abc';
  const e = signingRequestEmail({ signerName: '<script>x</script>', propertyAddress: '12 Sample Road', senderName: 'Jo Office', link, kind: 'new' });
  assert.equal(e.subject, 'Please sign: Terms of Sale for 12 Sample Road');
  assert.ok(!e.html.includes('<script>')); assert.ok(e.html.includes('&lt;script&gt;'));
  assert.ok(e.html.includes(link)); assert.ok(e.text.includes(link));
  assert.equal(signingRequestEmail({ signerName: 'A', propertyAddress: '12 Sample Road', senderName: 'Jo', link, kind: 'fee_change' }).subject, 'Please sign: updated fee for 12 Sample Road');
  assert.equal(reminderEmail({ signerName: 'A', propertyAddress: '12 Sample Road', senderName: 'Jo', link, kind: 'new' }).subject, 'Reminder: please sign the Terms of Sale for 12 Sample Road');
  assert.equal(signedCopyEmail({ propertyAddress: '12 Sample Road', ref: 'ABCD1234' }).subject, 'Signed: Terms of Sale for 12 Sample Road');
  assert.equal(cancelledEmail({ signerName: 'A', propertyAddress: '12 Sample Road' }).subject, 'Cancelled: Terms of Sale for 12 Sample Road');
  assert.equal(expiredNoticeEmail({ propertyAddress: '12 Sample Road' }).subject, 'Expired unsigned: 12 Sample Road');
  assert.match(signedCopyEmail({ propertyAddress: 'x', ref: 'R' }).text, /01202 708383/);
});
