import { api } from './api.js';
import { h } from './ui.js';
import { createSignaturePad, typedSignaturePng } from './signature-pad.js';

// The seller's own words for the box; the signed PDF records it as "{name} asks Berkeleys Drummond…".
const MARKETING_TICK = 'I ask Berkeleys Drummond to start marketing the property now, during the 14-day cancellation period.';
const root = document.getElementById('sign');
const token = location.pathname.split('/')[2] || '';
const docUrl = `/api/sign/${encodeURIComponent(token)}/document.pdf`;

const initialsOf = name => name.split(/\s+/).filter(Boolean).map(w => Array.from(w)[0].toUpperCase()).join('').slice(0, 6);

function message(text, { download = false } = {}) {
  root.replaceChildren(h('div', { class: 'card' },
    h('p', {}, text),
    download ? h('a', { class: 'btn primary big', href: docUrl, target: '_blank', rel: 'noopener' }, 'Download your copy (PDF)') : null,
    h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Questions? Call Berkeleys Drummond on 01202 708383.')));
}

async function start() {
  let v;
  try { v = await api('GET', `/api/sign/${encodeURIComponent(token)}`); }
  catch (e) { return message(e.message); }
  if (!v.canSign) return message(v.message || 'This link can no longer be used.', { download: v.documentAvailable });
  render(v);
}

function render(v) {
  const name = v.signer.name;
  const isFee = v.contract.kind === 'fee_change';
  const identity = h('input', { type: 'checkbox', id: 'identity' });
  const consent = h('input', { type: 'checkbox', id: 'consent' });
  const marketing = h('input', { type: 'checkbox', id: 'marketing' });
  const initials = h('input', { type: 'text', id: 'initials', maxlength: 6, value: initialsOf(name), autocomplete: 'off', style: 'max-width:140px' });

  let mode = 'draw';
  const canvas = h('canvas', { 'aria-label': 'Draw your signature with your finger or mouse' });
  const padBox = h('div', { class: 'sigpad' }, canvas, h('div', { class: 'base' }), h('span', { class: 'hint-on' }, 'Sign above the line'));
  const typed = h('input', { type: 'text', id: 'typed', value: name, autocomplete: 'name' });
  const typedPreview = h('div', { class: 'typed', 'aria-hidden': 'true' }, name);
  typed.addEventListener('input', () => { typedPreview.textContent = typed.value; update(); });
  const typedBox = h('div', { hidden: true }, h('div', { class: 'field' }, h('label', { for: 'typed' }, 'Type your name'), typed), typedPreview);
  const drawBtn = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Draw');
  const typeBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Type');
  const clearRow = h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn small', onclick: () => { pad.clear(); update(); } }, 'Clear'));
  const setMode = m => { mode = m; drawBtn.setAttribute('aria-pressed', String(m === 'draw')); typeBtn.setAttribute('aria-pressed', String(m === 'type')); padBox.hidden = m !== 'draw'; typedBox.hidden = m !== 'type'; clearRow.hidden = m !== 'draw'; update(); };
  drawBtn.onclick = () => setMode('draw');
  typeBtn.onclick = () => setMode('type');

  const error = h('p', { class: 'form-error', 'aria-live': 'polite' });
  const signBtn = h('button', { type: 'button', class: 'btn primary big', disabled: true }, 'Sign');
  let pad;
  function ready() {
    const hasSig = mode === 'draw' ? pad && !pad.isEmpty() : typed.value.trim().length > 0;
    return consent.checked && (!v.sharedEmail || identity.checked) && initials.value.trim().length > 0 && hasSig;
  }
  function update() { signBtn.disabled = !ready(); }
  for (const el of [identity, consent, initials]) el.addEventListener('input', update);
  for (const el of [identity, consent]) el.addEventListener('change', update);

  const box = (input, label) => h('label', { class: 'check', for: input.id }, input, h('span', {}, label));

  root.replaceChildren(...[
    h('div', { class: 'card' },
      h('h1', {}, `Hello ${name}`),
      h('p', {}, `${v.contract.senderName || 'Berkeleys Drummond'} at Berkeleys Drummond has sent you ${isFee ? 'an updated Terms of Sale with your new fee' : 'our Terms of Sale'} for `, h('strong', {}, v.contract.propertyAddress), '.'),
      h('a', { class: 'btn big', href: docUrl, target: '_blank', rel: 'noopener' }, 'Read the document (PDF)'),
      v.otherSigners.length ? h('ul', { class: 'others' }, v.otherSigners.map(o => h('li', {}, `${o.name}: ${o.signed ? 'has signed' : 'not signed yet'}`))) : null),
    v.sharedEmail ? h('div', { class: 'step' }, box(identity, `I am ${name}`)) : null,
    h('div', { class: 'step' }, box(consent, 'I have read the Letter and the Terms and Conditions of Business, and I agree to sign them electronically.')),
    h('div', { class: 'step card' },
      h('h2', {}, 'Starting marketing now'),
      box(marketing, MARKETING_TICK),
      h('p', { class: 'hint' }, 'If you don’t tick this, we’ll wait until the 14-day cancellation period ends before marketing.')),
    h('div', { class: 'step card' },
      h('h2', {}, 'Your signature'),
      h('div', { class: 'tabsmall' }, drawBtn, typeBtn),
      padBox, typedBox, clearRow,
      h('div', { class: 'field', style: 'margin-top:12px' }, h('label', { for: 'initials' }, 'Initials'), initials)),
    h('div', { class: 'step' }, error, signBtn),
  ].filter(Boolean));

  pad = createSignaturePad(canvas, { onChange: update });

  signBtn.onclick = async () => {
    if (!ready()) return;
    signBtn.disabled = true;
    error.textContent = '';
    try {
      const signaturePng = mode === 'draw' ? pad.toPng() : await typedSignaturePng(typed.value.trim());
      const r = await api('POST', `/api/sign/${encodeURIComponent(token)}`, {
        consent: true, confirmIdentity: v.sharedEmail ? identity.checked : false, startMarketingNow: marketing.checked,
        signaturePng, initials: initials.value.trim(),
      });
      root.replaceChildren(h('div', { class: 'card' },
        h('h1', {}, 'Thank you, you’ve signed'),
        h('p', {}, r.allSigned ? 'Everyone has now signed. We’re emailing you the signed copy, and you can download it now.' : 'We’ll email you the signed copy once everyone has signed.'),
        r.allSigned ? h('a', { class: 'btn primary big', href: docUrl, target: '_blank', rel: 'noopener' }, 'Download your signed copy (PDF)') : null,
        h('p', { class: 'small muted', style: 'margin-top:14px' }, 'You can close this page.')));
      window.scrollTo(0, 0);
    } catch (e) {
      error.textContent = e.message;
      if (e.status === 409 && !e.retry) return message(e.message);   // the contract has moved on (signed, cancelled…)
      update();                                                         // a busy moment: they can just press Sign again
    }
  };
}

start();
