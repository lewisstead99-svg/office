import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { makePng } from './pdf.js';

// Page-1 box positions measured from the real master: [x, y, width, height].
export const FIXTURE_RECTS = {
  'Client': [164, 638, 380, 17], 'Property Address': [165, 615, 378, 17], 'Mobile Telephone': [164, 593, 379, 17],
  'Email Address': [164, 571, 379, 17], 'Text Field 3': [92, 459, 24, 17], 'Text Field 2': [92, 355, 100, 19],
  'Text Field 1': [262, 333, 61, 16], 'Initials 1': [196, 310, 49, 18], 'For the Vendor': [121, 169, 156, 21],
  'For Berkeleys': [407, 171, 151, 20], 'Name': [89, 139, 189, 18], 'Name 1': [378, 140, 180, 17],
  'Date': [89, 115, 188, 19], 'Date 1': [379, 117, 179, 16],
};

// A made-up 3-page master shaped like the real one: the same named boxes on page 1,
// the same small image embedded separately on every page, and (by default) locked
// with an empty opening password like an Adobe Sign export.
export async function makeFixtureMaster({ encrypted = true, userPassword = '', omit = [] } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const png = makePng();
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Fixture master page ${i + 1}`, { x: 72, y: 760, size: 12, font });
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 60, y: 760, width: 60, height: 30 });
    page.drawImage(img, { x: 20, y: 20, width: 40, height: 20 });
  }
  const form = doc.getForm();
  const p1 = doc.getPage(0);
  for (const [name, [x, y, width, height]] of Object.entries(FIXTURE_RECTS)) {
    if (omit.includes(name)) continue;
    form.createTextField(name).addToPage(p1, { x, y, width, height, borderWidth: 0 });
  }
  if (encrypted) doc.encrypt({ userPassword, ownerPassword: 'owner' });
  return doc.save();
}
