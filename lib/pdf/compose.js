import { PDFDocument, PDFDict, PDFName, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, drawObject } from '@cantoo/pdf-lib';
import { TERMS_OF_SALE, CANCEL_NOTICE, MARKETING_REQUEST, MODEL_FORM_LINES } from '../templates.js';
import { longDate, londonDateTime } from '../dates.js';
import { safeText, fitText, wrap, formatFee, formatPrice, joinNames } from './text.js';
import { extraPagesLayout } from './layout.js';
import { chromeFromPage } from './chrome.js';

const A4 = [595.28, 841.89];
const INK = rgb(0.09, 0.16, 0.16);
const GREY = rgb(0.45, 0.5, 0.5);
const LINE = rgb(0.6, 0.65, 0.65);
const LEFT = 72;
const WIDTH = 451;

function pngBytes(x) {
  if (x instanceof Uint8Array) return x;
  const prefix = 'data:image/png;base64,';
  if (typeof x === 'string' && x.startsWith(prefix)) return new Uint8Array(Buffer.from(x.slice(prefix.length), 'base64'));
  return null;
}

async function fonts(doc) {
  return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
}

// Draw a PNG inside a box, keeping its proportions, left-aligned and vertically centred.
async function drawImageFit(doc, page, png, r) {
  const img = await doc.embedPng(png);
  const s = Math.min(r.width / img.width, r.height / img.height);
  const w = img.width * s, h = img.height * s;
  page.drawImage(img, { x: r.x, y: r.y + (r.height - h) / 2, width: w, height: h });
}

function drawInBox(page, font, text, r, { max = 10 } = {}) {
  const { text: t, size } = fitText(font, safeText(font, text), r.width, { max, min: 5 });
  page.drawText(t, { x: r.x, y: r.y + Math.max(1, (r.height - size) / 2 + 1), size, font, color: INK });
}

// The logo and address strip from page 1, reused on every page we add. Page 1 is embedded once
// (it is about 60 KB) and drawn clipped to the header and footer areas.
const CHROME_TAG = 'BDChrome';

function chromeDrawer(template, ref) {
  const h = template.headerBox, f = template.footerBox;
  return page => {
    const name = page.node.newXObject(CHROME_TAG, ref);
    page.pushOperators(
      pushGraphicsState(),
      rectangle(h.left, h.bottom, h.right - h.left, h.top - h.bottom),
      rectangle(f.left, f.bottom, f.right - f.left, f.top - f.bottom),
      clip(), endPath(), drawObject(name), popGraphicsState(),
    );
  };
}

async function pageChrome(doc, template) {
  const first = doc.getPage(0);
  const ref = chromeFromPage(doc, first, [template.headerBox, template.footerBox]);
  if (ref) return chromeDrawer(template, ref);
  const embedded = await doc.embedPage(first);          // fallback: the whole page, drawn clipped
  return chromeDrawer(template, embedded.ref);
}

// Reuse the page-1 copy already in a presented PDF (found on the cancel page) instead of adding another.
async function existingChrome(doc, page, template) {
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const entry = xobjects?.entries().find(([k]) => k.asString().startsWith('/' + CHROME_TAG));
  return entry ? chromeDrawer(template, entry[1]) : pageChrome(doc, template);
}

function drawLines(page, font, lines, { x = LEFT, y, size, leading, color = INK }) {
  for (const ln of lines) { page.drawText(ln, { x, y, size, font, color }); y -= leading; }
  return y;
}

function drawSignatoryBlock(page, f, b, signer) {
  const top = b.top;
  page.drawText(safeText(f.bold, `Seller ${b.signerIndex + 1}: ${signer.name}`), { x: LEFT, y: top, size: 10.5, font: f.bold, color: INK });
  page.drawText('Signature', { x: b.signature.x, y: top - 22, size: 7.5, font: f.regular, color: GREY });
  page.drawText('Initials', { x: b.initials.x, y: top - 22, size: 7.5, font: f.regular, color: GREY });
  const rule = (x1, x2, y) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color: LINE });
  rule(b.signature.x, b.signature.x + b.signature.width, top - 70);
  rule(b.initials.x, b.initials.x + b.initials.width, top - 70);
  rule(b.name.x, b.name.x + b.name.width, top - 94);
  rule(b.date.x, b.date.x + b.date.width, top - 94);
  page.drawText('Name', { x: b.name.x, y: top - 104, size: 7.5, font: f.regular, color: GREY });
  page.drawText('Date', { x: b.date.x, y: top - 104, size: 7.5, font: f.regular, color: GREY });
}

