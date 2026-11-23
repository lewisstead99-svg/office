import crypto from 'node:crypto';

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest('hex');
}

// A signing link token. Only its hash is ever stored.
export function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export function hashToken(token) {
  return sha256Hex(String(token));
}
