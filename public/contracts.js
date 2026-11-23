import { api } from './api.js';
import { h, clear, toast, ask, fmtDate, fmtDateTime, fmtPrice, fmtFee, todayLondon } from './ui.js';

const TABS = [['out', 'Out for signing'], ['cooling', 'Cooling off'], ['signed', 'Signed'], ['ended', 'Ended'], ['drafts', 'Drafts']];
const EMPTY = { out: 'Nothing out for signing.', cooling: 'Nothing in its cooling-off period.', signed: 'No signed contracts yet.', ended: 'Nothing has ended yet.', drafts: 'No drafts.' };
const pillClass = state => ({ out: 'out', cooling: 'cooling', signed: 'signed', draft: 'draft' }[state] || '');

// ---------- Tracker ----------

export async function renderTracker(main, { go, onLeave }) {
  const params = new URLSearchParams(location.search);
  let tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'out';
  let mine = params.get('mine') === '1';
  let q = params.get('q') || '';
  let limit = 200;

  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Contracts by status' });
  const listEl = h('div', { class: 'rows', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search address or seller', 'aria-label': 'Search address or seller', value: q });
  const everyoneBtn = h('button', { type: 'button' }, 'Everyone');
  const mineBtn = h('button', { type: 'button' }, 'Mine');

  main.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, 'Contracts'), h('h1', {}, 'Terms of Sale')),
      h('a', { class: 'btn primary', href: '/contracts/new', 'data-link': true }, 'New Terms of Sale')),
    tabsEl,
    h('div', { class: 'toolbar' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Whose contracts' }, everyoneBtn, mineBtn), search),
    listEl);

  function syncUrl() {
    const u = new URLSearchParams();
    if (tab !== 'out') u.set('tab', tab);
    if (mine) u.set('mine', '1');
    if (q) u.set('q', q);
    history.replaceState({}, '', `/contracts${u.toString() ? '?' + u : ''}`);
  }

  async function load() {
    const u = new URLSearchParams({ tab, limit: String(limit) });
    if (mine) u.set('mine', '1');
    if (q) u.set('q', q);
    let data;
    try { data = await api('GET', `/api/contracts?${u}`); }
    catch (e) { listEl.replaceChildren(h('div', { class: 'banner bad' }, e.message)); return; }
    everyoneBtn.setAttribute('aria-pressed', String(!mine));
    mineBtn.setAttribute('aria-pressed', String(mine));
    tabsEl.replaceChildren(...TABS.map(([key, label]) => h('button', {
      type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(key === tab),
      onclick: () => { tab = key; limit = 200; syncUrl(); load(); },
    }, label, h('span', { class: 'n' }, String(data.counts[key] ?? 0)))));
    if (!data.rows.length) { listEl.replaceChildren(h('div', { class: 'empty' }, q ? `Nothing matches “${q}”.` : EMPTY[tab])); return; }
    const rowActions = r => r.state !== 'out' ? null : h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn small', onclick: async e => {
        e.stopPropagation();
        try { await api('POST', `/api/contracts/${r.id}/chase`, {}); toast('Reminder sent.'); } catch (err) { toast(err.message, 'bad'); }
        load();
      } }, 'Chase'),
      h('button', { type: 'button', class: 'btn small danger', onclick: async e => {
        e.stopPropagation();
        const v = await ask({ title: 'Cancel this contract?', intro: `${r.propertyAddress}. The signing links stop working and sellers who haven’t signed get an email.`, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], submit: 'Cancel contract', danger: true });
        if (!v) return;
        try { await api('POST', `/api/contracts/${r.id}/cancel`, { reason: v.reason }); toast('Contract cancelled.'); } catch (err) { toast(err.message, 'bad'); }
        load();
      } }, 'Cancel'));
    const more = data.more ? h('div', { class: 'more' }, h('button', { type: 'button', class: 'btn', onclick: () => { limit += 200; load(); } }, 'Show more')) : null;
    listEl.replaceChildren(...data.rows.map(r => h('div', { class: 'row', onclick: e => { if (!e.target.closest('button, a')) go(`/contracts/${r.id}`); } },
      h('div', {}, h('a', { class: 'addr', href: `/contracts/${r.id}`, 'data-link': true }, r.propertyAddress), r.kind === 'fee_change' ? h('span', { class: 'tag' }, `Fee change v${r.version}`) : null,
        h('div', { class: 'sub' }, r.clientNames)),
      h('div', { class: 'meta hide-sm' }, r.sentAt ? `Sent by ${r.senderName}` : `Drafted by ${r.senderName}`, h('br'), r.sentAt ? fmtDate(r.sentAt) : fmtDate(r.createdAt)),
      h('div', { class: 'meta' }, r.state === 'out' ? `${r.signedCount} of ${r.signerCount} signed` : '', r.state === 'out' ? h('br') : null,
        r.daysWaiting !== null ? `${r.daysWaiting} day${r.daysWaiting === 1 ? '' : 's'} waiting` : ''),
      h('div', { class: 'right' }, h('span', { class: `pill ${pillClass(r.state)}` }, r.label), rowActions(r)))), ...(more ? [more] : []));
  }

  everyoneBtn.onclick = () => { mine = false; syncUrl(); load(); };
  mineBtn.onclick = () => { mine = true; syncUrl(); load(); };
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value.trim(); syncUrl(); load(); }, 300); });
  await load();
  const poll = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
  onLeave(() => clearInterval(poll));
}

