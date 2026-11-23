// Fixes for the minor findings from the final review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDeps, faultyStore, okInput, linksIn, signInput, META } from './helpers/deps.js';
import { validateDraft } from '../lib/validate.js';
import { TERMS_OF_SALE } from '../lib/templates.js';

async function sent(d, { signers = 1 } = {}) {
  if (!(await d.store.currentTemplateVersion('terms-of-sale'))) await d.seedTemplate();
  const { id } = await d.contracts.createDraft(d.user, okInput({ signers }));
  const before = d.mailer.sent.length;
  await d.contracts.send(d.user, id);
  return { id, tokens: linksIn(d.mailer.sent.slice(before)) };
}

test('an email failure is still recorded when the save meets a busy moment', async () => {
  const d = makeDeps({ wrapStore: faultyStore }); await d.seedTemplate();
  const { id } = await d.contracts.createDraft(d.user, okInput());
  d.mailer.send = async () => { d.store.conflictNext(1); throw new Error('Email failed: provider down'); };
  await assert.rejects(d.contracts.send(d.user, id), e => e.status === 502);
  assert.equal((await d.store.getContract(id)).events.filter(e => e.type === 'email_failed').length, 1);
});

test('a failed signed-copy email does not upset the seller, is flagged, and can be sent again', async () => {
  const d = makeDeps(); const { id, tokens } = await sent(d);
  const send = d.mailer.send.bind(d.mailer);
  d.mailer.send = async msg => { if (msg.subject.startsWith('Signed:')) throw new Error('Email failed: down'); return send(msg); };
  assert.deepEqual(await d.contracts.sign(tokens[0], signInput(), META), { allSigned: true });
  const failed = (await d.store.getContract(id)).events.find(e => e.type === 'email_failed');
  assert.equal(failed.data.kind, 'signed_copy');
  assert.equal((await d.contracts.detail(id)).emailProblem, 'signed_copy');
  d.mailer.send = send;
  await d.contracts.resendSignedCopy(d.user, id);
  const last = d.mailer.sent.at(-1);
  assert.match(last.subject, /^Signed:/); assert.equal(last.attachments.length, 1);
  assert.equal((await d.contracts.detail(id)).emailProblem, null);
  const out = await sent(d);
  await assert.rejects(d.contracts.resendSignedCopy(d.user, out.id), e => e.status === 409);
});

test('a settings read failing after the last signature does not fail the signing', async () => {
  const d = makeDeps({ wrapStore: faultyStore }); const { tokens } = await sent(d);
  d.store.throwOnSettings(new Error('settings unavailable'));
  assert.deepEqual(await d.contracts.sign(tokens[0], signInput(), META), { allSigned: true });
});

test('the email-problem flag clears after a successful chase', async () => {
  const d = makeDeps(); const { id } = await sent(d);
  d.mailer.failNext(1);
  await assert.rejects(d.contracts.chase(d.user, id), e => e.status === 502);
  assert.equal((await d.contracts.detail(id)).emailProblem, 'signing');
  await d.contracts.chase(d.user, id);
  assert.equal((await d.contracts.detail(id)).emailProblem, null);
});

test('a signing that keeps meeting busy moments says it can be retried', async () => {
  const d = makeDeps({ wrapStore: faultyStore }); const { tokens } = await sent(d);
  d.store.conflictNext(2);
  await assert.rejects(d.contracts.sign(tokens[0], signInput(), META), e => e.status === 409 && e.extra?.retry === true);
  assert.deepEqual(await d.contracts.sign(tokens[0], signInput(), META), { allSigned: true });
});

test('addresses are capped so they fit on the contract; control characters are removed', () => {
  const base = okInput();
  assert.equal(validateDraft({ ...base, propertyAddress: 'x'.repeat(121) }, TERMS_OF_SALE).errors.propertyAddress, 'Keep the address to 120 characters so it fits on the contract.');
  assert.deepEqual(validateDraft({ ...base, propertyAddress: 'x'.repeat(120) }, TERMS_OF_SALE).errors, {});
  const v = validateDraft({ ...base, propertyAddress: '12 Sample\tRoad\rTestville\u0007', signers: [{ ...base.signers[0], name: 'Anna\u0000 Example' }] }, TERMS_OF_SALE);
  assert.equal(v.value.propertyAddress, '12 Sample Road, Testville');
  assert.equal(v.value.signers[0].name, 'Anna Example');
  assert.equal(validateDraft({ ...base, signers: [{ ...base.signers[0], name: 'Zoë Example' }] }, TERMS_OF_SALE).value.signers[0].name, 'Zoë Example');
});

