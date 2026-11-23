// Email wording. Every value is HTML-escaped; links appear as a button and as plain text.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SIGN_OFF = 'Berkeleys Drummond, 01202 708383';

function layout(paragraphs, button) {
  const ps = paragraphs.map(p => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('');
  const btn = button
    ? `<p style="margin:22px 0"><a href="${esc(button.href)}" style="background:#026b6b;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${esc(button.label)}</a></p>
<p style="margin:0 0 14px;font-size:13px;color:#4a5d5e">Or copy this link: ${esc(button.href)}</p>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#17292a;max-width:560px">${ps}${btn}<p style="margin:22px 0 0;color:#4a5d5e">${esc(SIGN_OFF)}</p></div>`;
}
const textOf = (paragraphs, link) => [...paragraphs, ...(link ? [link] : []), SIGN_OFF].join('\n\n');

export function signingRequestEmail({ signerName, propertyAddress, senderName, link, kind }) {
  const fee = kind === 'fee_change';
  const subject = fee ? `Please sign: updated fee for ${propertyAddress}` : `Please sign: Terms of Sale for ${propertyAddress}`;
  const paras = [
    `Dear ${signerName},`,
    fee
      ? `${senderName} at Berkeleys Drummond has sent you an updated Terms of Sale for ${propertyAddress}, with the new fee you agreed. Please read it and sign online.`
      : `${senderName} at Berkeleys Drummond has sent you our Terms of Sale for ${propertyAddress}. Please read them and sign online. It takes a couple of minutes on your phone or computer.`,
    'This link is just for you. Please do not forward it.',
  ];
  return { subject, text: textOf(paras, link), html: layout(paras, { href: link, label: 'Review and sign' }) };
}

export function reminderEmail({ signerName, propertyAddress, senderName, link }) {
  const subject = `Reminder: please sign the Terms of Sale for ${propertyAddress}`;
  const paras = [
    `Dear ${signerName},`,
    `A reminder that the Terms of Sale for ${propertyAddress}, sent by ${senderName}, are still waiting for your signature.`,
    'If you have any questions, just call us.',
  ];
  return { subject, text: textOf(paras, link), html: layout(paras, { href: link, label: 'Review and sign' }) };
}

export function signedCopyEmail({ propertyAddress, ref }) {
  const subject = `Signed: Terms of Sale for ${propertyAddress}`;
  const paras = [
    `The Terms of Sale for ${propertyAddress} have now been signed by everyone. The signed copy is attached (reference ${ref}).`,
    'Please keep it for your records.',
  ];
  return { subject, text: textOf(paras), html: layout(paras) };
}

export function cancelledEmail({ signerName, propertyAddress }) {
  const subject = `Cancelled: Terms of Sale for ${propertyAddress}`;
  const paras = [
    `Dear ${signerName},`,
    `The Terms of Sale we sent you for ${propertyAddress} have been cancelled, so there is nothing to sign. If you were not expecting this, please call us.`,
  ];
  return { subject, text: textOf(paras), html: layout(paras) };
}

export function expiredNoticeEmail({ propertyAddress }) {
  const subject = `Expired unsigned: ${propertyAddress}`;
  const paras = [
    `The Terms of Sale for ${propertyAddress} were not signed within 30 days, so the signing links have stopped working.`,
    'Open Berkeleys Office to send a new one if it is still needed.',
  ];
  return { subject, text: textOf(paras), html: layout(paras) };
}
