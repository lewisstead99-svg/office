// Talking to the server. Errors carry .status and .errors (field messages from the form checks).
export async function api(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin', cache: 'no-store' };
  if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
    init.body = body;
    init.headers['content-type'] = 'application/pdf';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  let r;
  try { r = await fetch(path, init); }
  catch { const e = new Error('Could not reach the server. Check your connection and try again.'); e.status = 0; throw e; }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const e = new Error(data.error || `Something went wrong (${r.status}).`);
    e.status = r.status;
    e.errors = data.errors || {};
    e.retry = !!data.retry;
    if (r.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/sign/')) window.dispatchEvent(new Event('bo:signed-out'));
    throw e;
  }
  return data;
}
