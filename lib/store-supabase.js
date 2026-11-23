// Supabase-backed store (Postgres via the REST API). Same interface as the memory store.
// Tables and the bo_commit function come from SETUP-SUPABASE.sql.
import { ConflictError } from './store-errors.js';

const snake = k => k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
// Only top-level keys change case; jsonb values (fields, sender, data…) are stored as they are.
const toRow = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));
const fromRow = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));

export function originFrom(url) {
  let origin = String(url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(origin)) origin = `https://${origin.replace(/\.supabase\.co$/, '')}.supabase.co`;
  return origin;
}

export function createSupabaseStore({ url, key, fetchImpl = globalThis.fetch }) {
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  const base = originFrom(url) + '/rest/v1';
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  async function rest(method, path, body, extra = {}) {
    const r = await fetchImpl(base + path, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) {
      if (text.includes('bo_conflict') || text.includes('23505')) throw new ConflictError();   // 23505: duplicate (e.g. a second v2)
      throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${r.status}): ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  const FULL = 'select=*,signers:bo_signers(*),events:bo_events(*)';
  // Lists and the daily job never need the signature images, so they are not fetched.
  const LIST_SIGNERS = 'signers:bo_signers(id,contract_id,position,name,email,mobile,shared_email,status,signed_at,initials,start_marketing_now)';
  function unpack(row) {
    const { signers = [], events = [], ...c } = row;
    return {
      contract: fromRow(c),
      signers: signers.map(fromRow).sort((a, b) => a.position - b.position),
      events: events.map(fromRow).sort((a, b) => a.id - b.id),
    };
  }
  const inList = xs => `(${xs.map(x => encodeURIComponent(x)).join(',')})`;

  return {
    kind: 'supabase',

    async commit({ contracts = [], signers = [], events = [], tokens = [], removeSignerIds = [] } = {}) {
      await rest('POST', '/rpc/bo_commit', {
        p_contracts: contracts.map(toRow), p_signers: signers.map(toRow),
        p_events: events.map(({ id, ...e }) => toRow(e)), p_tokens: tokens.map(toRow),
        p_remove_signers: removeSignerIds,
      });
    },

    async getContract(id) {
      const rows = await rest('GET', `/bo_contracts?id=eq.${encodeURIComponent(id)}&${FULL}`);
      return rows?.length ? unpack(rows[0]) : null;
    },

    async getFamily(familyId) {
      const rows = await rest('GET', `/bo_contracts?family_id=eq.${encodeURIComponent(familyId)}&order=version.asc`);
      return rows.map(fromRow);
    },

    async findByTokenHash(hash) {
      const rows = await rest('GET', `/bo_signer_tokens?hash=eq.${encodeURIComponent(hash)}&select=signer_id,signer:bo_signers(contract_id)`);
      if (!rows?.length || !rows[0].signer) return null;
      const got = await this.getContract(rows[0].signer.contract_id);
      if (!got) return null;
      return { ...got, signer: got.signers.find(s => s.id === rows[0].signer_id) };
    },

    async listContracts({ states, limit = 500 } = {}) {
      const filter = states ? `state=in.${inList(states)}&` : '';
      const rows = await rest('GET', `/bo_contracts?${filter}select=*,${LIST_SIGNERS}&order=created_at.desc&limit=${limit}`);
      return rows.map(r => { const { contract, signers } = unpack(r); return { contract, signers }; });
    },

    async countByState() {
      const rows = await rest('POST', '/rpc/bo_state_counts', {});
      return Object.fromEntries(rows.map(r => [r.state, Number(r.n)]));
    },

    async listWithEvents(states) {
      const rows = await rest('GET', `/bo_contracts?state=in.${inList(states)}&select=*,${LIST_SIGNERS},events:bo_events(*)&order=created_at.desc`);
      return rows.map(unpack);
    },

    async addTemplateVersion(tv) {
      await rest('POST', '/bo_template_versions', toRow(tv), { Prefer: 'return=minimal' });
    },
    async activateTemplateVersion(id, at) {
      await rest('PATCH', `/bo_template_versions?id=eq.${encodeURIComponent(id)}`, { activated_at: at }, { Prefer: 'return=minimal' });
    },
    async getTemplateVersion(id) {
      const rows = await rest('GET', `/bo_template_versions?id=eq.${encodeURIComponent(id)}`);
      return rows?.length ? fromRow(rows[0]) : null;
    },
    async listTemplateVersions(templateId) {
      const rows = await rest('GET', `/bo_template_versions?template_id=eq.${encodeURIComponent(templateId)}&order=version.desc`);
      return rows.map(fromRow);
    },
    async currentTemplateVersion(templateId) {
      const rows = await rest('GET', `/bo_template_versions?template_id=eq.${encodeURIComponent(templateId)}&activated_at=not.is.null&order=version.desc&limit=1`);
      return rows?.length ? fromRow(rows[0]) : null;
    },

    async getSettings() {
      const rows = await rest('GET', '/bo_settings?key=eq.settings&select=value');
      return { officeCopyEmail: null, ...(rows?.[0]?.value || {}) };
    },
    async saveSettings(patch) {
      const value = { ...(await this.getSettings()), ...patch };
      await rest('POST', '/bo_settings', { key: 'settings', value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    async getSignature(userId) {
      const rows = await rest('GET', `/bo_user_signatures?user_id=eq.${encodeURIComponent(userId)}&select=png`);
      return rows?.[0]?.png ?? null;
    },
    async saveSignature(userId, png) {
      await rest('POST', '/bo_user_signatures', { user_id: userId, png, updated_at: new Date().toISOString() }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },
  };
}