function drawCancelPage(page, f, signers, layout, propertyAddress) {
  let y = 690;
  page.drawText(CANCEL_NOTICE[0], { x: LEFT, y, size: 13, font: f.bold, color: INK });
  y -= 22;
  for (const para of CANCEL_NOTICE.slice(1)) {
    y = drawLines(page, f.regular, wrap(f.regular, para, 9.5, WIDTH), { y, size: 9.5, leading: 13 }) - 6;
  }
  page.drawText('Starting marketing now', { x: LEFT, y: 452, size: 11, font: f.bold, color: INK });
  for (const t of layout.ticks) {
    page.drawRectangle({ x: t.x, y: t.y, width: t.size, height: t.size, borderColor: INK, borderWidth: 0.8 });
    const text = safeText(f.regular, `${signers[t.signerIndex].name} ${MARKETING_REQUEST}`);
    drawLines(page, f.regular, wrap(f.regular, text, 8.5, WIDTH - 20), { x: t.x + 20, y: t.y + 3, size: 8.5, leading: 10 });
  }
  y = 290;
  const [title, note, ...rest] = MODEL_FORM_LINES;
  page.drawText(title, { x: LEFT, y, size: 11, font: f.bold, color: INK });
  y -= 15;
  page.drawText(note, { x: LEFT, y, size: 8.5, font: f.regular, color: GREY });
  y -= 18;
  for (const line of rest) {
    const text = safeText(f.regular, line.replace('{propertyAddress}', propertyAddress));
    y = drawLines(page, f.regular, wrap(f.regular, text, 9.5, WIDTH), { y, size: 9.5, leading: 13 }) - 5;
  }
}

// The copy the seller reads and signs: page 1 filled in and flattened, sender's signature on,
// plus the additional-signatories and right-to-cancel pages.
export async function buildPresented({ masterBytes, fieldRects, template = TERMS_OF_SALE, signers, contract, sender, sentAt }) {
  const doc = await PDFDocument.load(masterBytes);
  const f = await fonts(doc);
  const form = doc.getForm();
  const F = template.fields;
  const lead = signers[0];
  const c = contract.fields;
  const values = {
    [F.client]: joinNames(signers.map(s => s.name)),
    [F.propertyAddress]: c.propertyAddress,
    [F.mobile]: lead.mobile || '',
    [F.email]: lead.email,
    [F.feePercent]: formatFee(c.feePercent),
    [F.guidePrice]: formatPrice(c.guidePrice),
    [F.senderName]: sender?.name || '',
    [F.senderDate]: sentAt ? longDate(sentAt) : '',
  };
  for (const [name, value] of Object.entries(values)) {
    const field = form.getTextField(name);
    const { text, size } = fitText(f.regular, safeText(f.regular, value), Math.max(4, fieldRects[name].width - 4));
    field.setFontSize(size);
    field.setText(text);
  }
  const byName = new Map(form.getFields().map(x => [x.getName(), x]));
  for (const name of [F.sellerSignature, F.sellerInitials, F.sellerName, F.sellerDate, F.senderSignature]) {
    if (byName.has(name)) form.removeField(byName.get(name));
  }

  const page0 = doc.getPage(0);
  const senderPng = pngBytes(sender?.signaturePng);
  if (senderPng) await drawImageFit(doc, page0, senderPng, fieldRects[F.senderSignature]);

  const basisText = template.bases[c.basis]?.text;
  if (basisText) {
    const r = template.basisRect;
    const page = doc.getPage(r.page);
    page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, color: rgb(1, 1, 1) });
    drawLines(page, f.regular, wrap(f.regular, safeText(f.regular, `• ${basisText}`), 10.5, r.width), { x: r.x, y: r.y + r.height - 10.5, size: 10.5, leading: 13 });
  }
  form.flatten();

  const layout = extraPagesLayout(signers.length);
  const decorate = await pageChrome(doc, template);
  for (let k = 0; k < layout.additionalPageCount; k++) {
    const page = doc.insertPage(1 + k, A4);
    decorate(page);
    page.drawText('Additional signatories', { x: LEFT, y: 700, size: 14, font: f.bold, color: INK });
    for (const b of layout.blocks.filter(x => x.pageIndex === 1 + k)) drawSignatoryBlock(page, f, b, signers[b.signerIndex]);
  }
  const cancelPage = doc.insertPage(layout.cancelPageIndex, A4);
  decorate(cancelPage);
  drawCancelPage(cancelPage, f, signers, layout, c.propertyAddress);

  return doc.save({ useObjectStreams: true });
}

// A preview of a newly uploaded master, filled with made-up details.
export function buildSample({ masterBytes, fieldRects, template = TERMS_OF_SALE }) {
  return buildPresented({
    masterBytes, fieldRects, template,
    signers: [
      { name: 'Anna Example', email: 'anna@example.com', mobile: '07700 900123' },
      { name: 'Ben Example', email: 'ben@example.com', mobile: '' },
    ],
    contract: { fields: { propertyAddress: '12 Sample Road, Testville, AB1 2CD', basis: 'sole', feePercent: 1.5, guidePrice: 1250000 } },
    sender: { name: 'Jo Example', signaturePng: null },
    sentAt: new Date().toISOString(),
  });
}

