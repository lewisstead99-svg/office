import { ConflictError } from './store-errors.js';

// In-memory store for tests and local runs. Same interface as the Supabase store.
export function createMemoryStore() {
  const contracts = new Map();
  const signers = new Map();
  const tokens = new Map();      // hash -> { hash, signerId, createdAt }
  const events = [];
  const templateVersions = new Map();
  const signatures = new Map();
  let settings = { officeCopyEmail: null };
  let nextEventId = 1;

  const copy = v => (v === undefined ? v : structuredClone(v));
  const signersOf = id => [...signers.values()].filter(s => s.contractId === id).sort((a, b) => a.position - b.position).map(copy);
  const eventsOf = id => events.filter(e => e.contractId === id).map(copy);
  const full = c => ({ contract: copy(c), signers: signersOf(c.id), events: eventsOf(c.id) });
  const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

  return {
    kind: 'memory',

    async commit({ contracts: cs = [], signers: ss = [], events: es = [], tokens: ts = [], removeSignerIds = [] } = {}) {
      for (const c of cs) {
        const stored = contracts.get(c.id);
        if (c.rev === 1 ? stored : !stored || stored.rev !== c.rev - 1) throw new ConflictError();
        // Same rule as the database: one contract per (family, version).
        if (c.rev === 1 && [...contracts.values()].some(o => o.familyId === c.familyId && o.version === c.version)) throw new ConflictError();
      }
      for (const c of cs) contracts.set(c.id, copy(c));
      for (const id of removeSignerIds) signers.delete(id);
      for (const s of ss) signers.set(s.id, copy(s));
      const now = new Date().toISOString();
      for (const t of ts) tokens.set(t.hash, { hash: t.hash, signerId: t.signerId, createdAt: t.createdAt || now });
      for (const e of es) events.push({ ...copy(e), id: nextEventId++, at: e.at || now, data: copy(e.data) || {} });
    },

    async getContract(id) {
      const c = contracts.get(id);
      return c ? full(c) : null;
    },

    async getFamily(familyId) {
      return [...contracts.values()].filter(c => c.familyId === familyId).sort((a, b) => a.version - b.version).map(copy);
    },

    async findByTokenHash(hash) {
      const t = tokens.get(hash);
      const s = t && signers.get(t.signerId);
      const c = s && contracts.get(s.contractId);
      return c ? { ...full(c), signer: copy(s) } : null;
    },

    async listContracts({ states, limit = 500 } = {}) {
      return [...contracts.values()].filter(c => !states || states.includes(c.state)).sort(newestFirst).slice(0, limit)
        .map(c => ({ contract: copy(c), signers: signersOf(c.id) }));
    },

    async countByState() {
      const out = {};
      for (const c of contracts.values()) out[c.state] = (out[c.state] || 0) + 1;
      return out;
    },

    async listWithEvents(states) {
      return [...contracts.values()].filter(c => states.includes(c.state)).sort(newestFirst).map(full);
    },

    async addTemplateVersion(tv) { templateVersions.set(tv.id, copy(tv)); },
    async activateTemplateVersion(id, at) {
      const tv = templateVersions.get(id);
      if (tv) tv.activatedAt = at;
    },
    async getTemplateVersion(id) { return copy(templateVersions.get(id)) ?? null; },
    async listTemplateVersions(templateId) {
      return [...templateVersions.values()].filter(v => v.templateId === templateId).sort((a, b) => b.version - a.version).map(copy);
    },
    async currentTemplateVersion(templateId) {
      return (await this.listTemplateVersions(templateId)).find(v => v.activatedAt) ?? null;
    },

    async getSettings() { return copy(settings); },
    async saveSettings(patch) { settings = { ...settings, ...copy(patch) }; },
    async getSignature(userId) { return signatures.get(userId) ?? null; },
    async saveSignature(userId, png) { signatures.set(userId, png); },
  };
}
