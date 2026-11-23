// Small DOM helpers shared by the hub and the signing page. Text is always set with textContent.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = el => { el.replaceChildren(); return el; };

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtDate = iso => (iso ? dayFmt.format(new Date(iso)) : '');
export const fmtDateTime = iso => (iso ? `${dayFmt.format(new Date(iso))}, ${timeFmt.format(new Date(iso))}` : '');
export const fmtPrice = n => '£' + Number(n || 0).toLocaleString('en-GB');
export const fmtFee = n => `${Number(Number(n).toFixed(2))}%`;
export const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let toastTimer;
export function toast(message, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

// A small modal form. fields: [{ name, label, type, value, required, hint, min, max, step, rows }]
// Resolves with { name: value } or null if closed.
export function ask({ title, intro, fields = [], submit = 'Save', danger = false }) {
  return new Promise(resolve => {
    const inputs = {};
    const form = h('form', { class: 'dialog-form', method: 'dialog' },
      h('h2', {}, title),
      intro ? h('p', { class: 'muted' }, intro) : null,
      fields.map(f => {
        const id = `ask-${f.name}`;
        const input = f.type === 'textarea'
          ? h('textarea', { id, name: f.name, rows: f.rows || 3, required: f.required, maxlength: f.maxlength || 500 }, f.value || '')
          : h('input', { id, name: f.name, type: f.type || 'text', value: f.value ?? '', required: f.required, min: f.min, max: f.max, step: f.step, inputmode: f.inputmode });
        inputs[f.name] = input;
        return h('div', { class: 'field' }, h('label', { for: id }, f.label), input, f.hint ? h('p', { class: 'hint' }, f.hint) : null);
      }),
      h('p', { class: 'form-error', 'aria-live': 'polite' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Close'),
        h('button', { type: 'submit', class: danger ? 'btn danger' : 'btn primary' }, submit)));
    const dlg = h('dialog', { class: 'dialog' }, form);
    function done(v) { dlg.close(); dlg.remove(); resolve(v); }
    form.addEventListener('submit', e => {
      e.preventDefault();
      done(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
    Object.values(inputs)[0]?.focus();
  });
}
