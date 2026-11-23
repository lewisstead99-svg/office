// Run before the first deploy, against Key Tracker's Supabase project:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=... node scripts/check-supabase.mjs
// Stops (exit 1) if Key Tracker's staff list is missing or empty. Reports any missing Berkeleys Office parts.
import { originFrom } from '../lib/store-supabase.js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.'); process.exit(1); }
const origin = originFrom(url);
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function get(path) {
  const r = await fetch(origin + path, { headers });
  const text = await r.text();
  return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : null };
}

const users = await get('/rest/v1/key_users?select=id,active&limit=1000');
if (!users.ok) {
  console.error(`STOP: Key Tracker's staff table (key_users) could not be read (${users.status}). Is this Key Tracker's project, with the account upgrade applied?`);
  process.exit(1);
}
const active = users.data.filter(u => u.active).length;
if (!users.data.length) { console.error('STOP: key_users is empty. Create the staff accounts in Key Tracker first.'); process.exit(1); }
console.log(`OK: ${active} active staff account(s) in key_users (${users.data.length} in total).`);

const missing = [];
for (const t of ['bo_contracts', 'bo_signers', 'bo_signer_tokens', 'bo_events', 'bo_template_versions', 'bo_settings', 'bo_user_signatures']) {
  if (!(await get(`/rest/v1/${t}?select=*&limit=1`)).ok) missing.push(`table ${t}`);
}
const bucket = await fetch(`${origin}/storage/v1/bucket/contracts`, { headers });
if (!bucket.ok) missing.push('storage bucket "contracts"');
if (missing.length) console.log(`Not set up yet: ${missing.join(', ')}. Run SETUP-SUPABASE.sql in the SQL editor.`);
else console.log('OK: all Berkeleys Office tables and the contracts bucket exist.');
