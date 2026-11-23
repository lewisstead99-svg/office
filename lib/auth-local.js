import crypto from 'node:crypto';
import { HttpError } from './http.js';

// Sign-in for local runs and tests: a fixed list of users, sessions kept in memory.
export function createLocalAuth(users) {
  const sessions = new Map();
  const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value || '')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? maxAge : 0}`;
  const cookieHeaders = (access, refresh) => [cookie('bo_session', access, 3600 * 12), cookie('bo_refresh', refresh, 0)];
  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const publicUser = u => ({ id: u.id, email: u.email, fullName: u.fullName });

  return {
    cookieHeaders,
    async login(email, password) {
      const u = users.find(x => x.email.toLowerCase() === String(email || '').trim().toLowerCase());
      if (!u || !same(u.password, password)) throw new HttpError(401, 'Wrong email or password.');
      const sid = crypto.randomBytes(24).toString('base64url');
      sessions.set(sid, publicUser(u));
      return { user: publicUser(u), cookies: cookieHeaders(sid, '') };
    },
    async current(req) {
      const c = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('bo_session='));
      return c ? sessions.get(decodeURIComponent(c.slice('bo_session='.length))) ?? null : null;
    },
  };
}
