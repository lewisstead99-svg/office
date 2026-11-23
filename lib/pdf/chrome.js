// Build the "chrome" (logo + footer strip) for pages we add, from page 1's own drawing instructions.
// We keep only what is painted inside the header and footer boxes, so the added pages don't carry
// page 1's letter text invisibly (it would show up in search and copy-paste).
import { PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

// Split a content stream into instructions: { operands: string[], op: string }.
export function parseContent(src) {
  const out = [];
  let operands = [];
  let i = 0;
  const n = src.length;
  const skipString = () => {             // at '(' — balanced, with escapes
    const from = i;
    let depth = 0;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { i++; return; }
    }
    throw new Error(`Unterminated string at ${from}`);
  };
  const skipNested = (open, close) => {  // arrays [..] and dicts <<..>>, which may contain strings
    let depth = 0;
    while (i < n) {
      if (src[i] === '(') { skipString(); continue; }
      if (src.startsWith(open, i)) { depth++; i += open.length; continue; }
      if (src.startsWith(close, i)) { depth--; i += close.length; if (depth === 0) return; continue; }
      i++;
    }
    throw new Error('Unterminated ' + open);
  };
  while (i < n) {
    const c = src[i];
    if (WS.has(c)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    const start = i;
    if (c === '(') skipString();
    else if (c === '<' && src[i + 1] === '<') skipNested('<<', '>>');
    else if (c === '<') { i = src.indexOf('>', i); if (i < 0) throw new Error('Unterminated hex string'); i++; }
    else if (c === '[') skipNested('[', ']');
    else if (c === '/') { i++; while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i++; }
    else {
      while (i < n && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
      if (i === start) i++;
      const word = src.slice(start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) || word === 'true' || word === 'false' || word === 'null') { operands.push(word); continue; }
      if (word === 'BI') throw new Error('Inline images are not supported here');
      out.push({ operands, op: word });
      operands = [];
      continue;
    }
    operands.push(src.slice(start, i));
  }
  return out;
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const inside = (boxes, [x, y]) => boxes.some(b => x >= b.left - 2 && x <= b.right + 2 && y >= b.bottom - 2 && y <= b.top + 2);

// Keep the instructions that paint inside the boxes: paths, colours and state are always kept
// (they hold no text, and the drawing is clipped to the boxes anyway); text and XObjects only
// when they start inside a box.
export function filterContent(instructions, boxes) {
  const I = [1, 0, 0, 1, 0, 0];
  let ctm = I, stack = [];
  let tm = I, tlm = I, leading = 0;
  const kept = [];
  const nums = ops => ops.map(Number);
  for (const ins of instructions) {
    const { op, operands } = ins;
    let keep = true;
    switch (op) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? I; break;
      case 'cm': ctm = mul(nums(operands), ctm); break;
      case 'BT': tm = tlm = I; break;
      case 'Tm': tm = tlm = nums(operands); break;
      case 'TL': leading = Number(operands[0]); break;
      case 'Td': case 'TD': {
        const [tx, ty] = nums(operands);
        if (op === 'TD') leading = -ty;
        tm = tlm = mul([1, 0, 0, 1, tx, ty], tlm);
        break;
      }
      case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); break;
      case "'": case '"':
        tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        keep = inside(boxes, apply(mul(tm, ctm), 0, 0));
        break;
      case 'Tj': case 'TJ':
        keep = inside(boxes, apply(mul(tm, ctm), 0, 0));
        break;
      case 'Do':
        keep = inside(boxes, apply(ctm, 0, 0)) || inside(boxes, apply(ctm, 0.5, 0.5));
        break;
      default: break;
    }
    if (keep) kept.push(ins);
  }
  return kept.map(x => [...x.operands, x.op].join(' ')).join('\n');
}

function pageSource(doc, page) {
  const contents = page.node.get(PDFName.of('Contents'));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  return refs.map(r => {
    const s = doc.context.lookup(r);
    // Streams read from the file are raw (decode them); streams the library added in memory hold
    // their operators and must be read unencoded, not as compressed bytes.
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode()
      : typeof s.getUnencodedContents === 'function' ? s.getUnencodedContents() : s.getContents();
    return Buffer.from(bytes).toString('latin1');
  }).join('\n');
}

// A Form XObject with just page 1's header and footer drawing. Returns its ref, or null if page 1's
// content can't be read safely (the caller then falls back to embedding the whole page).
export function chromeFromPage(doc, page, boxes) {
  try {
    const resources = page.node.Resources();
    if (!resources) return null;
    const filtered = filterContent(parseContent(pageSource(doc, page)), boxes);
    const { width, height } = page.getSize();
    const stream = doc.context.flateStream(Buffer.from(filtered, 'latin1'), {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height], Resources: resources,
    });
    return doc.context.register(stream);
  } catch (e) {
    console.error('Could not build the page header/footer from page 1:', e.message);
    return null;
  }
}
