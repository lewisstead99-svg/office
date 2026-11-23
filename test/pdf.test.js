import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { makeFixtureMaster } from './helpers/fixture-master.js';
import { countImageObjects, pageText, pngDataUrl } from './helpers/pdf.js';
import { prepareMaster, MasterError } from '../lib/pdf/master.js';
import { safeText, fitText, formatFee, formatPrice, joinNames } from '../lib/pdf/text.js';
import { extraPagesLayout } from '../lib/pdf/layout.js';
import { buildPresented, buildFinal, buildSample } from '../lib/pdf/compose.js';
import { evidenceFrom } from '../lib/evidence.js';
import { TERMS_OF_SALE } from '../lib/templates.js';
import { sha256Hex } from '../lib/tokens.js';

let helvetica;
test.before(async () => { helvetica = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica); });

const NAMES = ['Anna Example', 'Ben Example', 'Cara Example', 'Dev Example', 'Eve Example', 'Fay Example'];
let masterCache;
const prepared = async () => (masterCache ??= await prepareMaster(await makeFixtureMaster(), TERMS_OF_SALE));
function presentedInput(m, { signers = 2, names = null, basisTemplate = null, basis = 'sole' } = {}) {
  const list = (names || NAMES.slice(0, signers)).map((name, i) => ({ id: `s${i}`, position: i, name, email: `s${i}@example.com`, mobile: '07700900123', sharedEmail: false, status: 'pending' }));
  return {
    masterBytes: m.bytes, fieldRects: m.fieldRects, template: basisTemplate || TERMS_OF_SALE, signers: list,
    contract: { id: 'c1', fields: { propertyAddress: '12 Sample Road, Testville, AB1 2CD', basis, feePercent: 1.5, guidePrice: 1250000 } },
    sender: { name: 'Jo Office', signaturePng: pngDataUrl() }, sentAt: '2026-11-23T10:00:00Z',
  };
}

test('prepareMaster unlocks, drops stray boxes and merges duplicate images', async () => {
  const src = await makeFixtureMaster();
  assert.ok(Buffer.from(src).toString('latin1').includes('/Encrypt'));          // the fixture really is locked
  const out = await prepareMaster(src, TERMS_OF_SALE);
  const raw = Buffer.from(out.bytes).toString('latin1');
  assert.ok(!raw.includes('/Encrypt') && !raw.includes('/Standard'));
  const doc = await PDFDocument.load(out.bytes);                                 // no password needed
  const names = doc.getForm().getFields().map(f => f.getName());
  assert.ok(!names.includes('Text Field 2'));
  assert.ok(names.includes('Client') && names.includes('Date 1'));
  assert.equal(countImageObjects(await PDFDocument.load(src, { password: '' })), 3);
  assert.equal(countImageObjects(doc), 1);
  assert.deepEqual(out.fieldRects['Text Field 3'], { page: 0, x: 92, y: 459, width: 24, height: 17 });
  assert.equal(out.sha256, sha256Hex(out.bytes));
  assert.equal(out.pageCount, 3);
});

test('prepareMaster names missing boxes and refuses real passwords', async () => {
  await assert.rejects(prepareMaster(await makeFixtureMaster({ omit: ['Mobile Telephone'] }), TERMS_OF_SALE),
    e => e instanceof MasterError && /Mobile Telephone/.test(e.message));
  await assert.rejects(prepareMaster(await makeFixtureMaster({ userPassword: 'secret' }), TERMS_OF_SALE), /password/i);
  await assert.rejects(prepareMaster(new Uint8Array([1, 2, 3]), TERMS_OF_SALE), MasterError);
});

test('text helpers: safe characters, fitting, formatting', () => {
  assert.equal(safeText(helvetica, 'Zoë Łukasz'), 'Zoë Lukasz');
  assert.equal(safeText(helvetica, 'Łódź 1234 中'), 'Lódz 1234 ?');
  assert.equal(safeText(helvetica, 'O’Brien “Bob” 😀'), "O'Brien \"Bob\" ?");
  const fee = fitText(helvetica, '12.25%', 24);
  assert.ok(fee.size >= 5 && helvetica.widthOfTextAtSize(fee.text, fee.size) <= 24);
  const long = fitText(helvetica, 'x'.repeat(200), 378);
  assert.ok(long.text.endsWith('…')); assert.equal(long.size, 5);
  assert.ok(helvetica.widthOfTextAtSize(long.text, long.size) <= 378);
  assert.deepEqual(fitText(helvetica, 'Short', 300), { text: 'Short', size: 10 });
  assert.equal(formatFee(1.5), '1.5%'); assert.equal(formatFee(1.25), '1.25%'); assert.equal(formatFee(2), '2%');
  assert.equal(formatPrice(1250000), '£1,250,000');
  assert.equal(joinNames(['A']), 'A'); assert.equal(joinNames(['A', 'B']), 'A and B'); assert.equal(joinNames(['A', 'B', 'C']), 'A, B and C');
});

