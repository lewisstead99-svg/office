import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeps, okInput, linksIn, signInput, META } from './helpers/deps.js';
import { makeFixtureMaster } from './helpers/fixture-master.js';
import { hashToken, sha256Hex } from '../lib/tokens.js';

async function sentContract({ signers = 2, fee = 1.5, d = null } = {}) {
  d ??= makeDeps();
  if (!(await d.store.currentTemplateVersion('terms-of-sale'))) await d.seedTemplate();
  const { id } = await d.contracts.createDraft(d.user, okInput({ signers, fee }));
  const before = d.mailer.sent.length;
  await d.contracts.send(d.user, id);
  return { d, id, tokens: linksIn(d.mailer.sent.slice(before)) };
}
async function completedContract(opts = {}) {
  const r = await sentContract({ signers: 1, ...opts });
  await r.d.contracts.sign(r.tokens[0], signInput({ startMarketingNow: false }), META);
  return r;
}

// --- sending ---
test('send stores the presented PDF and emails every seller their own link', async () => {
  const { d, id, tokens } = await sentContract({ signers: 2 });
  const { contract, signers, events } = await d.store.getContract(id);
  assert.equal(contract.state, 'out');
  assert.match(contract.presentedSha256, /^[0-9a-f]{64}$/);
  assert.ok(await d.blobs.get(contract.presentedPath));
  assert.equal(contract.sender.name, 'Jo Office');
  assert.equal(tokens.length, 2); assert.notEqual(tokens[0], tokens[1]);
  assert.equal((await d.store.findByTokenHash(hashToken(tokens[0]))).signer.id, signers[0].id);
  assert.equal((await d.store.findByTokenHash(hashToken(tokens[1]))).signer.id, signers[1].id);
  assert.deepEqual(d.mailer.sent.map(m => m.to[0]), ['anna@example.com', 'ben@example.com']);
  assert.match(d.mailer.sent[0].subject, /^Please sign: Terms of Sale for 12 Sample Road/);
  assert.ok(d.mailer.sent[0].text.includes(`https://office.example/s/${tokens[0]}`));
  const sent = events.find(e => e.type === 'sent');
  assert.equal(sent.data.presentedSha256, contract.presentedSha256); assert.equal(sent.actorEmail, 'jo@example.com');
});

test('send needs a saved signature and an active template', async () => {
  const d = makeDeps();
  const { id } = await d.contracts.createDraft(d.user, okInput());
  await assert.rejects(d.contracts.send(d.user, id), e => e.status === 409 && /Upload the Terms of Sale master/.test(e.message));
  await d.seedTemplate({ signature: false });
  await assert.rejects(d.contracts.send(d.user, id), e => e.status === 409 && e.message === 'Add your signature in Profile before sending.');
});

test('an email failure on send keeps the contract out and records email_failed', async () => {
  const d = makeDeps(); await d.seedTemplate();
  const { id } = await d.contracts.createDraft(d.user, okInput({ signers: 2 }));
  d.mailer.failNext(1);
  await assert.rejects(d.contracts.send(d.user, id), e => e.status === 502 && /Use Chase to try again/.test(e.message));
  const { contract, events } = await d.store.getContract(id);
  assert.equal(contract.state, 'out');
  assert.equal(events.filter(e => e.type === 'email_failed').length, 1);
  assert.equal(d.mailer.sent.length, 1);
});

test('drafts: invalid input gives field errors; editing can drop a seller; sent contracts cannot be edited', async () => {
  const d = makeDeps(); await d.seedTemplate();
  await assert.rejects(d.contracts.createDraft(d.user, { ...okInput(), feePercent: 20 }), e => e.status === 400 && !!e.extra.errors.feePercent);
  const { id } = await d.contracts.createDraft(d.user, okInput({ signers: 2 }));
  await d.contracts.updateDraft(d.user, id, okInput({ signers: 1, fee: 1.75 }));
  const got = await d.store.getContract(id);
  assert.equal(got.signers.length, 1); assert.equal(got.contract.fields.feePercent, 1.75);
  assert.equal(got.contract.createdBy.name, 'Jo Office');
  const preview = await d.contracts.previewPdf(id);
  assert.equal(Buffer.from(preview.subarray(0, 5)).toString(), '%PDF-');
  await d.contracts.send(d.user, id);
  await assert.rejects(d.contracts.updateDraft(d.user, id, okInput()), e => e.status === 409);
});

