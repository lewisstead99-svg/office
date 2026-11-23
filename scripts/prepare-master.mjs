// Check a master copy locally: node scripts/prepare-master.mjs <in.pdf> <out.pdf>
import fs from 'node:fs';
import { prepareMaster } from '../lib/pdf/master.js';
import { TERMS_OF_SALE } from '../lib/templates.js';

const [, , input, output] = process.argv;
if (!input || !output) { console.error('Usage: node scripts/prepare-master.mjs <in.pdf> <out.pdf>'); process.exit(1); }
const src = new Uint8Array(fs.readFileSync(input));
const out = await prepareMaster(src, TERMS_OF_SALE);
fs.writeFileSync(output, out.bytes);
console.log(`Before: ${(src.length / 1024).toFixed(0)} KB  After: ${(out.bytes.length / 1024).toFixed(0)} KB  Pages: ${out.pageCount}`);
console.log(`sha256: ${out.sha256}`);
console.log('Boxes:', Object.keys(out.fieldRects).join(', '));