// ---------- New / draft form ----------

export async function renderNewContract(main, ctx) {
  return renderDraftForm(main, ctx, null);
}

function errorFor(errors, key) {
  return errors?.[key] ? h('p', { class: 'error' }, errors[key]) : null;
}

async function renderDraftForm(main, { hub, go }, detail) {
  const isFee = detail?.contract.kind === 'fee_change';
  const { png: signature } = await api('GET', '/api/me/signature');
  const c = detail?.contract;
  const state = {
    signers: detail ? detail.signers.map(s => ({ name: s.name, email: s.email, mobile: s.mobile || '' })) : [{ name: '', email: '', mobile: '' }],
    propertyAddress: c?.fields.propertyAddress || '',
    basis: c?.fields.basis || 'sole',
    otherAgent: c?.fields.otherAgent || '',
    feePercent: c?.fields.feePercent ?? '',
    guidePrice: c?.fields.guidePrice ?? '',
    note: c?.note || '',
  };
  let errors = {};
  const formEl = h('form', { class: 'form-grid', novalidate: true });
  const bases = hub.bases || [{ key: 'sole', label: 'Sole' }];

  function field(key, label, input, hint) {
    return h('div', { class: `field${errors[key] ? ' has-error' : ''}` }, h('label', { for: key }, label), input, hint ? h('p', { class: 'hint' }, hint) : null, errorFor(errors, key));
  }
  const bind = (obj, key) => e => { obj[key] = e.target.value; };

  function sellerBlock(s, i) {
    const k = f => `signers.${i}.${f}`;
    return h('div', { class: 'seller' },
      h('div', { class: 'seller-head' }, i === 0 ? 'Lead seller' : `Seller ${i + 1}`,
        i > 0 && !isFee ? h('button', { type: 'button', class: 'btn small', onclick: () => { state.signers.splice(i, 1); draw(); } }, 'Remove') : null),
      h('div', { class: 'three' },
        field(k('name'), 'Full name', h('input', { id: k('name'), type: 'text', value: s.name, autocomplete: 'off', oninput: bind(s, 'name'), disabled: isFee })),
        field(k('email'), 'Email', h('input', { id: k('email'), type: 'email', value: s.email, autocomplete: 'off', oninput: bind(s, 'email'), disabled: isFee })),
        field(k('mobile'), i === 0 ? 'Mobile' : 'Mobile (optional)', h('input', { id: k('mobile'), type: 'tel', value: s.mobile, autocomplete: 'off', oninput: bind(s, 'mobile'), disabled: isFee }))));
  }

  function sharedWarning() {
    const emails = state.signers.map(s => s.email.trim().toLowerCase()).filter(Boolean);
    return emails.length !== new Set(emails).size ? h('div', { class: 'banner' }, 'Two sellers share this email. Each will still get their own link.') : null;
  }

  function priceInput() {
    const el = h('input', { id: 'guidePrice', type: 'text', inputmode: 'numeric', value: state.guidePrice ? Number(state.guidePrice).toLocaleString('en-GB') : '', disabled: isFee });
    el.addEventListener('input', () => {
      const digits = el.value.replace(/\D/g, '').slice(0, 9);
      state.guidePrice = digits ? Number(digits) : '';
      el.value = digits ? Number(digits).toLocaleString('en-GB') : '';
    });
    return h('div', { class: 'affix pre' }, h('span', {}, '£'), el);
  }

  function draw() {
    const basisChoice = bases.length === 1
      ? h('div', { class: 'readonly' }, `${bases[0].label} agency`)
      : h('div', { class: 'radio-row', role: 'radiogroup' }, bases.map(b => h('label', {}, h('input', { type: 'radio', name: 'basis', value: b.key, checked: state.basis === b.key, disabled: isFee, onchange: () => { state.basis = b.key; draw(); } }), b.label)));
    const needsOther = bases.find(b => b.key === state.basis)?.needsOtherAgent;
    formEl.replaceChildren(...[
      isFee ? h('div', { class: 'banner' }, `Fee change (v${c.version}). Only the fee can change; everything else is copied from the signed contract.`) : null,
      h('section', { class: 'card' },
        h('h2', {}, 'Sellers'),
        h('div', { class: 'form-grid' }, state.signers.map(sellerBlock), sharedWarning(), errorFor(errors, 'signers'),
          !isFee && state.signers.length < 6 ? h('div', {}, h('button', { type: 'button', class: 'btn small', onclick: () => { state.signers.push({ name: '', email: '', mobile: '' }); draw(); } }, '+ Add another seller')) : null)),
      h('section', { class: 'card' },
        h('h2', {}, 'Property and terms'),
        h('div', { class: 'form-grid' },
          field('propertyAddress', 'Property address', h('input', { id: 'propertyAddress', type: 'text', value: state.propertyAddress, oninput: bind(state, 'propertyAddress'), disabled: isFee })),
          h('div', { class: 'field' }, h('label', {}, 'Basis of appointment'), basisChoice, errorFor(errors, 'basis')),
          needsOther ? field('otherAgent', 'Other agent', h('input', { id: 'otherAgent', type: 'text', value: state.otherAgent, oninput: bind(state, 'otherAgent') })) : null,
          h('div', { class: 'two' },
            field('feePercent', 'Fee', h('div', { class: 'affix post' }, h('input', { id: 'feePercent', type: 'number', inputmode: 'decimal', step: '0.01', min: '0.1', max: '10', value: state.feePercent, oninput: bind(state, 'feePercent') }), h('span', {}, '%')), 'Of the gross sale proceeds, excluding VAT.'),
            field('guidePrice', 'Guide price', priceInput())),
          isFee ? field('note', 'Note for the file (optional)', h('textarea', { id: 'note', rows: 2, maxlength: 500, oninput: bind(state, 'note') }, state.note)) : null)),
      signature ? null : h('div', { class: 'banner' }, 'Add your signature in ', h('a', { href: '/profile', 'data-link': true }, 'Profile'), ' before sending. It goes in the “For Berkeleys” box.'),
      h('p', { class: 'form-error', 'aria-live': 'polite' }, errors._form || ''),
      h('div', { class: 'sticky-actions actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => submit('save') }, 'Save draft'),
        h('button', { type: 'button', class: 'btn', onclick: () => submit('preview') }, 'Preview PDF'),
        h('span', { class: 'spacer' }),
        detail ? h('button', { type: 'button', class: 'btn danger', onclick: discard }, 'Discard draft') : null,
        h('button', { type: 'button', class: 'btn primary', disabled: !signature, onclick: () => submit('send') }, 'Send for signing')),
    ].filter(Boolean));
  }

  function payload() {
    if (isFee) return { feePercent: state.feePercent === '' ? '' : Number(state.feePercent), note: state.note };
    return {
      signers: state.signers.map(s => ({ name: s.name, email: s.email, mobile: s.mobile })),
      propertyAddress: state.propertyAddress, basis: state.basis, otherAgent: state.otherAgent,
      feePercent: state.feePercent === '' ? '' : Number(state.feePercent), guidePrice: state.guidePrice === '' ? '' : Number(state.guidePrice),
    };
  }

  let id = c?.id || null;
  let busy = false;
  async function save() {
    if (id) await api('PUT', `/api/contracts/${id}`, payload());
    else {
      id = (await api('POST', '/api/contracts', payload())).id;
      history.replaceState({}, '', `/contracts/${id}`);
    }
  }

  async function submit(kind) {
    if (busy) return;
    busy = true;
    // Open the preview tab now, while the click still counts, so browsers don't block it.
    const previewWin = kind === 'preview' ? window.open('', '_blank') : null;
    try {
      errors = {};
      await save();
      if (kind === 'save') { toast('Draft saved.'); draw(); }
      if (kind === 'preview') {
        if (previewWin) previewWin.location = `/api/contracts/${id}/document.pdf`;
        else window.open(`/api/contracts/${id}/document.pdf`, '_blank');
        draw();
      }
      if (kind === 'send') {
        const names = state.signers.map(s => s.name).join(', ');
        const ok = await ask({ title: 'Send for signing?', intro: `Each seller gets their own link by email: ${names}.`, submit: 'Send' });
        if (!ok) { draw(); return; }
        try { await api('POST', `/api/contracts/${id}/send`, {}); toast('Sent for signing.'); }
        catch (e) { toast(e.message, 'bad'); if (e.status !== 502) { draw(); return; } }
        go(`/contracts/${id}`);
      }
    } catch (e) {
      previewWin?.close();
      errors = { ...(e.errors || {}), _form: e.message };
      draw();
      formEl.querySelector('.has-error input')?.focus();
    } finally { busy = false; }
  }

  async function discard() {
    const v = await ask({ title: 'Discard this draft?', intro: 'It will be moved to Ended. Give a short reason for the record.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', value: 'Draft not needed', required: true }], submit: 'Discard', danger: true });
    if (!v) return;
    try { await api('POST', `/api/contracts/${id}/cancel`, { reason: v.reason }); toast('Draft discarded.'); go('/contracts?tab=drafts'); }
    catch (e) { toast(e.message, 'bad'); }
  }

  main.append(h('div', { class: 'page-head' }, h('div', {},
    h('div', { class: 'eyebrow' }, h('a', { href: '/contracts', 'data-link': true }, 'Contracts'), ' / ', detail ? 'Draft' : 'New'),
    h('h1', {}, isFee ? `Fee change for ${c.fields.propertyAddress}` : detail ? 'Edit draft' : 'New Terms of Sale'))), formEl);
  draw();
}

