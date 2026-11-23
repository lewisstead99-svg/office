// Where things go on the pages added after page 1 of the Letter.
// Page 0 is the Letter (the lead seller signs there). Additional-signatory pages follow,
// four sellers per page, then the right-to-cancel page.
export function extraPagesLayout(signerCount) {
  const extra = Math.max(0, signerCount - 1);
  const additionalPageCount = Math.ceil(extra / 4);
  const blocks = [];
  for (let k = 0; k < extra; k++) {
    const i = k % 4;
    const top = 650 - i * 140;
    blocks.push({
      signerIndex: k + 1,
      pageIndex: 1 + Math.floor(k / 4),
      top,
      signature: { x: 72, y: top - 70, width: 220, height: 44 },
      initials: { x: 320, y: top - 70, width: 80, height: 44 },
      name: { x: 72, y: top - 92, width: 220, height: 14 },
      date: { x: 320, y: top - 92, width: 180, height: 14 },
    });
  }
  const ticks = Array.from({ length: signerCount }, (_, i) => ({ signerIndex: i, x: 72, y: 430 - 26 * i, size: 12 }));
  return { additionalPageCount, blocks, cancelPageIndex: 1 + additionalPageCount, ticks };
}
