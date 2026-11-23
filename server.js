// Local run for trying things out: data is kept in memory (gone when you stop it),
// emails are printed here instead of sent. The live version runs on Vercel (api/index.js).
//   DEV_EMAIL=you@example.com DEV_PASSWORD=a-long-password npm start
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/router.js';
import { createMemoryStore } from './lib/store-memory.js';
import { createMemoryBlobs } from './lib/blobs.js';
import { createConsoleMailer } from './lib/mailer.js';
import { createLocalAuth } from './lib/auth-local.js';
import { createContracts } from './lib/contracts.js';
import { createTemplateAdmin } from './lib/template-admin.js';
import { TERMS_OF_SALE } from './lib/templates.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8479;
const email = (process.env.DEV_EMAIL || '').trim();
const password = process.env.DEV_PASSWORD || '';
if (!email || password.length < 8) {
  console.error('Set DEV_EMAIL and DEV_PASSWORD (8+ characters) to choose the local sign-in, e.g.\n  DEV_EMAIL=you@example.com DEV_PASSWORD=a-long-password npm start');
  process.exit(1);
}

const user = { id: '00000000-0000-4000-8000-000000000001', email, fullName: process.env.DEV_NAME || 'Local User', password };
const store = createMemoryStore();
const blobs = createMemoryBlobs();
const mailer = createConsoleMailer();
const baseUrl = `http://localhost:${port}`;
const contracts = createContracts({ store, blobs, mailer, baseUrl, template: TERMS_OF_SALE });
const templateAdmin = createTemplateAdmin({ store, blobs, template: TERMS_OF_SALE });

// If the real master is in seed/ (never committed), load it so you can send straight away.
const seed = path.join(root, 'seed', 'terms-of-sale-master.pdf');
if (fs.existsSync(seed)) {
  const { versionId } = await templateAdmin.upload(user, new Uint8Array(fs.readFileSync(seed)));
  await templateAdmin.activate(user, versionId);
  console.log('Loaded the Terms of Sale master from seed/.');
}

const app = createApp({
  contracts, templateAdmin, store,
  auth: createLocalAuth([user]),
  publicDir: path.join(root, 'public'),
  cronSecret: process.env.CRON_SECRET || 'dev',
  links: { keys: process.env.KEYS_URL || 'https://keys-xi-five.vercel.app', windowCards: process.env.WINDOW_CARDS_URL || 'https://window-cards.vercel.app' },
});

http.createServer(app.handle).listen(port, () => {
  console.log(`\nBerkeleys Office is running at ${baseUrl}\nSign in as ${email}. Data is kept in memory until you stop this window.\n`);
});