// ---------- Contract page ----------

const DESCRIBE = {
  created: e => e.data?.feeTo !== undefined ? `Fee change drafted: ${fmtFee(e.data.feeFrom)} → ${fmtFee(e.data.feeTo)}` : 'Draft created',
  sent: () => 'Sent for signing',
  opened: e => `${e.signerName} opened the link`,
  consented: e => `${e.signerName} agreed to sign electronically`,
  signed: e => `${e.signerName} signed${e.data?.startMarketingNow ? ' and asked for marketing to start now' : ''}`,
  reminded: e => `Automatic reminder to ${e.signerName} (day ${e.data?.day})`,
  chased: e => `Chased ${e.signerName}`,
  email_failed: e => e.data?.kind === 'signed_copy' ? `Signed copy email failed: ${e.data?.message || ''}` : `Email ${e.signerName ? `to ${e.signerName} ` : ''}failed: ${e.data?.message || ''}`,
  cancelled: e => `Cancelled: ${e.data?.reason || ''}`,
  expired: () => 'Expired after 30 days unsigned',
  completed: () => 'Signed by everyone.',
  copy_emailed: () => 'Signed copy emailed again',
  seller_cancelled: e => `Seller cancelled on ${fmtDate(e.data?.date)}${e.data?.note ? `: ${e.data.note}` : ''}`,
  replaced: e => `Replaced by fee change v${e.data?.byVersion}`,
  reinstated: e => `Back in force: fee change v${e.data?.byVersion} was cancelled by the seller`,
};

