import http from 'node:http';
import { createApp } from '../../lib/router.js';

// Start the app on a random port and return a small fetch wrapper.
export async function boot(deps) {
  const app = createApp(deps);
  const server = http.createServer(app.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const isBytes = body instanceof Uint8Array;
    const r = await fetch(base + p, {
      method,
      headers: { ...(body === undefined || body === null ? {} : { 'content-type': isBytes ? 'application/pdf' : 'application/json' }), ...headers },
      body: body === undefined || body === null ? undefined : isBytes ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, bytes: buf, headers: r.headers };
  };
  return { base, call, app, close: () => { app.close?.(); server.close(); } };
}
