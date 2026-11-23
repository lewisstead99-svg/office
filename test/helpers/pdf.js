import zlib from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

// A small solid-colour RGB PNG (no alpha), built by hand.
export function makePng(w = 8, h = 4, rgb = [10, 90, 90]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
export const pngDataUrl = (png = makePng()) => 'data:image/png;base64,' + Buffer.from(png).toString('base64');

export function countImageObjects(doc) {
  return doc.context.enumerateIndirectObjects()
    .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')).length;
}

const WIN = { 0x85: '…', 0x96: '–', 0x97: '—', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•' };
const decodeBytes = buf => [...buf].map(b => WIN[b] || String.fromCharCode(b)).join('');
function unescapeLiteral(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
}
function textFromContent(src) {
  const out = [];
  const re = /<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) out.push(decodeBytes(Buffer.from(m[1].replace(/\s/g, ''), 'hex')));
    else if (m[2] !== undefined) out.push(unescapeLiteral(m[2]));
    else {
      const parts = [...m[3].matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)/g)];
      out.push(parts.map(p => (p[1] !== undefined ? decodeBytes(Buffer.from(p[1].replace(/\s/g, ''), 'hex')) : unescapeLiteral(p[2]))).join(''));
    }
  }
  return out.join('\n');
}
function streamText(stream) {
  const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents?.() ?? new Uint8Array();
  return Buffer.from(bytes).toString('latin1');
}

// Text drawn on one page, following the form XObjects it actually draws (\`/Name Do\`), two levels deep.
export async function pageText(bytes, pageIndex) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const ctx = doc.context;
  const contents = page.node.get(PDFName.of('Contents'));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const pieces = [];
  const drawn = src => new Set([...src.matchAll(/\/([^\s/\[\]()<>]+)\s+Do\b/g)].map(m => m[1]));
  function walk(src, resources, depth) {
    pieces.push(src);
    if (depth > 2) return;
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return;
    const used = drawn(src);
    for (const [name, ref] of xobjects.entries()) {
      if (!used.has(name.asString().slice(1))) continue;
      const x = ctx.lookup(ref);
      if (x?.dict?.get(PDFName.of('Subtype')) !== PDFName.of('Form')) continue;
      walk(streamText(x), x.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), depth + 1);
    }
  }
  walk(refs.map(r => streamText(ctx.lookup(r))).join('\n'), page.node.Resources(), 0);
  return textFromContent(pieces.join('\n'));
}

export const isRef = v => v instanceof PDFRef;
