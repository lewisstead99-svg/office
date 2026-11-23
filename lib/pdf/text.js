// Text helpers for the PDF's standard fonts (WinAnsi: Latin-1 plus a few extras).

const EXPLICIT = { 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h', 'ı': 'i', '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '\u00a0': ' ' };

// The standard fonts use WinAnsi encoding: Latin-1 plus these Windows-1252 extras.
// (The library silently draws other characters as garbage, so check the set ourselves.)
const CP1252_EXTRAS = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const canDraw = (_font, ch) => {
  const cp = ch.codePointAt(0);
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRAS.has(ch);
};

// Replace characters the font cannot draw: explicit map, else the plain base letter, else "?".
export function safeText(font, s) {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFC').replace(/[\r\n\t]+/g, ' ')) {
    const mapped = EXPLICIT[ch] ?? ch;
    if (canDraw(font, mapped)) { out += mapped; continue; }
    const base = mapped.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    out += base && [...base].every(c => canDraw(font, c)) ? base : '?';
  }
  return out;
}

// Shrink text to fit a width (down to min), then cut it with an ellipsis.
export function fitText(font, text, width, { max = 10, min = 5 } = {}) {
  for (let size = max; size >= min; size -= 0.5) {
    if (font.widthOfTextAtSize(text, size) <= width) return { text, size };
  }
  let cut = text;
  while (cut.length && font.widthOfTextAtSize(cut + '…', min) > width) cut = cut.slice(0, -1);
  return { text: cut.trimEnd() + '…', size: min };
}

// Break text into lines no wider than width (breaking long words if needed).
export function wrap(font, text, size, width) {
  const lines = [];
  let line = '';
  const fits = t => font.widthOfTextAtSize(t, size) <= width;
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) { line = candidate; continue; }
    if (line) lines.push(line);
    if (fits(word)) { line = word; continue; }
    let chunk = '';
    for (const ch of word) {
      if (fits(chunk + ch)) chunk += ch;
      else { lines.push(chunk); chunk = ch; }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}

export const formatFee = n => `${Number(Number(n).toFixed(2))}%`;
export const formatPrice = n => '£' + Number(n).toLocaleString('en-GB');
export function joinNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
