import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { boot } from './helpers/boot.js';
import { readJson, clientMeta } from '../lib/http.js';
import { newToken, hashToken, sha256Hex } from '../lib/tokens.js';
import { coolingOffEnds, longDate, londonDate, addDays, londonDateTime, daysBetween } from '../lib/dates.js';
import { deriveState, tabOf, EV } from '../lib/status.js';
import { TERMS_OF_SALE, enabledBases, getTemplate } from '../lib/templates.js';
import { validateDraft, parsePngDataUrl } from '../lib/validate.js';
import { makePng } from './helpers/pdf.js';

const NOW = new Date('2026-11-23T10:00:00Z');

test('health, SPA pages and path traversal', async () => {
  const t = await boot({ publicDir: path.resolve('public') });
  try {
    assert.deepEqual((await t.call('GET', '/api/health')).json, { ok: true });
    for (const p of ['/', '/contracts', '/contracts/x', '/settings', '/profile']) {
      const r = await t.call('GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.text, /<html/i, p);
    }
    assert.equal((await t.call('GET', '/%2e%2e/package.json')).status, 404);
  } finally { t.close(); }
});

test('readJson rejects bad JSON with 400 and big bodies with 413', async () => {
  await assert.rejects(readJson(Readable.from(['{bad'])), e => e.status === 400);
  await assert.rejects(readJson(Readable.from(['x'.repeat(50)]), 10), e => e.status === 413);
  assert.deepEqual(await readJson(Readable.from(['{"a":1}'])), { a: 1 });
});

test('clientMeta prefers the first forwarded IP and trims the user agent to 300', () => {
  const m = clientMeta({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'user-agent': 'x'.repeat(400) }, socket: {} });
  assert.equal(m.ip, '1.2.3.4');
  assert.equal(m.userAgent.length, 300);
  assert.equal(clientMeta({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }).ip, '9.9.9.9');
});