async function placeSigner(doc, page, f, boxes, signer) {
  const png = pngBytes(signer.signaturePng);
  if (png) await drawImageFit(doc, page, png, boxes.signature);
  if (signer.initials) drawInBox(page, f.regular, signer.initials, boxes.initials, { max: 11 });
  drawInBox(page, f.regular, signer.name, boxes.name);
  if (signer.signedAt) drawInBox(page, f.regular, longDate(signer.signedAt), boxes.date);
}

function shortDevice(ua) {
  return ua ? String(ua).slice(0, 90) : 'device not recorded';
}

function recordWriter(doc, decorate, f) {
  let page, y;
  const newPage = () => {
    page = doc.addPage(A4);
    decorate(page);
    page.drawText('Signing record', { x: LEFT, y: 700, size: 14, font: f.bold, color: INK });
    y = 676;
  };
  newPage();
  return {
    line(text, { bold = false, size = 9, indent = 0 } = {}) {
      const font = bold ? f.bold : f.regular;
      for (const ln of wrap(font, safeText(font, text), size, WIDTH - indent)) {
        if (y < 90) newPage();
        page.drawText(ln, { x: LEFT + indent, y, size, font, color: INK });
        y -= size + 3.5;
      }
    },
    gap(n = 6) { y -= n; },
  };
}

// The signed copy: everyone's signatures drawn in, ticks on the cancel page, and the signing record.
// It is saved as an incremental update, so the file starts with the exact bytes the sellers were shown:
// hashing its first presentedLength bytes gives the "presented" fingerprint on the signing record.
export async function buildFinal({ presentedBytes, fieldRects, template = TERMS_OF_SALE, signers, evidence }) {
  const doc = await PDFDocument.load(presentedBytes, { forIncrementalUpdate: true });
  const f = await fonts(doc);
  const F = template.fields;
  const layout = extraPagesLayout(signers.length);

  await placeSigner(doc, doc.getPage(0), f, {
    signature: fieldRects[F.sellerSignature], initials: fieldRects[F.sellerInitials],
    name: fieldRects[F.sellerName], date: fieldRects[F.sellerDate],
  }, signers[0]);
  for (const b of layout.blocks) await placeSigner(doc, doc.getPage(b.pageIndex), f, b, signers[b.signerIndex]);

  const cancelPage = doc.getPage(layout.cancelPageIndex);
  for (const t of layout.ticks) {
    if (signers[t.signerIndex].startMarketingNow) {
      cancelPage.drawLine({ start: { x: t.x + 2.5, y: t.y + 6 }, end: { x: t.x + 5, y: t.y + 2.5 }, thickness: 1.4, color: INK });
      cancelPage.drawLine({ start: { x: t.x + 5, y: t.y + 2.5 }, end: { x: t.x + 10, y: t.y + 10 }, thickness: 1.4, color: INK });
    } else {
      cancelPage.drawText('No', { x: t.x - 18, y: t.y + 2, size: 9, font: f.bold, color: INK });
    }
  }

  const decorate = await existingChrome(doc, cancelPage, template);
  const w = recordWriter(doc, decorate, f);
  const dt = iso => (iso ? londonDateTime(iso) : 'not recorded');
  w.line(`Ref: ${evidence.ref}`);
  w.line(`Property: ${evidence.propertyAddress}`);
  w.line(`Template: Terms of Sale, version ${evidence.templateVersion.version}. Fingerprint:`);
  w.line(evidence.templateVersion.sha256 || 'not recorded', { indent: 12 });
  w.line(`Fingerprint of the document as presented for signing (the first ${presentedBytes.length} bytes of this file):`);
  w.line(evidence.presentedSha256 || 'not recorded', { indent: 12 });
  w.line(`Sent by ${evidence.sender.name} (${evidence.sender.email}) on ${dt(evidence.sender.sentAt)}`);
  evidence.signers.forEach((s, i) => {
    w.gap(8);
    w.line(`Seller ${i + 1}: ${s.name}`, { bold: true, size: 10 });
    w.line(`Email: ${s.email}${s.sharedEmail ? ' (shared with another seller)' : ''}`, { indent: 12 });
    w.line(`Link sent: ${dt(s.sentAt)}`, { indent: 12 });
    for (const o of s.opens) w.line(`Opened: ${dt(o.at)} · IP ${o.ip || 'not recorded'} · ${shortDevice(o.userAgent)}`, { indent: 12 });
    if (s.moreOpens) w.line(`…and ${s.moreOpens} more opens`, { indent: 12 });
    w.line(`Agreed to sign electronically: ${dt(s.consentedAt)}`, { indent: 12 });
    w.line(`Signed: ${dt(s.signedAt)} · IP ${s.ip || 'not recorded'} · ${shortDevice(s.userAgent)}`, { indent: 12 });
    w.line(s.startMarketingNow ? 'Asked for marketing to start now' : 'Did not ask for marketing to start now', { indent: 12 });
  });
  w.gap(12);
  w.line("Times are UK time. A fingerprint of this complete file is kept in Berkeleys Drummond's signing log.");

  return doc.commit();
}