test('layout: 6 sellers need 2 extra pages, ticks stay above the model form', () => {
  const l = extraPagesLayout(6);
  assert.equal(l.additionalPageCount, 2); assert.equal(l.cancelPageIndex, 3);
  assert.equal(l.blocks.length, 5); assert.equal(l.blocks[4].pageIndex, 2);
  assert.ok(l.ticks.every(t => t.y > 290)); assert.equal(l.ticks.length, 6);
  assert.deepEqual(extraPagesLayout(1), { additionalPageCount: 0, blocks: [], cancelPageIndex: 1, ticks: [{ signerIndex: 0, x: 72, y: 430, size: 12 }] });
});

test('presented PDF: page 1 filled and flattened, extra pages for 2 sellers', async () => {
  const m = await prepared();
  const bytes = await buildPresented(presentedInput(m, { signers: 2 }));
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getForm().getFields().length, 0);
  assert.equal(doc.getPageCount(), 3 + 1 + 1);
  const p0 = await pageText(bytes, 0);
  for (const s of ['Anna Example and Ben Example', '1.5%', '£1,250,000', '12 Sample Road, Testville, AB1 2CD', '07700900123', 's0@example.com', 'Jo Office', '23 November 2026']) assert.ok(p0.includes(s), s);
  assert.match(await pageText(bytes, 1), /Seller 2: Ben Example/);
  const cancel = (await pageText(bytes, 2)).replace(/\s+/g, ' ');
  assert.match(cancel, /Your right to cancel/); assert.match(cancel, /Model cancellation form/);
  assert.match(cancel, /estate agency services for the sale of 12 Sample Road/);
  assert.match(cancel, /Ben Example asks Berkeleys Drummond to start marketing/);
  assert.ok(countImageObjects(doc) >= 2);       // fixture image + sender signature
});

test('presented PDF: one seller has no additional-signatories page', async () => {
  const doc = await PDFDocument.load(await buildPresented(presentedInput(await prepared(), { signers: 1 })));
  assert.equal(doc.getPageCount(), 3 + 1);
});

test('presented PDF: names outside the standard font do not break it', async () => {
  const bytes = await buildPresented(presentedInput(await prepared(), { names: ['Zoë Łukasz-Nowak 😀'] }));
  assert.match(await pageText(bytes, 0), /Zoë Lukasz-Nowak \?/);
});

test('presented PDF: a basis with wording replaces the Sole bullet', async () => {
  const t = { ...TERMS_OF_SALE, bases: { ...TERMS_OF_SALE.bases, multiple: { label: 'Multiple', text: 'Multiple Agents until either party gives notice.', enabled: true } } };
  const bytes = await buildPresented(presentedInput(await prepared(), { signers: 1, basisTemplate: t, basis: 'multiple' }));
  assert.match(await pageText(bytes, 0), /• Multiple Agents until either party gives notice\./);
});

test('sample PDF uses made-up data', async () => {
  const m = await prepared();
  const bytes = await buildSample({ masterBytes: m.bytes, fieldRects: m.fieldRects, template: TERMS_OF_SALE });
  assert.match(await pageText(bytes, 0), /Anna Example and Ben Example/);
});

const signed = n => NAMES.slice(0, n).map((name, i) => ({ id: `s${i}`, position: i, name, email: i === 1 ? 's0@example.com' : `s${i}@example.com`, sharedEmail: i < 2 && n > 1,
  status: 'signed', signedAt: '2026-11-24T12:00:00Z', signaturePng: pngDataUrl(), initials: name.split(' ').map(w => w[0]).join(''), startMarketingNow: i === 0 }));
function evidenceInput(n, opensEach = 1) {
  const signers = signed(n);
  const events = signers.flatMap(s => [
    ...Array.from({ length: opensEach }, (_, k) => ({ type: 'opened', signerId: s.id, at: `2026-11-23T1${k % 10}:00:00Z`, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })),
    { type: 'consented', signerId: s.id, at: '2026-11-24T11:59:00Z', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)' },
    { type: 'signed', signerId: s.id, at: '2026-11-24T12:00:00Z', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)' },
  ]);
  const contract = { id: 'c1d2e3f4-0000-4000-8000-000000000000', fields: { propertyAddress: '12 Sample Road, Testville, AB1 2CD' }, presentedSha256: 'ab'.repeat(32), presentedLength: 123456,
    sender: { id: 'u1', name: 'Jo Office', email: 'jo@example.com' }, sentAt: '2026-11-23T10:00:00Z' };
  return { signers, evidence: evidenceFrom({ contract, signers, events, templateVersion: { version: 1, sha256: 'cd'.repeat(32) } }) };
}

test('evidenceFrom gathers opens (first 5), consent and signing per signer', () => {
  const { evidence } = evidenceInput(2, 7);
  assert.equal(evidence.ref, 'C1D2E3F4');
  assert.equal(evidence.presentedSha256, 'ab'.repeat(32));
  assert.deepEqual(evidence.templateVersion, { version: 1, sha256: 'cd'.repeat(32) });
  assert.equal(evidence.sender.name, 'Jo Office');
  const s = evidence.signers[0];
  assert.equal(s.opens.length, 5); assert.equal(s.moreOpens, 2);
  assert.equal(s.consentedAt, '2026-11-24T11:59:00Z'); assert.equal(s.signedAt, '2026-11-24T12:00:00Z');
  assert.equal(s.ip, '203.0.113.7'); assert.equal(s.startMarketingNow, true);
  assert.equal(evidence.signers[1].sharedEmail, true);
});