// --- signing ---
test('two sellers sign: completes once, final stored, presented removed, signed copy emailed', async () => {
  const { d, id, tokens } = await sentContract({ signers: 2 });
  await d.store.saveSettings({ officeCopyEmail: 'office@example.com' });
  assert.deepEqual(await d.contracts.sign(tokens[0], signInput({ startMarketingNow: true }), META), { allSigned: false });
  assert.deepEqual(await d.contracts.sign(tokens[1], signInput({ startMarketingNow: false, initials: 'BE' }), META), { allSigned: true });
  const { contract, events } = await d.store.getContract(id);
  assert.equal(contract.state, 'cooling');
  assert.equal(events.filter(e => e.type === 'completed').length, 1);
  assert.equal(contract.presentedPath, null); assert.match(contract.presentedSha256, /^[0-9a-f]{64}$/);
  assert.ok(await d.blobs.get(contract.finalPath));
  const last = d.mailer.sent.at(-1);
  assert.match(last.subject, /^Signed:/);
  assert.equal(last.attachments.length, 1); assert.match(last.attachments[0].filename, /\.pdf$/);
  assert.deepEqual(last.to.sort(), ['anna@example.com', 'ben@example.com', 'jo@example.com', 'office@example.com']);
  const signedEv = events.find(e => e.type === 'signed');
  assert.equal(signedEv.ip, '203.0.113.7');
});

test('stored PDFs are named by their fingerprint and match the log; the final starts with the presented copy', async () => {
  const { d, id, tokens } = await sentContract({ signers: 1 });
  const sent = (await d.store.getContract(id)).contract;
  assert.ok(sent.presentedPath.includes(sent.presentedSha256.slice(0, 16)));
  await d.contracts.sign(tokens[0], signInput(), META);
  const { contract, events } = await d.store.getContract(id);
  assert.ok(contract.finalPath.includes(contract.finalSha256.slice(0, 16)));
  const final = await d.blobs.get(contract.finalPath);
  assert.equal(sha256Hex(final), contract.finalSha256);
  const done = events.find(e => e.type === 'completed');
  assert.equal(done.data.finalSha256, contract.finalSha256);
  assert.equal(sha256Hex(final.subarray(0, done.data.presentedLength)), contract.presentedSha256);
  assert.equal(await d.blobs.get(sent.presentedPath), null);
});

test('a presented copy that no longer matches its fingerprint is refused, not signed over', async () => {
  const { d, id, tokens } = await sentContract({ signers: 1 });
  const { contract } = await d.store.getContract(id);
  await d.blobs.put(contract.presentedPath, new TextEncoder().encode('%PDF-1.7 swapped'));
  await assert.rejects(d.contracts.sign(tokens[0], signInput(), META), e => e.status === 409 && /could not be checked/.test(e.message));
  assert.equal((await d.store.getContract(id)).contract.state, 'out');
});

test('simultaneous last signatures: both kept, completed exactly once', async () => {
  const { d, id, tokens } = await sentContract({ signers: 2 });
  const results = await Promise.all([d.contracts.sign(tokens[0], signInput(), META), d.contracts.sign(tokens[1], signInput(), META)]);
  assert.deepEqual(results.map(r => r.allSigned).sort(), [false, true]);
  const { signers, events } = await d.store.getContract(id);
  assert.ok(signers.every(s => s.status === 'signed'));
  assert.equal(events.filter(e => e.type === 'completed').length, 1);
  assert.equal(d.mailer.sent.filter(m => m.subject.startsWith('Signed:')).length, 1);
});

test('signing a cancelled contract gives the cancelled message', async () => {
  const { d, id, tokens } = await sentContract({ signers: 1 });
  await d.contracts.cancel(d.user, id, 'Vendor changed agent');
  await assert.rejects(d.contracts.sign(tokens[0], signInput(), META), e => e.status === 409 && e.message === 'This contract was cancelled by Berkeleys Drummond.');
});

