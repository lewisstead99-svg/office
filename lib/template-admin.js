import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { prepareMaster, MasterError } from './pdf/master.js';
import { buildSample } from './pdf/compose.js';

// Uploading a new Terms of Sale master: prepared once, checked with a sample, then made live.
export function createTemplateAdmin({ store, blobs, clock = () => new Date(), template }) {
  async function upload(user, bytes) {
    let prepared;
    try { prepared = await prepareMaster(bytes, template); }
    catch (e) { if (e instanceof MasterError) throw new HttpError(400, e.message); throw e; }
    const versions = await store.listTemplateVersions(template.id);
    const version = (versions[0]?.version ?? 0) + 1;
    const id = randomUUID();
    const path = `templates/${id}.pdf`;
    await blobs.put(path, prepared.bytes);
    await store.addTemplateVersion({
      id, templateId: template.id, version, path, sha256: prepared.sha256, bytes: prepared.bytes.length,
      fieldRects: prepared.fieldRects, uploadedBy: { id: user.id, name: user.fullName }, uploadedAt: clock().toISOString(), activatedAt: null,
    });
    return { versionId: id, version, fieldNames: Object.keys(prepared.fieldRects) };
  }

  async function getVersion(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) throw new HttpError(404, 'That master copy was not found.');
    const tv = await store.getTemplateVersion(id);
    if (!tv || tv.templateId !== template.id) throw new HttpError(404, 'That master copy was not found.');
    return tv;
  }

  async function samplePdf(id) {
    const tv = await getVersion(id);
    const master = await blobs.get(tv.path);
    if (!master) throw new HttpError(404, 'The master copy file is missing.');
    return buildSample({ masterBytes: master, fieldRects: tv.fieldRects, template });
  }

  async function activate(user, id) {
    await getVersion(id);
    await store.activateTemplateVersion(id, clock().toISOString());
  }

  async function list() {
    const [versions, current] = await Promise.all([store.listTemplateVersions(template.id), store.currentTemplateVersion(template.id)]);
    return versions.map(v => ({ id: v.id, version: v.version, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, activatedAt: v.activatedAt, current: v.id === current?.id, fieldNames: Object.keys(v.fieldRects || {}) }));
  }

  return { upload, samplePdf, activate, list };
}
