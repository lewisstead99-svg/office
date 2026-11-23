import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function send(res, status, body, headers = {}) {
  const isRaw = typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array;
  const data = isRaw ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', c => {
      if (failed) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > limit) { failed = true; reject(new HttpError(413, 'Too large')); req.destroy?.(); return; }
      chunks.push(buf);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', e => { if (!failed) reject(e); });
  });
}

export async function readJson(req, limit = 5_000_000) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'Bad JSON'); }
}

export function clientMeta(req) {
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.socket?.remoteAddress || null;
  const ua = req.headers?.['user-agent'];
  return { ip, userAgent: ua ? String(ua).slice(0, 300) : null };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

// Serve a file from dir. Returns false when there is no such file (or the path tries to escape dir).
export function serveStatic(res, dir, pathname, headers = {}) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) return false;
  const root = path.resolve(dir);
  const file = path.resolve(root, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', ...headers });
  res.end(fs.readFileSync(file));
  return true;
}