test('shared email needs identity confirmation; signing twice is refused; bad input is refused', async () => {
  const d = makeDeps(); await d.seedTemplate();
  const input = okInput({ signers: 2 }); input.signers[1].email = input.signers[0].email;
  const { id } = await d.contracts.createDraft(d.user, input);
  await d.contracts.send(d.user, id);
  const [t0, t1] = linksIn(d.mailer.sent);
  await assert.rejects(d.contracts.sign(t0, signInput(), META), e => e.status === 400 && /confirm/i.test(e.message));
  await d.contracts.sign(t0, signInput({ confirmIdentity: true }), META);
  await assert.rejects(d.contracts.sign(t0, signInput({ confirmIdentity: true }), META), e => e.status === 409 && /you’ve signed|you've signed/.test(e.message));
  await assert.rejects(d.contracts.sign(t1, signInput({ consent: false, confirmIdentity: true }), META), e => e.status === 400);
  await assert.rejects(d.contracts.sign(t1, signInput({ initials: '', confirmIdentity: true }), META), e => e.status === 400);
  await assert.rejects(d.contracts.sign(t1, signInput({ startMarketingNow: 'yes', confirmIdentity: true }), META), e => e.status === 400);
  await assert.rejects(d.contracts.sign('nope', signInput(), META), e => e.status === 404);
});

test('openLink shows the seller view and records opens at most every 10 minutes', async () => {
  const { d, id, tokens } = await sentContract({ signers: 2 });
  const v = await d.contracts.openLink(tokens[0], META);
  assert.equal(v.canSign, true); assert.equal(v.message, null); assert.equal(v.signer.name, 'Anna Example');
  assert.equal(v.contract.propertyAddress, '12 Sample Road, Testville, AB1 2CD'); assert.equal(v.contract.senderName, 'Jo Office');
  assert.deepEqual(v.otherSigners, [{ name: 'Ben Example', signed: false }]);
  await d.contracts.openLink(tokens[0], META);
  d.clock.advanceMs(11 * 60000);
  await d.contracts.openLink(tokens[0], META);
  const { events } = await d.store.getContract(id);
  assert.equal(events.filter(e => e.type === 'opened').length, 2);
  const doc = await d.contracts.documentForLink(tokens[0]);
  assert.equal(Buffer.from(doc.bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.equal(doc.fileName, 'Terms of Sale - 12 Sample Road, Testville, AB1 2CD.pdf');
});

// --- chase and cancel ---
test('chase: new and old links both work; a second chase within the hour is refused', async () => {
  const { d, tokens } = await sentContract({ signers: 1 });
  assert.deepEqual(await d.contracts.chase(d.user, (await d.contracts.list({ tab: 'out', user: d.user })).rows[0].id), { emailed: 1 });
  const fresh = linksIn([d.mailer.sent.at(-1)])[0];
  assert.match(d.mailer.sent.at(-1).subject, /^Reminder:/);
  assert.notEqual(fresh, tokens[0]);
  assert.equal((await d.contracts.openLink(tokens[0], META)).canSign, true);
  assert.equal((await d.contracts.openLink(fresh, META)).canSign, true);
  const id = (await d.contracts.list({ tab: 'out', user: d.user })).rows[0].id;
  await assert.rejects(d.contracts.chase(d.user, id), e => e.status === 429 && e.message === 'Chased less than an hour ago.');
  d.clock.advanceMs(61 * 60000);
  await d.contracts.chase(d.user, id);
});

test('a failed chase can be retried straight away', async () => {
  const { d, id } = await sentContract({ signers: 1 });
  d.mailer.failNext(1);
  await assert.rejects(d.contracts.chase(d.user, id), e => e.status === 502);
  assert.deepEqual(await d.contracts.chase(d.user, id), { emailed: 1 });
  await assert.rejects(d.contracts.chase(d.user, id), e => e.status === 429);
});

test('cancel needs a reason, emails pending sellers and blocks signing', async () => {
  const { d, id, tokens } = await sentContract({ signers: 2 });
  await d.contracts.sign(tokens[0], signInput(), META);
  await assert.rejects(d.contracts.cancel(d.user, id, '  '), e => e.status === 400);
  await d.contracts.cancel(d.user, id, 'Instruction withdrawn');
  const cancelled = d.mailer.sent.filter(m => m.subject.startsWith('Cancelled:'));
  assert.deepEqual(cancelled.map(m => m.to[0]), ['ben@example.com']);
  const v = await d.contracts.openLink(tokens[1], META);
  assert.equal(v.canSign, false); assert.equal(v.message, 'This contract was cancelled by Berkeleys Drummond.');
  await assert.rejects(d.contracts.cancel(d.user, id, 'again'), e => e.status === 409);
});

// --- fee change ---
test('fee change: new version with only the fee changed, linked, one at a time', async () => {
  const { d, id: v1 } = await completedContract({ fee: 1.5 });
  const { id: v2 } = await d.contracts.startFeeChange(d.user, v1, { feePercent: 1.25, note: 'Agreed by phone' });
  const det = await d.contracts.detail(v2);
  assert.equal(det.contract.kind, 'fee_change'); assert.equal(det.contract.version, 2); assert.equal(det.contract.fields.feePercent, 1.25);
  assert.equal(det.contract.note, 'Agreed by phone'); assert.equal(det.contract.replacesId, v1);
  assert.deepEqual(det.family.map(f => f.version), [1, 2]);
  assert.equal(det.signers[0].name, 'Anna Example'); assert.equal(det.signers[0].status, 'pending');
  await assert.rejects(d.contracts.startFeeChange(d.user, v1, { feePercent: 1 }), e => e.status === 409 && /already in progress \(v2\)/.test(e.message));
  await assert.rejects(d.contracts.updateDraft(d.user, v2, { propertyAddress: 'X' }), e => e.status === 400 && e.message === 'Only the fee can change on a fee change.');
  await d.contracts.updateDraft(d.user, v2, { feePercent: 1.2, note: 'Agreed by phone' });
  assert.equal((await d.store.getContract(v2)).contract.fields.feePercent, 1.2);
});

test('fee change signed replaces v1; cancelled by the seller within 14 days puts v1 back', async () => {
  const { d, id: v1 } = await completedContract();
  const { id: v2 } = await d.contracts.startFeeChange(d.user, v1, { feePercent: 1.25 });
  const before = d.mailer.sent.length;
  await d.contracts.send(d.user, v2);
  const [t] = linksIn(d.mailer.sent.slice(before));
  assert.match(d.mailer.sent.at(-1).subject, /^Please sign: updated fee/);
  await d.contracts.sign(t, signInput(), META);
  assert.equal((await d.contracts.detail(v1)).state, 'replaced');
  assert.match((await d.contracts.detail(v1)).label, /^Replaced by v2 on /);
  d.clock.advanceDays(2);
  await d.contracts.recordSellerCancel(d.user, v2, { date: '2026-11-25', note: 'Phoned to cancel' });
  assert.equal((await d.contracts.detail(v2)).state, 'seller_cancelled');
  assert.ok(['signed', 'cooling'].includes((await d.contracts.detail(v1)).state));
});

test('seller cancellation outside the 14 days is refused', async () => {
  const { d, id } = await completedContract();
  d.clock.set('2026-12-20T10:00:00Z');
  await assert.rejects(d.contracts.recordSellerCancel(d.user, id, { date: '2026-12-20' }), e => e.status === 409 && e.message === 'Outside the 14-day cancellation period.');
  await assert.rejects(d.contracts.recordSellerCancel(d.user, id, { date: 'soon' }), e => e.status === 400);
});

// --- daily job ---
test('daily job: reminders on day 3 and 7, once each; expiry on day 30', async () => {
  const { d, id, tokens } = await sentContract({ signers: 2 });
  await d.contracts.sign(tokens[0], signInput(), META);
  const reminders = () => d.mailer.sent.filter(m => m.subject.startsWith('Reminder:'));
  d.clock.advanceDays(2); assert.deepEqual(await d.contracts.runDaily(), { reminded: 0, expired: 0, refreshed: 0 });
  d.clock.advanceDays(1); assert.equal((await d.contracts.runDaily()).reminded, 1);
  assert.equal((await d.contracts.runDaily()).reminded, 0);
  assert.deepEqual(reminders().map(m => m.to[0]), ['ben@example.com']);
  d.clock.advanceDays(4); assert.equal((await d.contracts.runDaily()).reminded, 1);
  d.clock.advanceDays(23); assert.equal((await d.contracts.runDaily()).expired, 1);
  assert.equal((await d.store.getContract(id)).contract.state, 'expired');
  assert.match(d.mailer.sent.at(-1).subject, /^Expired unsigned:/); assert.deepEqual(d.mailer.sent.at(-1).to, ['jo@example.com']);
  for (const t of [tokens[1], ...linksIn(reminders())]) {
    const v = await d.contracts.openLink(t, META);
    assert.equal(v.canSign, false); assert.equal(v.message, 'This link has expired. Please contact the office.');
  }
});

test('daily job: reminders and expiry follow UK calendar days, whatever time the job runs', async () => {
  const d = makeDeps({ now: '2026-11-23T10:00:00Z' }); await d.seedTemplate();
  const { id } = await sentContract({ signers: 1, d });
  d.clock.set('2026-11-26T08:00:00Z');                       // day 3, job at 08:00 UTC
  assert.equal((await d.contracts.runDaily()).reminded, 1);
  d.clock.set('2026-11-30T08:00:00Z');                       // day 7
  assert.equal((await d.contracts.runDaily()).reminded, 1);
  d.clock.set('2026-12-23T08:00:00Z');                       // day 30
  assert.equal((await d.contracts.runDaily()).expired, 1);
  assert.equal((await d.store.getContract(id)).contract.state, 'expired');
});

test('daily job: refreshes cooling-off contracts and carries on past one failure', async () => {
  const d = makeDeps(); await d.seedTemplate();
  const a = await completedContract({ d });                 // cooling (did not ask for marketing)
  const b = await sentContract({ signers: 1, d });
  d.clock.advanceDays(3);
  d.mailer.failNext(1);
  const r = await d.contracts.runDaily();                   // b's reminder fails, job carries on
  assert.equal(r.reminded, 0);
  d.clock.advanceDays(12);
  assert.equal((await d.contracts.runDaily()).refreshed, 1);
  assert.equal((await d.store.getContract(a.id)).contract.state, 'signed');
  assert.ok((await d.store.getContract(b.id)).events.some(e => e.type === 'email_failed'));
});

// --- lists and detail ---
test('list counts tabs, searches, filters to mine; detail hides signature images', async () => {
  const d = makeDeps(); await d.seedTemplate();
  const s = await sentContract({ signers: 2, d });
  await d.contracts.createDraft(d.user, { ...okInput(), propertyAddress: '7 Other Lane, Testville' });
  const other = { id: 'u2', email: 'sam@example.com', fullName: 'Sam Office' };
  await d.contracts.createDraft(other, { ...okInput(), propertyAddress: '9 Third Street' });
  const all = await d.contracts.list({ tab: 'drafts', user: d.user });
  assert.equal(all.counts.drafts, 2); assert.equal(all.counts.out, 1); assert.equal(all.rows.length, 2);
  assert.equal((await d.contracts.list({ tab: 'drafts', mine: true, user: d.user })).rows.length, 1);
  assert.deepEqual((await d.contracts.list({ tab: 'out', q: 'ben', user: d.user })).rows.map(r => r.id), [s.id]);
  assert.equal((await d.contracts.list({ tab: 'out', q: 'nobody', user: d.user })).rows.length, 0);
  const row = (await d.contracts.list({ tab: 'out', user: d.user })).rows[0];
  assert.equal(row.clientNames, 'Anna Example and Ben Example'); assert.equal(row.label, 'Out for signing');
  assert.equal(row.signedCount, 0); assert.equal(row.signerCount, 2); assert.equal(row.daysWaiting, 0); assert.equal(row.senderName, 'Jo Office');
  await d.contracts.sign(s.tokens[0], signInput(), META);
  const det = await d.contracts.detail(s.id);
  assert.ok(det.signers.every(x => !('signaturePng' in x)));
  assert.equal(det.events.find(e => e.type === 'signed').signerName, 'Anna Example');
  assert.deepEqual(det.can, { edit: false, send: false, chase: true, cancel: true, feeChange: false, sellerCancel: false });
});

// --- templates ---
test('template admin: upload, sample, activate; locked-with-password masters are refused', async () => {
  const d = makeDeps();
  const up = await d.templateAdmin.upload(d.user, await makeFixtureMaster());
  assert.equal(up.version, 1); assert.ok(up.fieldNames.includes('Client'));
  assert.equal(Buffer.from((await d.templateAdmin.samplePdf(up.versionId)).subarray(0, 5)).toString(), '%PDF-');
  assert.equal((await d.templateAdmin.list())[0].current, false);
  await d.templateAdmin.activate(d.user, up.versionId);
  assert.equal((await d.templateAdmin.list())[0].current, true);
  await assert.rejects(d.templateAdmin.upload(d.user, await makeFixtureMaster({ userPassword: 'secret' })), e => e.status === 400 && /password/i.test(e.message));
  await assert.rejects(d.templateAdmin.samplePdf('missing'), e => e.status === 404);
});
