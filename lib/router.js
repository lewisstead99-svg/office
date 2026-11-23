import { send, serveStatic, readJson, readBody, clientMeta, HttpError } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import { parsePngDataUrl } from './validate.js';
import { pdfFileName } from './contracts.js';
import { TERMS_OF_SALE, enabledBases } from './templates.js';

const SPA = /^\/(contracts(\/.*)?|settings|profile)?\/?$/;
const SIGN_PAGE = /^\/s\/[A-Za-z0-9_-]+\/?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_HEADERS = { 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' };

function pdfHeaders(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '').replace(/["\\\r\n]/g, '');
  return { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}` };
}

export function createApp({ contracts, templateAdmin, store, auth, publicDir, cronSecret, links = {} } = {}) {
  const loginLimit = createRateLimiter({ limit: 10, windowMs: 60000 });
  const publicLimit = createRateLimiter({ limit: 30, windowMs: 60000 });

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const seg = p.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
    const meta = clientMeta(req);

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) && req.headers.origin) {
      let host;
      try { host = new URL(req.headers.origin).host; } catch { return send(res, 403, { error: 'Invalid request origin' }); }
      if (host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request blocked' });
    }

    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true });

    // --- the seller's signing link (no sign-in) ---
    if (seg[1] === 'sign' && seg[2]) {
      if (!publicLimit(meta.ip || 'unknown')) return send(res, 429, { error: 'Too many requests. Please wait a minute.' }, PUBLIC_HEADERS);
      const token = seg[2];
      if (m === 'GET' && seg.length === 3) return send(res, 200, await contracts.openLink(token, meta), PUBLIC_HEADERS);
      if (m === 'GET' && seg[3] === 'document.pdf') {
        const { bytes, fileName } = await contracts.documentForLink(token);
        return send(res, 200, Buffer.from(bytes), { ...PUBLIC_HEADERS, ...pdfHeaders(fileName) });
      }
      if (m === 'POST' && seg.length === 3) return send(res, 200, await contracts.sign(token, await readJson(req, 600_000), meta), PUBLIC_HEADERS);
      return send(res, 404, { error: 'Not found' }, PUBLIC_HEADERS);
    }

    // --- the daily job, called by Vercel Cron ---
    if (m === 'GET' && p === '/api/cron/daily') {
      if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) return send(res, 401, { error: 'Not allowed' });
      return send(res, 200, await contracts.runDaily());
    }

    // --- sign-in ---
    if (m === 'POST' && p === '/api/auth/login') {
      if (!loginLimit(meta.ip || 'unknown')) return send(res, 429, { error: 'Too many sign-in attempts. Please wait a minute.' });
      const body = await readJson(req);
      const result = await auth.login(String(body.email || '').trim(), String(body.password || ''));
      res.setHeader('set-cookie', result.cookies);
      return send(res, 200, { ok: true, user: result.user });
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      res.setHeader('set-cookie', auth.cookieHeaders('', ''));
      return send(res, 200, { ok: true });
    }

    const user = await auth.current(req, res);
    if (!user) return send(res, 401, { error: 'Sign in required' });

    if (m === 'GET' && p === '/api/auth/me') return send(res, 200, { user });
    if (m === 'GET' && p === '/api/hub') return send(res, 200, { user, links, bases: enabledBases(TERMS_OF_SALE) });

    // --- contracts ---
    if (seg[1] === 'contracts') {
      const id = seg[2];
      if (!id) {
        if (m === 'GET') {
          const q = url.searchParams;
          return send(res, 200, await contracts.list({ tab: q.get('tab') || 'out', mine: q.get('mine') === '1', q: q.get('q') || '', limit: q.get('limit') || 200, user }));
        }
        if (m === 'POST') return send(res, 201, await contracts.createDraft(user, await readJson(req)));
      }
      if (id && seg.length === 3) {
        if (m === 'GET') return send(res, 200, await contracts.detail(id));
        if (m === 'PUT') { await contracts.updateDraft(user, id, await readJson(req)); return send(res, 200, { ok: true }); }
      }
      if (id && seg.length === 4) {
        const action = seg[3];
        if (m === 'GET' && action === 'document.pdf') {
          const bytes = await contracts.previewPdf(id);
          const got = await store.getContract(id);
          return send(res, 200, Buffer.from(bytes), pdfHeaders(pdfFileName(got?.contract.fields.propertyAddress ?? '')));
        }
        if (m === 'POST') {
          const body = await readJson(req);
          if (action === 'send') { await contracts.send(user, id); return send(res, 200, { ok: true }); }
          if (action === 'chase') return send(res, 200, await contracts.chase(user, id));
          if (action === 'resend-copy') { await contracts.resendSignedCopy(user, id); return send(res, 200, { ok: true }); }
          if (action === 'cancel') { await contracts.cancel(user, id, body.reason); return send(res, 200, { ok: true }); }
          if (action === 'fee-change') return send(res, 201, await contracts.startFeeChange(user, id, { feePercent: body.feePercent, note: body.note }));
          if (action === 'seller-cancelled') { await contracts.recordSellerCancel(user, id, { date: body.date, note: body.note }); return send(res, 200, { ok: true }); }
        }
      }
      return send(res, 404, { error: 'Not found' });
    }

    // --- my signature ---
    if (p === '/api/me/signature') {
      if (m === 'GET') return send(res, 200, { png: await store.getSignature(user.id) });
      if (m === 'PUT') {
        const { png } = await readJson(req, 600_000);
        parsePngDataUrl(png);
        await store.saveSignature(user.id, png);
        return send(res, 200, { ok: true });
      }
    }

    // --- settings ---
    if (p === '/api/settings') {
      if (m === 'GET') return send(res, 200, await store.getSettings());
      if (m === 'PUT') {
        const body = await readJson(req);
        const email = String(body.officeCopyEmail ?? '').trim().toLowerCase();
        if (email && !EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address, or leave it blank.');
        await store.saveSettings({ officeCopyEmail: email || null });
        return send(res, 200, await store.getSettings());
      }
    }

    // --- master copies ---
    if (seg[1] === 'templates') {
      if (m === 'GET' && seg.length === 2) return send(res, 200, await templateAdmin.list());
      if (m === 'POST' && seg[2] === 'terms-of-sale' && seg.length === 3) {
        const bytes = await readBody(req, 4_000_000);
        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'Please upload a PDF file.');
        return send(res, 201, await templateAdmin.upload(user, new Uint8Array(bytes)));
      }
      if (seg[2] === 'versions' && seg[3]) {
        if (m === 'GET' && seg[4] === 'sample.pdf') return send(res, 200, Buffer.from(await templateAdmin.samplePdf(seg[3])), pdfHeaders('Terms of Sale - sample.pdf'));
        if (m === 'POST' && seg[4] === 'activate') { await templateAdmin.activate(user, seg[3]); return send(res, 200, { ok: true }); }
      }
    }

    return send(res, 404, { error: 'Not found' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      if (SIGN_PAGE.test(p)) {
        if (serveStatic(res, publicDir, '/sign.html', PUBLIC_HEADERS)) return;
        return send(res, 404, { error: 'Not found' }, PUBLIC_HEADERS);
      }
      if (SPA.test(p) && serveStatic(res, publicDir, '/index.html')) return;
      if (serveStatic(res, publicDir, p)) return;
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = Number(e?.status);
      const headers = p.startsWith('/api/sign/') ? PUBLIC_HEADERS : {};
      if (res.headersSent) return;
      if (e instanceof HttpError || (status >= 400 && status < 500)) return send(res, status, { error: e.message, ...(e.extra || {}) }, headers);
      if (status === 502 || status === 503) return send(res, status, { error: e.message }, headers);
      console.error(e);
      send(res, 500, { error: 'Something went wrong.' }, headers);
    }
  }

  return { handle, close() {} };
}
