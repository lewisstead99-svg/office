import { api } from './api.js';
import { h, clear, toast } from './ui.js';
import { renderTracker, renderNewContract, renderContract } from './contracts.js';
import { renderSettings } from './settings.js';
import { createSignaturePad, typedSignaturePng } from './signature-pad.js';

const root = document.getElementById('app');
let leaving = [];

export function go(path) {
  history.pushState({}, '', path);
  route();
}

window.addEventListener('popstate', route);
window.addEventListener('bo:signed-out', () => renderSignIn());
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});

function shell(hub) {
  const p = location.pathname;
  const link = (href, label, match) => h('a', { href, 'data-link': true, 'aria-current': match ? 'page' : null }, label);
  const signOut = async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); renderSignIn(); };
  const main = h('main', { class: 'page', id: 'main' });
  clear(root).append(
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-in' },
        h('a', { href: '/', 'data-link': true, class: 'wordmark', 'aria-label': 'Berkeleys Office home' }, h('span', {}, 'Berkeleys'), h('span', {}, 'Drummond')),
        h('span', { class: 'appname' }, 'Office'),
        h('span', { class: 'spacer' }),
        h('nav', { class: 'nav', 'aria-label': 'Main' },
          link('/contracts', 'Contracts', p.startsWith('/contracts')),
          link('/settings', 'Settings', p === '/settings'),
          link('/profile', 'Profile', p === '/profile'),
          h('span', { class: 'who' }, hub.user.fullName),
          h('button', { type: 'button', onclick: signOut }, 'Sign out')))),
    main);
  return main;
}

async function route() {
  for (const fn of leaving) fn();
  leaving = [];
  let hub;
  try { hub = await api('GET', '/api/hub'); }
  catch (e) { if (e.status === 401) return renderSignIn(); return renderProblem(e); }
  const main = shell(hub);
  const ctx = { hub, go, onLeave: fn => leaving.push(fn) };
  const p = location.pathname.replace(/\/$/, '') || '/';
  const m = p.match(/^\/contracts\/([0-9a-f-]{36})$/);
  try {
    if (p === '/') await renderHome(main, ctx);
    else if (p === '/contracts') await renderTracker(main, ctx);
    else if (p === '/contracts/new') await renderNewContract(main, ctx);
    else if (m) await renderContract(main, ctx, m[1]);
    else if (p === '/settings') await renderSettings(main, ctx);
    else if (p === '/profile') await renderProfile(main, ctx);
    else main.append(h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '/', 'data-link': true }, 'Back to the start')));
  } catch (e) {
    if (e.status !== 401) main.replaceChildren(h('div', { class: 'banner bad' }, e.message));
  }
  document.title = (document.querySelector('main h1')?.textContent || 'Home') + ' · Berkeleys Office';
}

function renderProblem(e) {
  clear(root).append(h('main', { class: 'signin' }, h('div', { class: 'card' }, h('h1', {}, 'Something went wrong'), h('p', {}, e.message), h('button', { class: 'btn', onclick: route }, 'Try again'))));
}

function renderSignIn() {
  const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'form-error', 'aria-live': 'polite' });
  const button = h('button', { type: 'submit', class: 'btn primary big' }, 'Sign in');
  const form = h('form', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Work email'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), password),
    error, button);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    button.disabled = true; error.textContent = '';
    try { await api('POST', '/api/auth/login', { email: email.value, password: password.value }); route(); }
    catch (err) { error.textContent = err.message; button.disabled = false; }
  });
  clear(root).append(h('main', { class: 'signin' },
    h('div', { class: 'card' },
      h('div', { class: 'wordmark' }, h('span', {}, 'Berkeleys'), h('span', {}, 'Drummond')),
      h('p', { class: 'muted' }, 'Office. Sign in with your Key Tracker email and password.'),
      form)));
  document.title = 'Sign in · Berkeleys Office';
  email.focus();
}

async function renderHome(main, { hub }) {
  let out = null;
  try { out = (await api('GET', '/api/contracts?tab=out')).counts.out; } catch {}
  const tile = (href, title, text, extra = {}) => h('a', { class: 'tile', href, ...extra }, h('h2', {}, title), h('p', { class: 'muted' }, text), h('span', { class: 'go' }, extra.target ? 'Open in a new tab ↗' : 'Open →'));
  const contracts = tile('/contracts', 'Contracts', 'Terms of Sale: send for signing, see what’s unsigned, change fees.', { 'data-link': true });
  if (out) contracts.append(h('span', { class: 'count', title: 'Out for signing' }, `${out} out`));
  main.append(
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Berkeleys Office'), h('h1', {}, `Hello, ${hub.user.fullName.split(' ')[0]}`))),
    h('div', { class: 'tiles' },
      contracts,
      tile(hub.links.keys, 'Keys', 'Sign keys in and out for Sales and Lettings.', { target: '_blank', rel: 'noopener' }),
      tile(hub.links.windowCards, 'Window Cards', 'What’s in each pocket of the office window.', { target: '_blank', rel: 'noopener' })));
}

async function renderProfile(main) {
  const { png } = await api('GET', '/api/me/signature');
  const current = h('div', {}, png ? h('img', { class: 'sig-preview', src: png, alt: 'Your saved signature' }) : h('p', { class: 'muted' }, 'You haven’t saved a signature yet. You need one before you can send contracts.'));
  const canvas = h('canvas', { 'aria-label': 'Draw your signature' });
  const padBox = h('div', { class: 'sigpad' }, canvas, h('div', { class: 'base' }), h('span', { class: 'hint-on' }, 'Sign above the line'));
  const typedName = h('input', { type: 'text', id: 'typed', value: '' });
  const typedPreview = h('div', { class: 'typed', 'aria-hidden': 'true' });
  const typedBox = h('div', { hidden: true }, h('div', { class: 'field' }, h('label', { for: 'typed' }, 'Type your name'), typedName), typedPreview);
  typedName.addEventListener('input', () => { typedPreview.textContent = typedName.value; });
  let mode = 'draw';
  const drawBtn = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Draw');
  const typeBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Type');
  const setMode = m => { mode = m; drawBtn.setAttribute('aria-pressed', m === 'draw'); typeBtn.setAttribute('aria-pressed', m === 'type'); padBox.hidden = m !== 'draw'; typedBox.hidden = m !== 'type'; };
  drawBtn.onclick = () => setMode('draw');
  typeBtn.onclick = () => setMode('type');
  main.append(h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Profile'), h('h1', {}, 'Your signature'))),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'This goes in the “For Berkeleys” box on every contract you send.'),
      h('h3', {}, 'Saved signature'), current));
  const pad = createSignaturePad(canvas);
  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save signature');
  save.onclick = async () => {
    const data = mode === 'draw' ? (pad.isEmpty() ? null : pad.toPng()) : (typedName.value.trim() ? await typedSignaturePng(typedName.value.trim()) : null);
    if (!data) return toast('Draw or type your signature first.', 'bad');
    try {
      await api('PUT', '/api/me/signature', { png: data });
      current.replaceChildren(h('img', { class: 'sig-preview', src: data, alt: 'Your saved signature' }));
      pad.clear();
      toast('Signature saved.');
    } catch (e) { toast(e.message, 'bad'); }
  };
  main.append(h('div', { class: 'card' },
    h('h3', {}, 'New signature'),
    h('div', { class: 'tabsmall' }, drawBtn, typeBtn),
    padBox, typedBox,
    h('div', { class: 'actions', style: 'margin-top:12px' }, h('button', { class: 'btn', type: 'button', onclick: () => pad.clear() }, 'Clear'), save)));
}

route();