export async function renderContract(main, ctx, id) {
  const d = await api('GET', `/api/contracts/${id}`);
  if (d.state === 'draft') return renderDraftForm(main, ctx, d);
  const c = d.contract;
  const reload = () => { clear(main); return renderContract(main, ctx, id); };
  const act = async (fn, done) => { try { await fn(); toast(done); await reload(); } catch (e) { toast(e.message, 'bad'); } };

  const actions = h('div', { class: 'actions' },
    h('a', { class: 'btn', href: `/api/contracts/${id}/document.pdf`, target: '_blank', rel: 'noopener' }, c.finalPath ? 'Download signed PDF' : 'View PDF'),
    d.can.chase ? h('button', { class: 'btn', type: 'button', onclick: () => act(async () => { const r = await api('POST', `/api/contracts/${id}/chase`, {}); return r; }, 'Reminder sent.') }, 'Chase') : null,
    c.finalPath ? h('button', { class: 'btn', type: 'button', onclick: () => act(() => api('POST', `/api/contracts/${id}/resend-copy`, {}), 'Signed copy emailed.') }, 'Email signed copy again') : null,
    d.can.feeChange ? h('button', { class: 'btn', type: 'button', onclick: async () => {
      const v = await ask({ title: 'Change the fee', intro: 'The seller signs an updated Terms of Sale with the new fee. The current one stays in force until they do.',
        fields: [{ name: 'feePercent', label: 'New fee (%)', type: 'number', step: '0.01', min: '0.1', max: '10', value: c.fields.feePercent, required: true, inputmode: 'decimal' }, { name: 'note', label: 'Note for the file (optional)', type: 'textarea' }], submit: 'Create fee change' });
      if (!v) return;
      try { const r = await api('POST', `/api/contracts/${id}/fee-change`, { feePercent: Number(v.feePercent), note: v.note }); ctx.go(`/contracts/${r.id}`); }
      catch (e) { toast(e.errors?.feePercent || e.message, 'bad'); }
    } }, 'Change fee') : null,
    d.can.sellerCancel ? h('button', { class: 'btn', type: 'button', onclick: async () => {
      const v = await ask({ title: 'Record a seller cancellation', intro: 'Use this when the seller cancels within the 14-day period.', fields: [{ name: 'date', label: 'Date they cancelled', type: 'date', value: todayLondon(), required: true }, { name: 'note', label: 'Note (optional)', type: 'textarea' }], submit: 'Record cancellation', danger: true });
      if (v) act(() => api('POST', `/api/contracts/${id}/seller-cancelled`, v), 'Cancellation recorded.');
    } }, 'Record seller cancellation') : null,
    d.can.cancel ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      const v = await ask({ title: 'Cancel this contract?', intro: 'The signing links stop working and sellers who haven’t signed get an email.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], submit: 'Cancel contract', danger: true });
      if (v) act(() => api('POST', `/api/contracts/${id}/cancel`, { reason: v.reason }), 'Contract cancelled.');
    } }, 'Cancel') : null);

  const versions = d.family.length > 1 ? h('div', { class: 'versions' }, d.family.map(f => f.id === id
    ? h('span', { 'aria-current': 'page' }, `v${f.version}`)
    : h('a', { href: `/contracts/${f.id}`, 'data-link': true, title: f.label }, `v${f.version} · ${f.label}`))) : null;

  const problem = { signing: 'An email didn’t go out. Check the timeline below, then use Chase to send it again.', signed_copy: 'The signed copy didn’t go out by email. Use “Email signed copy again”.' }[d.emailProblem];
  main.append(...[
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, h('a', { href: '/contracts', 'data-link': true }, 'Contracts'), ` / ${c.id.slice(0, 8).toUpperCase()}`),
        h('h1', {}, c.fields.propertyAddress), h('span', { class: `pill ${pillClass(d.state)}` }, d.label), versions)),
    problem ? h('div', { class: 'banner bad' }, problem) : null,
    h('div', { class: 'detail-grid' },
      h('div', {},
        h('section', { class: 'card' }, h('h2', {}, 'Actions'), actions),
        h('section', { class: 'card' }, h('h2', {}, 'Sellers'),
          h('ul', { class: 'sellers' }, d.signers.map(s => h('li', {},
            h('div', {}, h('strong', {}, s.name), h('div', { class: 'small muted' }, s.email, s.sharedEmail ? ' (shared)' : '')),
            h('div', { class: 'small', style: 'text-align:right' }, s.status === 'signed' ? h('span', { class: 'pill signed' }, `Signed ${fmtDate(s.signedAt)}`) : h('span', { class: 'pill out' }, 'Waiting'),
              s.status === 'signed' ? h('div', { class: 'muted' }, s.startMarketingNow ? 'Marketing can start now' : 'Wait for the 14 days') : null))))),
        h('section', { class: 'card' }, h('h2', {}, 'Timeline'),
          h('ul', { class: 'timeline' }, [...d.events].reverse().map(e => h('li', { class: e.type === 'email_failed' || e.type === 'cancelled' ? 'warn' : '' },
            h('div', {}, (DESCRIBE[e.type] || (() => e.type))(e)),
            h('div', { class: 'when' }, fmtDateTime(e.at), e.actorEmail ? ` · ${e.actorEmail}` : '', e.ip ? ` · IP ${e.ip}` : '')))))),
      h('aside', {},
        h('section', { class: 'card' }, h('h2', {}, 'Details'),
          h('dl', { class: 'facts' },
            h('dt', {}, 'Fee'), h('dd', {}, fmtFee(c.fields.feePercent)),
            h('dt', {}, 'Guide price'), h('dd', {}, fmtPrice(c.fields.guidePrice)),
            h('dt', {}, 'Basis'), h('dd', {}, (ctx.hub.bases || []).find(b => b.key === c.fields.basis)?.label || c.fields.basis),
            h('dt', {}, 'Sent by'), h('dd', {}, c.sender?.name || ''),
            h('dt', {}, 'Sent'), h('dd', {}, fmtDateTime(c.sentAt)),
            c.completedAt ? [h('dt', {}, 'Signed'), h('dd', {}, fmtDateTime(c.completedAt))] : null,
            d.coolingOffUntil ? [h('dt', {}, 'Cooling off'), h('dd', {}, `until ${fmtDate(d.coolingOffUntil)}`)] : null,
            c.note ? [h('dt', {}, 'Note'), h('dd', {}, c.note)] : null)),
        c.finalSha256 ? h('section', { class: 'card small' }, h('h3', {}, 'Fingerprint'), h('p', { class: 'muted', style: 'overflow-wrap:anywhere' }, c.finalSha256)) : null)),
  ].filter(Boolean));
}
