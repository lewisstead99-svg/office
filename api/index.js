// Vercel entry: every /api/* request lands here (see vercel.json).
import { createApp } from '../lib/router.js';
import { createSupabaseStore } from '../lib/store-supabase.js';
import { createSupabaseBlobs } from '../lib/blobs.js';
import { createResendMailer } from '../lib/mailer.js';
import { createAuth } from '../lib/auth.js';
import { createContracts } from '../lib/contracts.js';
import { createTemplateAdmin } from '../lib/template-admin.js';
import { TERMS_OF_SALE } from '../lib/templates.js';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'RESEND_API_KEY', 'MAIL_FROM', 'PUBLIC_URL', 'CRON_SECRET'];

let app = null;
let setupError = null;
try {
  const env = process.env;
  const missing = REQUIRED.filter(k => !String(env[k] || '').trim());
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_KEY;
  const store = createSupabaseStore({ url, key });
  const blobs = createSupabaseBlobs({ url, key });
  const mailer = createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
  const baseUrl = env.PUBLIC_URL.trim().replace(/\/$/, '');
  app = createApp({
    store,
    auth: createAuth({ url, serviceKey: key }),
    contracts: createContracts({ store, blobs, mailer, baseUrl, template: TERMS_OF_SALE }),
    templateAdmin: createTemplateAdmin({ store, blobs, template: TERMS_OF_SALE }),
    cronSecret: env.CRON_SECRET,
    links: { keys: env.KEYS_URL || 'https://keys-xi-five.vercel.app', windowCards: env.WINDOW_CARDS_URL || 'https://window-cards.vercel.app' },
  });
} catch (e) {
  setupError = e;
}

export default function handler(req, res) {
  if (setupError) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: `Berkeleys Office is not set up yet: ${setupError.message}` }));
  }
  return app.handle(req, res);
}
