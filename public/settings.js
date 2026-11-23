import { api } from './api.js';
import { h, clear, toast, fmtDateTime } from './ui.js';

export async function renderSettings(main) {
  const [versions, settings] = await Promise.all([api('GET', '/api/templates'), api('GET', '/api/settings')]);
  const current = versions.find(v => v.current);

  // --- master copy ---
  const result = h('div', { 'aria-live': 'polite' });
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf', id: 'master' });
  const upload = h('button', { type: 'button', class: 'btn' }, 'Upload new master');
  upload.onclick = async () => {
    const f = file.files?.[0];
    if (!f) return toast('Choose the PDF first.', 'bad');
    upload.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, 'Checking the PDF…'));
    try {
      const r = await api('POST', '/api/templates/terms-of-sale', new Uint8Array(await f.arrayBuffer()));
      const live = h('button', { type: 'button', class: 'btn primary' }, 'Make this the live version');
      live.onclick = async () => {
        try { await api('POST', `/api/templates/versions/${r.versionId}/activate`, {}); toast(`Version ${r.version} is now live.`); clear(main); renderSettings(main); }
        catch (e) { toast(e.message, 'bad'); }
      };
      result.replaceChildren(h('div', { class: 'banner ok' }, `Version ${r.version} uploaded. All ${r.fieldNames.length} boxes were found.`),
        h('p', { class: 'muted small' }, r.fieldNames.join(' · ')),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: `/api/templates/versions/${r.versionId}/sample.pdf`, target: '_blank', rel: 'noopener' }, 'View sample'), live));
    } catch (e) {
      result.replaceChildren(h('div', { class: 'banner bad' }, e.message));
    } finally { upload.disabled = false; }
  };

  // --- office copy ---
  const office = h('input', { type: 'email', id: 'office', value: settings.officeCopyEmail || '', placeholder: 'e.g. sales@berkeleysdrummond.com' });
  const saveOffice = h('button', { type: 'button', class: 'btn primary' }, 'Save');
  saveOffice.onclick = async () => {
    try { await api('PUT', '/api/settings', { officeCopyEmail: office.value }); toast('Saved.'); }
    catch (e) { toast(e.message, 'bad'); }
  };

  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Settings'), h('h1', {}, 'Settings'))),
    h('section', { class: 'card' },
      h('h2', {}, 'Terms of Sale master'),
      current
        ? h('p', {}, `Live: version ${current.version}, uploaded by ${current.uploadedBy?.name || 'unknown'} on ${fmtDateTime(current.uploadedAt)}. `,
          h('a', { href: `/api/templates/versions/${current.id}/sample.pdf`, target: '_blank', rel: 'noopener' }, 'View sample'))
        : h('div', { class: 'banner' }, 'No master copy yet. Upload the Terms of Sale PDF before anyone can send contracts.'),
      h('p', { class: 'muted small' }, 'When the solicitor updates the wording, upload the new PDF here. Contracts already sent keep the version they were sent with.'),
      h('div', { class: 'field' }, h('label', { for: 'master' }, 'New master PDF'), file),
      h('div', { class: 'actions', style: 'margin-top:10px' }, upload),
      result,
      versions.length ? h('details', { style: 'margin-top:14px' }, h('summary', {}, 'Version history'),
        h('ul', {}, versions.map(v => h('li', {}, `v${v.version} · uploaded ${fmtDateTime(v.uploadedAt)} by ${v.uploadedBy?.name || 'unknown'}`,
          v.current ? ' · live' : v.activatedAt ? ` · was live from ${fmtDateTime(v.activatedAt)}` : ' · never made live')))) : null),
    h('section', { class: 'card' },
      h('h2', {}, 'Office copy'),
      h('p', { class: 'muted' }, 'Every signed contract is emailed here as well as to the sellers and the sender. This inbox is also your off-site copy.'),
      h('div', { class: 'field' }, h('label', { for: 'office' }, 'Office copy email'), office),
      h('div', { class: 'actions', style: 'margin-top:10px' }, saveOffice)));
}
