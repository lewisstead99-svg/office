import crypto from 'node:crypto';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef, PDFInvalidObject, PDFTextField } from '@cantoo/pdf-lib';
import { sha256Hex } from '../tokens.js';

export class MasterError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

async function open(bytes) {
  try { return await PDFDocument.load(bytes); }
  catch (e) {
    if (!/encrypt/i.test(String(e?.message))) throw new MasterError('This file could not be read as a PDF.');
  }
  // Adobe Sign exports are locked with an empty opening password.
  try {
    const doc = await PDFDocument.load(bytes, { password: '' });
    if (doc.isEncrypted) throw new Error('still locked');
    return doc;
  } catch {
    throw new MasterError('This PDF needs a password to open. Export it again as a normal PDF.');
  }
}

function pageIndexOf(doc, widget) {
  const pages = doc.getPages();
  const p = widget.P();
  if (p instanceof PDFRef) {
    const i = pages.findIndex(pg => pg.ref === p);
    if (i >= 0) return i;
  }
  return pages.findIndex(pg => {
    const annots = pg.node.Annots();
    return annots && annots.asArray().some(a => doc.context.lookup(a) === widget.dict);
  });
}

// Objects left over from the encryption: the old cross-reference stream and the /Standard dictionary.
function dropEncryptionLeftovers(ctx) {
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : null;
    if (obj instanceof PDFInvalidObject || dict?.get(PDFName.of('Filter')) === PDFName.of('Standard')) ctx.delete(ref);
  }
}

// Adobe stores the logo and badges once per page; keep one copy of each identical image.
function mergeDuplicateImages(ctx) {
  const isImage = o => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image');
  const images = ctx.enumerateIndirectObjects().filter(([, o]) => isImage(o));
  const canonical = new Map();
  const replace = new Map();
  const keyOf = o => {
    const smask = o.dict.get(PDFName.of('SMask'));
    const smaskKey = smask instanceof PDFRef ? (replace.get(smask.tag) ?? smask).tag : '';
    return crypto.createHash('sha256').update(o.contents)
      .update(`${o.dict.get(PDFName.of('Width'))}x${o.dict.get(PDFName.of('Height'))}|${smaskKey}`).digest('hex');
  };
  for (const withMask of [false, true]) {
    for (const [ref, o] of images) {
      if (!!o.dict.get(PDFName.of('SMask')) !== withMask) continue;
      const k = keyOf(o);
      if (canonical.has(k)) replace.set(ref.tag, canonical.get(k));
      else canonical.set(k, ref);
    }
  }
  if (!replace.size) return 0;
  const fix = v => {
    if (v instanceof PDFRef) return replace.get(v.tag) ?? v;
    if (v instanceof PDFDict) { for (const [k, x] of v.entries()) v.set(k, fix(x)); return v; }
    if (v instanceof PDFArray) { for (let i = 0; i < v.size(); i++) v.set(i, fix(v.get(i))); return v; }
    return v;
  };
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (o instanceof PDFDict || o instanceof PDFArray) fix(o);
    else if (o?.dict instanceof PDFDict) fix(o.dict);
  }
  for (const tag of replace.keys()) {
    const [n, g] = tag.split(' ').map(Number);
    ctx.delete(PDFRef.of(n, g));
  }
  return replace.size;
}

// Prepare an uploaded master once: unlock, check the boxes, drop stray boxes, slim it.
// The boxes stay as form fields so each contract can fill them in.
export async function prepareMaster(bytes, template) {
  const doc = await open(bytes);
  const form = doc.getForm();
  const fields = form.getFields();
  const byName = new Map(fields.map(f => [f.getName(), f]));
  const required = Object.values(template.fields);
  const missing = required.filter(n => !(byName.get(n) instanceof PDFTextField));
  if (missing.length) throw new MasterError(`The PDF is missing these boxes: ${missing.join(', ')}.`);

  const fieldRects = {};
  for (const name of required) {
    const widget = byName.get(name).acroField.getWidgets()[0];
    const r = widget.getRectangle();
    fieldRects[name] = { page: pageIndexOf(doc, widget), x: r.x, y: r.y, width: r.width, height: r.height };
  }
  for (const name of template.dropFields) if (byName.has(name)) form.removeField(byName.get(name));

  dropEncryptionLeftovers(doc.context);
  mergeDuplicateImages(doc.context);

  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, sha256: sha256Hex(out), pageCount: doc.getPageCount(), fieldRects };
}