test('tokens: hash is sha256 of the token and tokens differ', () => {
  const a = newToken(), b = newToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashToken(a.token));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('London dates and the cooling-off end', () => {
  assert.equal(coolingOffEnds('2026-10-20T23:30:00Z'), '2026-11-04'); // 00:30 BST on 21 Oct
  assert.equal(longDate('2026-12-07'), '7 December 2026');
  assert.equal(longDate('2026-12-07T23:30:00Z'), '7 December 2026');
  assert.equal(londonDate('2026-06-30T23:30:00Z'), '2026-07-01');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(londonDateTime('2026-11-23T14:05:00Z'), '23 November 2026, 14:05');
  assert.equal(daysBetween('2026-11-20T10:00:00Z', '2026-11-23T09:59:00Z'), 2);
});

// --- deriveState, one test per table row ---
const contract = (over = {}) => ({ id: 'c1', version: 1, kind: 'new', completedAt: null, sentAt: null, ...over });
const signer = (over = {}) => ({ id: 's1', name: 'Anna Example', status: 'pending', startMarketingNow: null, ...over });
const ev = (type, at = '2026-11-01T10:00:00Z', data = {}) => ({ type, at, data });

test('deriveState: cancelled wins, even for a draft', () => {
  const r = deriveState({ contract: contract(), signers: [signer()], events: [ev(EV.created), ev(EV.cancelled)], now: NOW });
  assert.equal(r.state, 'cancelled'); assert.equal(r.label, 'Cancelled by office');
});
test('deriveState: no sent event is a draft', () => {
  const r = deriveState({ contract: contract(), signers: [signer()], events: [ev(EV.created)], now: NOW });
  assert.equal(r.state, 'draft'); assert.equal(r.label, 'Draft'); assert.equal(r.daysWaiting, null);
});
test('deriveState: expired', () => {
  const r = deriveState({ contract: contract({ sentAt: '2026-10-01T10:00:00Z' }), signers: [signer()], events: [ev(EV.sent), ev(EV.expired)], now: NOW });
  assert.equal(r.state, 'expired'); assert.equal(r.label, 'Expired');
});
test('deriveState: out for signing with days waiting and counts', () => {
  const r = deriveState({ contract: contract({ sentAt: '2026-11-18T10:00:00Z' }), signers: [signer(), signer({ id: 's2', status: 'signed' })], events: [ev(EV.sent)], now: NOW });
  assert.equal(r.state, 'out'); assert.equal(r.label, 'Out for signing');
  assert.equal(r.daysWaiting, 5); assert.equal(r.signedCount, 1); assert.equal(r.signerCount, 2);
});
const done = (over = {}) => contract({ sentAt: '2026-11-10T10:00:00Z', completedAt: '2026-11-20T10:00:00Z', ...over });
test('deriveState: replaced, and reinstated afterwards is signed again', () => {
  const base = [ev(EV.sent), ev(EV.completed, '2026-11-20T10:00:00Z')];
  const signers = [signer({ status: 'signed', startMarketingNow: true })];
  const r = deriveState({ contract: done(), signers, events: [...base, ev(EV.replaced, '2026-12-09T10:00:00Z', { byVersion: 2 })], now: NOW });
  assert.equal(r.state, 'replaced'); assert.equal(r.label, 'Replaced by v2 on 9 December 2026');
  const back = deriveState({ contract: done(), signers, events: [...base, ev(EV.replaced, '2026-12-09T10:00:00Z', { byVersion: 2 }), ev(EV.reinstated)], now: new Date('2027-01-10T10:00:00Z') });
  assert.equal(back.state, 'signed');
});
test('deriveState: cancelled by seller', () => {
  const r = deriveState({ contract: done(), signers: [signer({ status: 'signed', startMarketingNow: false })], events: [ev(EV.sent), ev(EV.completed), ev(EV.seller_cancelled)], now: NOW });
  assert.equal(r.state, 'seller_cancelled'); assert.equal(r.label, 'Cancelled by seller');
});
test('deriveState: cooling off until 14 days after completion', () => {
  const signers = [signer({ status: 'signed', startMarketingNow: true }), signer({ id: 's2', status: 'signed', startMarketingNow: false })];
  const r = deriveState({ contract: done(), signers, events: [ev(EV.sent), ev(EV.completed)], now: NOW });
  assert.equal(r.state, 'cooling'); assert.equal(r.label, 'Cooling off until 4 December 2026'); assert.equal(r.coolingOffUntil, '2026-12-04');
  const later = deriveState({ contract: done(), signers, events: [ev(EV.sent), ev(EV.completed)], now: new Date('2026-12-05T10:00:00Z') });
  assert.equal(later.state, 'signed'); assert.equal(later.label, 'Signed');
});
test('deriveState: everyone ticked within 14 days → marketing may start', () => {
  const r = deriveState({ contract: done(), signers: [signer({ status: 'signed', startMarketingNow: true })], events: [ev(EV.sent), ev(EV.completed)], now: NOW });
  assert.equal(r.state, 'signed'); assert.equal(r.label, 'Signed – marketing may start');
});
test('tabOf maps every state', () => {
  assert.equal(tabOf('draft'), 'drafts'); assert.equal(tabOf('out'), 'out'); assert.equal(tabOf('cooling'), 'cooling');
  assert.equal(tabOf('signed'), 'signed');
  for (const s of ['cancelled', 'expired', 'seller_cancelled', 'replaced']) assert.equal(tabOf(s), 'ended');
});

test('templates: only Sole is enabled until wording exists', () => {
  assert.deepEqual(enabledBases(TERMS_OF_SALE).map(b => b.key), ['sole']);
  const withText = { ...TERMS_OF_SALE, bases: { ...TERMS_OF_SALE.bases, multiple: { label: 'Multiple', text: 'Multiple Agents until…', enabled: true } } };
  assert.deepEqual(enabledBases(withText).map(b => b.key), ['sole', 'multiple']);
  assert.equal(getTemplate('terms-of-sale'), TERMS_OF_SALE);
  assert.throws(() => getTemplate('nope'));
});

const okDraft = (over = {}) => ({
  signers: [{ name: 'Anna Example', email: 'anna@example.com', mobile: '07700 900123' }],
  propertyAddress: '12 Sample Road, Testville, AB1 2CD', basis: 'sole', feePercent: 1.5, guidePrice: 1250000, ...over,
});
test('validateDraft: every field wrong gives exactly these errors', () => {
  const { errors } = validateDraft({ signers: [{ name: '', email: 'x', mobile: '0123' }], propertyAddress: '', feePercent: 11, guidePrice: 1.5 }, TERMS_OF_SALE);
  assert.deepEqual(Object.keys(errors).sort(), ['feePercent', 'guidePrice', 'propertyAddress', 'signers.0.email', 'signers.0.mobile', 'signers.0.name']);
});
test('validateDraft: seller limits, fee decimals, basis, shared email, address newlines', () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, email: `s${i}@example.com`, mobile: '' }));
  assert.equal(validateDraft(okDraft({ signers: seven }), TERMS_OF_SALE).errors.signers, 'Up to 6 sellers.');
  assert.equal(validateDraft(okDraft({ signers: [] }), TERMS_OF_SALE).errors.signers, 'Add at least one seller.');
  assert.ok(validateDraft(okDraft({ feePercent: 1.255 }), TERMS_OF_SALE).errors.feePercent);
  assert.ok(validateDraft(okDraft({ basis: 'multiple' }), TERMS_OF_SALE).errors.basis);
  const shared = validateDraft(okDraft({ signers: [
    { name: 'Anna Example', email: 'Home@example.com', mobile: '+447700900123' },
    { name: 'Ben Example', email: 'home@example.com', mobile: '' }] }), TERMS_OF_SALE);
  assert.deepEqual(shared.errors, {});
  assert.deepEqual(shared.value.signers.map(s => s.sharedEmail), [true, true]);
  assert.equal(shared.value.signers[0].mobile, '+447700900123');
  const ok = validateDraft(okDraft({ propertyAddress: '12 Sample Road\nTestville' }), TERMS_OF_SALE);
  assert.equal(ok.value.propertyAddress, '12 Sample Road, Testville');
  assert.equal(ok.value.signers[0].sharedEmail, false);
});
test('parsePngDataUrl rejects anything that is not a small PNG', () => {
  assert.throws(() => parsePngDataUrl('data:image/png;base64,AAAA'), e => e.status === 400 && e.message === 'Please sign again.');
  assert.throws(() => parsePngDataUrl('hello'), e => e.status === 400);
  const url = b => 'data:image/png;base64,' + Buffer.from(b).toString('base64');
  const good = makePng(300, 80);
  assert.equal(parsePngDataUrl(url(good)).length, good.length);
  const magicOnly = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.throws(() => parsePngDataUrl(url(magicOnly)), e => e.status === 400);            // valid header bytes, garbage body
  const corrupt = Buffer.from(good); corrupt.fill(7, 40, 60);                           // damaged image data
  assert.throws(() => parsePngDataUrl(url(corrupt)), e => e.status === 400);
  assert.throws(() => parsePngDataUrl(url(Buffer.concat([good, Buffer.alloc(5000)]))), e => e.status === 400);   // junk after the end
  assert.throws(() => parsePngDataUrl(url(makePng(5000, 10))), e => e.status === 400);  // far too wide for a signature
  const big = Buffer.concat([magicOnly, Buffer.alloc(150001)]);
  assert.throws(() => parsePngDataUrl(url(big)), e => e.status === 400);
});
