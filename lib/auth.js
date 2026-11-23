// Supabase sign-in, adapted from Key Tracker's lib/auth.js. Staff use the same email and password
// as Key Tracker. Accounts are created by Lewis in Supabase; there are no roles here.
import { HttpError } from './http.js';
import { originFrom } from './store-supabase.js';

const SESSION = 'bo_session';
const REFRESH = 'bo_refresh';
const enc = v => encodeURIComponent(v);
const dec = v => { try { return decodeURIComponent(v); } catch { return ''; } };

export function createAuth({ url, serviceKey, fetchImpl = globalThis.fetch, secure = process.env.NODE_ENV === 'production' }) {
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required for sign-in');
  const origin = originFrom(url);
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };

  async function call(path, init = {}, admin = false) {
    const r = await fetchImpl(origin + path, { ...init, headers: { ...(admin ? adminHeaders : { apikey: serviceKey, 'content-type': 'application/json' }), ...(init.headers || {}) } });
    const raw = await r.text();
    let data = null; try { data = raw ? JSON.parse(raw) : null; } catch {}
    if (!r.ok) {
      const e = new Error(data?.msg || data?.message || data?.error_description || data?.error || `Sign-in request failed (${r.status})`);
      e.status = r.status;
      throw e;
    }
    return data;
  }
  const rest = (path, init = {}) => call('/rest/v1' + path, init, true);

  const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean)
    .map(x => { const i = x.indexOf('='); return [x.slice(0, i), dec(x.slice(i + 1))]; }));
  const cookieHeaders = (access, refresh) => {
    const s = secure ? '; Secure' : '';
    return [
      `${SESSION}=${enc(access || '')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${access ? 3600 : 0}${s}`,
      `${REFRESH}=${enc(refresh || '')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${refresh ? 2592000 : 0}${s}`,
    ];
  };

  async function profile(user) {
    const rows = await rest(`/key_users?id=eq.${encodeURIComponent(user.id)}&select=id,email,full_name,active`);
    if (!rows?.length) throw new HttpError(403, 'Your account is not set up. Ask Lewis.');
    return rows[0];
  }

  async function recordSecurity(actorId, actorEmail, action, details) {
    try {
      await rest('/key_security_log', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ actor_id: actorId || null, actor_email: actorEmail || null, action, details }) });
    } catch (e) { console.error('Could not record sign-in event:', e.message); }
  }

  async function current(req, res) {
    const c = parseCookies(req);
    let token = c[SESSION];
    const refresh = async () => {
      if (!c[REFRESH]) return null;
      try {
        const renewed = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: c[REFRESH] }) });
        token = renewed.access_token;
        res.setHeader('set-cookie', cookieHeaders(token, renewed.refresh_token));
        return token;
      } catch {
        res.setHeader('set-cookie', cookieHeaders('', ''));
        return null;
      }
    };
    if (!token && !(await refresh())) return null;
    let user;
    try {
      user = await call('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (e.status !== 401 || !(await refresh())) return null;
      try { user = await call('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } }); }
      catch { res.setHeader('set-cookie', cookieHeaders('', '')); return null; }
    }
    try {
      const p = await profile(user);
      if (!p.active) { res.setHeader('set-cookie', cookieHeaders('', '')); return null; }
      return { id: user.id, email: user.email, fullName: p.full_name };
    } catch {
      res.setHeader('set-cookie', cookieHeaders('', ''));
      return null;
    }
  }

  async function login(email, password) {
    let data;
    try {
      data = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
    } catch {
      await recordSecurity(null, String(email || '').toLowerCase(), 'office.login.failed', 'Invalid credentials');
      throw new HttpError(401, 'Wrong email or password.');
    }
    const p = await profile(data.user);
    if (!p.active) {
      await recordSecurity(data.user.id, data.user.email, 'office.login.blocked', 'Account disabled');
      throw new HttpError(403, 'This account is disabled.');
    }
    await recordSecurity(data.user.id, data.user.email, 'office.login.success', 'Signed in to Berkeleys Office');
    return { user: { id: data.user.id, email: data.user.email, fullName: p.full_name }, cookies: cookieHeaders(data.access_token, data.refresh_token) };
  }

  return { login, current, cookieHeaders };
}
