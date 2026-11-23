// File storage for master copies and contract PDFs.
import { originFrom } from './store-supabase.js';

export function createMemoryBlobs() {
  const files = new Map();
  return {
    async put(path, bytes) { files.set(path, new Uint8Array(bytes)); },
    async get(path) { return files.has(path) ? new Uint8Array(files.get(path)) : null; },
    async del(path) { files.delete(path); },
  };
}

export function createSupabaseBlobs({ url, key, bucket = 'contracts', fetchImpl = globalThis.fetch }) {
  const base = originFrom(url) + '/storage/v1';
  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  const objectUrl = path => `${base}/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;

  return {
    async put(path, bytes, contentType = 'application/pdf') {
      const r = await fetchImpl(objectUrl(path), { method: 'POST', headers: { ...auth, 'content-type': contentType, 'x-upsert': 'true' }, body: bytes });
      if (!r.ok) throw new Error(`Storage upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    },
    async get(path) {
      const r = await fetchImpl(objectUrl(path), { method: 'GET', headers: auth });
      if (r.status === 404 || r.status === 400) return null;      // Supabase answers 400 "not_found" for missing objects
      if (!r.ok) throw new Error(`Storage download failed (${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async del(path) {
      const r = await fetchImpl(`${base}/object/${bucket}`, { method: 'DELETE', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [path] }) });
      if (!r.ok) throw new Error(`Storage delete failed (${r.status})`);
    },
  };
}