test('final PDF: signatures drawn and the signing record appended', async () => {
  const m = await prepared();
  const presented = await buildPresented(presentedInput(m, { signers: 2 }));
  const { signers, evidence } = evidenceInput(2);
  const final = await buildFinal({ presentedBytes: presented, fieldRects: m.fieldRects, template: TERMS_OF_SALE, signers, evidence });
  const doc = await PDFDocument.load(final);
  assert.equal(doc.getPageCount(), 5 + 1);
  const last = await pageText(final, 5);
  assert.match(last, /Signing record/);
  assert.ok(last.includes('ab'.repeat(32))); assert.ok(last.includes('cd'.repeat(32)));
  assert.match(last, /shared with another seller/); assert.match(last, /Asked for marketing to start now/); assert.match(last, /Did not ask for marketing to start now/);
  assert.match(last, /Times are UK time/);
  assert.ok(countImageObjects(doc) >= 4);      // fixture image + sender + 2 sellers
  const p0 = await pageText(final, 0);
  assert.match(p0, /Anna Example/); assert.match(p0, /24 November 2026/); assert.match(p0, /AE/);
  assert.match(await pageText(final, 2), /^No$/m);   // Ben did not ask for marketing to start now
});

test('final PDF keeps the presented bytes as an exact prefix (incremental update)', async () => {
  const m = await prepared();
  const presented = await buildPresented(presentedInput(m, { signers: 2 }));
  const { signers, evidence } = evidenceInput(2);
  const final = await buildFinal({ presentedBytes: presented, fieldRects: m.fieldRects, template: TERMS_OF_SALE, signers, evidence });
  assert.ok(final.length > presented.length);
  assert.ok(Buffer.from(final.subarray(0, presented.length)).equals(Buffer.from(presented)), 'presented bytes are not a prefix of the final');
  assert.equal(sha256Hex(final.subarray(0, presented.length)), sha256Hex(presented));
  const doc = await PDFDocument.load(final);
  assert.equal(doc.getPageCount(), 5 + 1);
  assert.match(await pageText(final, 5), new RegExp(`first ${presented.length} bytes`));
});

test('final PDF: 6 sellers with many opens flow onto two record pages', async () => {
  const m = await prepared();
  const presented = await buildPresented(presentedInput(m, { signers: 6 }));
  const { signers, evidence } = evidenceInput(6, 10);
  const final = await buildFinal({ presentedBytes: presented, fieldRects: m.fieldRects, template: TERMS_OF_SALE, signers, evidence });
  const pages = (await PDFDocument.load(presented)).getPageCount();
  const total = (await PDFDocument.load(final)).getPageCount();
  assert.ok(total >= pages + 2, `record pages: ${total - pages}`);
  assert.match(await pageText(final, pages), /and 5 more/);
  const lastPage = (await pageText(final, total - 1)).replace(/\s+/g, ' ');
  assert.match(lastPage, /Seller 6: Fay Example|Did not ask for marketing to start now/);   // nothing lost off the end
  assert.match(lastPage, /Times are UK time/);
});

test('real master (when present in seed/) prepares to a slim unlocked file', async t => {
  const file = 'seed/terms-of-sale-master.pdf';
  if (!fs.existsSync(file)) return t.skip('no seed master');
  const out = await prepareMaster(new Uint8Array(fs.readFileSync(file)), TERMS_OF_SALE);
  assert.equal(out.pageCount, 10);
  assert.ok(out.bytes.length < 700_000, `size ${out.bytes.length}`);
  assert.ok(!Buffer.from(out.bytes).toString('latin1').includes('/Encrypt'));
  const bytes = await buildPresented(presentedInput(out, { signers: 2 }));
  assert.match(await pageText(bytes, 0), /Anna Example and Ben Example/);
});

test('accents written as two characters are joined before drawing', () => {
  assert.equal(safeText(helvetica, 'Zoë'), 'Zoë');
});

test('pages added after page 1 carry only the logo and footer, not page 1’s hidden text', async () => {
  const m = await prepared();
  const presented = await buildPresented(presentedInput(m, { signers: 2 }));
  for (const i of [1, 2]) {
    const t = await pageText(presented, i);
    assert.ok(!t.includes('Anna Example and Ben Example'), `page ${i} still carries page 1's client box`);
    assert.ok(!t.includes('£1,250,000'), `page ${i} still carries page 1's guide price`);
  }
  const { signers, evidence } = evidenceInput(2);
  const final = await buildFinal({ presentedBytes: presented, fieldRects: m.fieldRects, template: TERMS_OF_SALE, signers, evidence });
  assert.ok(!(await pageText(final, 5)).includes('Anna Example and Ben Example'));
});
