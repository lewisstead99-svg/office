import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { boot } from './helpers/boot.js';

test('hub and signing pages and their assets are served with the right types', async () => {
  const t = await boot({ publicDir: path.resolve('public') });
  try {
    const expect = {
      '/': 'text/html', '/contracts': 'text/html', '/contracts/new': 'text/html', '/s/abc': 'text/html',
      '/app.js': 'text/javascript', '/contracts.js': 'text/javascript', '/settings.js': 'text/javascript', '/api.js': 'text/javascript',
      '/sign.js': 'text/javascript', '/signature-pad.js': 'text/javascript', '/styles.css': 'text/css',
      '/fonts/Caveat-Medium.woff2': 'font/woff2', '/bd-logo.png': 'image/png', '/manifest.webmanifest': 'application/manifest+json',
    };
    for (const [p, type] of Object.entries(expect)) {
      const r = await t.call('GET', p);
      assert.equal(r.status, 200, p);
      assert.ok(r.headers.get('content-type').startsWith(type), `${p}: ${r.headers.get('content-type')}`);
    }
    assert.match((await t.call('GET', '/s/abc')).text, /sign\.js/);
    assert.match((await t.call('GET', '/')).text, /app\.js/);
  } finally { t.close(); }
});
