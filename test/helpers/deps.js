import { createMemoryStore } from '../../lib/store-memory.js';
import { ConflictError } from '../../lib/store-errors.js';
import { createMemoryBlobs } from '../../lib/blobs.js';
import { createMemoryMailer } from '../../lib/mailer.js';
import { createContracts } from '../../lib/contracts.js';
import { createTemplateAdmin } from '../../lib/template-admin.js';
import { TERMS_OF_SALE } from '../../lib/templates.js';
import { fakeClock } from './clock.js';
import { makeFixtureMaster } from './fixture-master.js';
import { pngDataUrl } from './pdf.js';

export const BASE_URL = 'https://office.example';

// wrapStore lets a test inject faults into the store (e.g. a conflict on the Nth commit).
export function makeDeps({ now = '2026-11-23T10:00:00Z', wrapStore = s => s } = {}) {
  const store = wrapStore(createMemoryStore());
  const blobs = createMemoryBlobs();
  const mailer = createMemoryMailer();
  const clock = fakeClock(now);
  const contracts = createContracts({ store, blobs, mailer, clock, baseUrl: BASE_URL, template: TERMS_OF_SALE });
  const templateAdmin = createTemplateAdmin({ store, blobs, clock, template: TERMS_OF_SALE });
  const user = { id: '0b6f1c4e-1111-4000-8000-000000000001', email: 'jo@example.com', fullName: 'Jo Office' };
  async function seedTemplate({ signature = true } = {}) {
    const { versionId } = await templateAdmin.upload(user, await makeFixtureMaster());
    await templateAdmin.activate(user, versionId);
    if (signature) await store.saveSignature(user.id, pngDataUrl());
    return versionId;
  }
  return { store, blobs, mailer, clock, contracts, templateAdmin, user, seedTemplate };
}

const NAMES = ['Anna Example', 'Ben Example', 'Cara Example'];
export function okInput({ signers = 1, fee = 1.5 } = {}) {
  return {
    signers: NAMES.slice(0, signers).map((name, i) => ({ name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, mobile: i === 0 ? '07700 900123' : '' })),
    propertyAddress: '12 Sample Road, Testville, AB1 2CD', basis: 'sole', feePercent: fee, guidePrice: 1250000,
  };
}

export const linksIn = msgs => msgs.map(m => m.text.match(/\/s\/([\w-]+)/)?.[1]).filter(Boolean);

export function signInput(over = {}) {
  return { consent: true, confirmIdentity: false, startMarketingNow: true, signaturePng: pngDataUrl(), initials: 'AE', ...over };
}

export const META = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (test)' };

// A store whose commits fail with ConflictError while failCommits() > 0, and whose reads can be made to throw.
export function faultyStore(store) {
  let conflicts = 0;
  let readError = null;
  let settingsError = null;
  return Object.assign(Object.create(store), store, {
    conflictNext(n = 1) { conflicts = n; },
    throwOnRead(fn) { readError = fn; },
    throwOnSettings(e) { settingsError = e; },
    async commit(arg) {
      if (conflicts > 0) { conflicts--; throw new ConflictError(); }
      return store.commit(arg);
    },
    async getContract(id) {
      if (readError) { const e = readError(id); if (e) throw e; }
      return store.getContract(id);
    },
    async getTemplateVersion(id) {
      if (readError) { const e = readError(id); if (e) throw e; }
      return store.getTemplateVersion(id);
    },
    async getSettings() {
      if (settingsError) { const e = settingsError; settingsError = null; throw e; }
      return store.getSettings();
    },
  });
}