test('two fee changes started at the same moment: only one is created', async () => {
  const d = makeDeps(); const { id, tokens } = await sent(d);
  await d.contracts.sign(tokens[0], signInput({ startMarketingNow: false }), META);
  const r = await Promise.allSettled([d.contracts.startFeeChange(d.user, id, { feePercent: 1.2 }), d.contracts.startFeeChange(d.user, id, { feePercent: 1.3 })]);
  assert.deepEqual(r.map(x => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(r.find(x => x.status === 'rejected').reason.status, 409);
  assert.match(fs.readFileSync('SETUP-SUPABASE.sql', 'utf8'), /unique \(family_id, version\)/);
});

test('ids that are not valid give "not found", even if the database objects to them', async () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const d = makeDeps({ wrapStore: faultyStore });
  d.store.throwOnRead(id => (UUID.test(id) ? null : new Error('invalid input syntax for type uuid')));
  await assert.rejects(d.contracts.detail('nope'), e => e.status === 404);
  await assert.rejects(d.contracts.previewPdf('nope'), e => e.status === 404);
  await assert.rejects(d.templateAdmin.samplePdf('nope'), e => e.status === 404);
});

test('seller cancellations: no future dates, and not while a fee change is out', async () => {
  const d = makeDeps(); const { id, tokens } = await sent(d);
  await d.contracts.sign(tokens[0], signInput({ startMarketingNow: false }), META);
  await assert.rejects(d.contracts.recordSellerCancel(d.user, id, { date: '2026-11-25' }), e => e.status === 409 && /future/.test(e.message));
  const { id: v2 } = await d.contracts.startFeeChange(d.user, id, { feePercent: 1.2 });
  await d.contracts.send(d.user, v2);
  await assert.rejects(d.contracts.recordSellerCancel(d.user, id, { date: '2026-11-23' }), e => e.status === 409 && /fee change in progress \(v2\)/.test(e.message));
});

test('lists come in pages with a "more" flag', async () => {
  const d = makeDeps(); await d.seedTemplate();
  for (let i = 0; i < 3; i++) await d.contracts.createDraft(d.user, okInput());
  const first = await d.contracts.list({ tab: 'drafts', user: d.user, limit: 2 });
  assert.equal(first.rows.length, 2); assert.equal(first.more, true);
  const all = await d.contracts.list({ tab: 'drafts', user: d.user, limit: 3 });
  assert.equal(all.rows.length, 3); assert.equal(all.more, false);
});

test('initials are cleaned: stray halves of emoji and control characters are dropped', async () => {
  const d = makeDeps(); const { id, tokens } = await sent(d);
  await d.contracts.sign(tokens[0], signInput({ initials: '\ud83dA\u0007B' }), META);
  assert.equal((await d.store.getContract(id)).signers[0].initials, 'AB');
});

test('links stop working after 30 days even if the daily job has not run', async () => {
  const d = makeDeps(); const { tokens } = await sent(d);
  d.clock.advanceDays(30);
  const v = await d.contracts.openLink(tokens[0], META);
  assert.equal(v.canSign, false); assert.equal(v.message, 'This link has expired. Please contact the office.');
  await assert.rejects(d.contracts.sign(tokens[0], signInput(), META), e => e.status === 409 && /expired/.test(e.message));
  await assert.rejects(d.contracts.documentForLink(tokens[0]), e => e.status === 410);
});

// --- routes for the screens ---
import path from 'node:path';
import { boot } from './helpers/boot.js';
import { createLocalAuth } from '../lib/auth-local.js';

test('HTTP: list paging and "email signed copy again"', async () => {
  const d = makeDeps();
  const pw = 'correct-horse-battery';
  const t = await boot({ ...d, auth: createLocalAuth([{ ...d.user, password: pw }]), publicDir: path.resolve('public'), cronSecret: 'x', links: {} });
  try {
    const login = await t.call('POST', '/api/auth/login', { email: d.user.email, password: pw });
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const { id, tokens } = await sent(d);
    for (let i = 0; i < 2; i++) await d.contracts.createDraft(d.user, okInput());
    const page = await t.call('GET', '/api/contracts?tab=drafts&limit=1', null, { cookie });
    assert.equal(page.json.rows.length, 1); assert.equal(page.json.more, true);
    await d.contracts.sign(tokens[0], signInput(), META);
    const before = d.mailer.sent.length;
    const r = await t.call('POST', `/api/contracts/${id}/resend-copy`, {}, { cookie });
    assert.equal(r.status, 200, r.text);
    assert.equal(d.mailer.sent.length, before + 1);
    assert.equal((await t.call('GET', '/api/contracts/not-a-uuid', null, { cookie })).status, 404);
  } finally { t.close(); }
});
