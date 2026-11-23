import zlib from 'node:zlib';
import { HttpError } from './http.js';
import { enabledBases } from './templates.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UK_MOBILE = /^(?:\+447\d{9}|07\d{9})$/;
const str = v => (v === undefined || v === null ? '' : String(v)).trim();

// Tidy free text: composed accents (NFC), no broken emoji halves, no control characters.
export function cleanText(v, replacement = ' ') {
  return String(v ?? '').normalize('NFC').toWellFormed()
    .replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, replacement).replace(/\s+/g, ' ').trim();
}

export function normaliseMobile(v) {
  return str(v).replace(/[\s-]/g, '');
}

// Check a draft from the New Terms of Sale form. errors is keyed by field path.
export function validateDraft(input = {}, template) {
  const errors = {};
  const list = Array.isArray(input.signers) ? input.signers : [];
  if (!list.length) errors.signers = 'Add at least one seller.';
  else if (list.length > 6) errors.signers = 'Up to 6 sellers.';

  const signers = list.slice(0, 6).map((s, i) => {
    const name = cleanText(s?.name);
    const email = str(s?.email).toLowerCase();
    const mobile = normaliseMobile(s?.mobile);
    if (!name) errors[`signers.${i}.name`] = 'Enter the seller’s name.';
    else if (name.length > 100) errors[`signers.${i}.name`] = 'Names can be up to 100 characters.';
    if (!EMAIL.test(email)) errors[`signers.${i}.email`] = 'Enter a valid email address.';
    if (i === 0 && !UK_MOBILE.test(mobile)) errors[`signers.${i}.mobile`] = 'Enter a UK mobile number, like 07700 900123.';
    else if (i > 0 && mobile && !UK_MOBILE.test(mobile)) errors[`signers.${i}.mobile`] = 'Enter a UK mobile number or leave it blank.';
    return { name, email, mobile };
  });
  for (const s of signers) s.sharedEmail = signers.filter(o => o.email && o.email === s.email).length > 1;

  const propertyAddress = String(input.propertyAddress ?? '').split(/\r\n|\r|\n/).map(x => cleanText(x)).filter(Boolean).join(', ');
  if (!propertyAddress) errors.propertyAddress = 'Enter the property address.';
  else if (propertyAddress.length > 120) errors.propertyAddress = 'Keep the address to 120 characters so it fits on the contract.';

  const basis = str(input.basis) || 'sole';
  const bases = enabledBases(template);
  const chosen = bases.find(b => b.key === basis);
  if (!chosen) errors.basis = 'Choose a basis of appointment.';
  const otherAgent = str(input.otherAgent);
  if (chosen?.needsOtherAgent && !otherAgent) errors.otherAgent = 'Enter the other agent’s name.';

  const feeError = checkFee(input.feePercent);
  if (feeError) errors.feePercent = feeError;
  const feePercent = Number(input.feePercent);

  const guidePrice = Number(input.guidePrice);
  if (!Number.isInteger(guidePrice) || guidePrice < 1 || guidePrice > 100_000_000) errors.guidePrice = 'Enter the guide price in whole pounds.';

  return {
    value: { signers, propertyAddress, basis, otherAgent: chosen?.needsOtherAgent ? otherAgent : null, feePercent, guidePrice },
    errors,
  };
}

export function checkFee(v) {
  const fee = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(fee) || fee < 0.1 || fee > 10) return 'Enter a fee between 0.1% and 10%.';
  if (Math.abs(fee * 100 - Math.round(fee * 100)) > 1e-9) return 'Use at most 2 decimal places.';
  return null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 150_000;
const MAX_WIDTH = 3000;
const MAX_HEIGHT = 1500;

// Walk the PNG's chunks: a sensible size, every chunk's checksum right, image data that
// unpacks, and nothing after the end. A signature that passes this can always go in the PDF.
function checkPng(bytes) {
  if (bytes.length < 8 || bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return false;
  let pos = 8, ihdr = null, sawEnd = false;
  const idat = [];
  while (pos + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > bytes.length) return false;
    if ((zlib.crc32(bytes.subarray(pos + 4, pos + 8 + len)) >>> 0) !== bytes.readUInt32BE(pos + 8 + len)) return false;
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { sawEnd = true; pos = end; break; }
    pos = end;
  }
  if (!sawEnd || pos !== bytes.length || !ihdr || ihdr.length !== 13 || !idat.length) return false;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  if (!width || !height || width > MAX_WIDTH || height > MAX_HEIGHT) return false;
  if (ihdr[8] !== 8 || ![0, 2, 4, 6].includes(ihdr[9]) || ihdr[12] !== 0) return false;   // 8-bit, non-interlaced
  try {
    const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (width * 4 + 1) * height + 1 });
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr[9]];
    return raw.length === (width * channels + 1) * height;
  } catch { return false; }
}

// A signature arrives from the browser as a PNG data URL.
export function parsePngDataUrl(s) {
  const prefix = 'data:image/png;base64,';
  if (typeof s !== 'string' || !s.startsWith(prefix) || s.length > MAX_PNG_BYTES * 1.4 + prefix.length) throw new HttpError(400, 'Please sign again.');
  const bytes = Buffer.from(s.slice(prefix.length), 'base64');
  if (!checkPng(bytes)) throw new HttpError(400, 'Please sign again.');
  return new Uint8Array(bytes);
}
