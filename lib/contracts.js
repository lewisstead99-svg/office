import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { ConflictError } from './store-errors.js';
import { TERMS_OF_SALE } from './templates.js';
import { validateDraft, checkFee, parsePngDataUrl, cleanText } from './validate.js';
import { deriveState, tabOf } from './status.js';
import { londonDate, coolingOffEnds, longDate, calendarDaysBetween } from './dates.js';
import { newToken, hashToken, sha256Hex } from './tokens.js';
import { buildPresented, buildFinal } from './pdf/compose.js';
import { evidenceFrom } from './evidence.js';
import { joinNames } from './pdf/text.js';
import { signingRequestEmail, reminderEmail, signedCopyEmail, cancelledEmail, expiredNoticeEmail } from './emails.js';

const DAY = 86400000;
const LINK_DAYS = 30;
const REMINDER_DAYS = [7, 3];             // checked largest first, so a late run sends one reminder, not two
const OPEN_THROTTLE_MS = 10 * 60000;
const CHASE_GAP_MS = 60 * 60000;
const COPY_DAYS = 30;

const TAB_STATES = {
  out: ['out'], cooling: ['cooling'], signed: ['signed'], drafts: ['draft'],
  ended: ['cancelled', 'expired', 'seller_cancelled', 'replaced'],
};

const MESSAGES = {
  alreadySigned: 'Thank you, you’ve signed. We’ll email the signed copy when everyone has signed.',
  signed: 'This contract is signed. Download your copy below.',
  cancelled: 'This contract was cancelled by Berkeleys Drummond.',
  expired: 'This link has expired. Please contact the office.',
  replaced: 'This contract has been replaced by a newer version.',
  sellerCancelled: 'This contract has been cancelled.',
  copyGone: 'The signed copy was emailed to you. Please contact the office for another copy.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asciiName = s => String(s).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\/:*?<>|]/g, '').trim().slice(0, 80);
export const pdfFileName = address => `Terms of Sale - ${asciiName(address) || 'contract'}.pdf`;

export function createContracts({ store, blobs, mailer, clock = () => new Date(), baseUrl, template = TERMS_OF_SALE }) {
  const now = () => clock();
  const nowIso = () => clock().toISOString();
  const link = token => `${baseUrl}/s/${token}`;
  const ev = (contractId, type, extra = {}) => ({
    contractId, signerId: null, type, at: nowIso(), actorId: null, actorEmail: null, ip: null, userAgent: null, data: {}, ...extra,
  });
  const by = user => (user ? { actorId: user.id, actorEmail: user.email } : {});
  const derive = loaded => deriveState({ ...loaded, now: now() });

  async function load(id) {
    if (!UUID.test(String(id))) throw new HttpError(404, 'Contract not found.');
    const got = await store.getContract(id);
    if (!got) throw new HttpError(404, 'Contract not found.');
    return got;
  }

  // Save changes to one or more contracts in a single commit. Each change bumps rev and re-derives state.
  async function apply(changes, { tokens = [], removeSignerIds = [] } = {}) {
    const contracts = [], signersOut = [], eventsOut = [], results = [];
    for (const { loaded, patch = {}, signers = [], events = [] } of changes) {
      const contract = { ...loaded.contract, ...patch, rev: loaded.contract.rev + 1 };
      const byId = new Map(loaded.signers.filter(s => !removeSignerIds.includes(s.id)).map(s => [s.id, s]));
      for (const s of signers) byId.set(s.id, s);
      const allSigners = [...byId.values()].sort((a, b) => a.position - b.position);
      const allEvents = [...loaded.events, ...events];
      contract.state = deriveState({ contract, signers: allSigners, events: allEvents, now: now() }).state;
      contracts.push(contract); signersOut.push(...signers); eventsOut.push(...events);
      results.push({ contract, signers: allSigners, events: allEvents });
    }
    await store.commit({ contracts, signers: signersOut, events: eventsOut, tokens, removeSignerIds });
    return results;
  }

  async function recordEmailFailures(id, failures, kind = 'signing') {
    if (!failures.length) return;
    for (let attempt = 0; ; attempt++) {
      const loaded = await load(id);
      try {
        await apply([{ loaded, events: failures.map(f => ev(id, 'email_failed', { signerId: f.signerId, data: { signerId: f.signerId, kind, message: String(f.message).slice(0, 300) } })) }]);
        return;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt > 0) throw e;   // someone else saved at the same moment: re-read and try once more
      }
    }
  }

  async function emailEach(items) {
    const failures = [];
    for (const { signerId, msg } of items) {
      try { await mailer.send(msg); } catch (e) { failures.push({ signerId, message: e.message }); }
    }
    return failures;
  }

  async function currentTemplate() {
    const tv = await store.currentTemplateVersion(template.id);
    if (!tv) throw new HttpError(409, 'Upload the Terms of Sale master in Settings first.');
    return tv;
  }

  const newSigner = (contractId, s, i) => ({
    id: randomUUID(), contractId, position: i, name: s.name, email: s.email, mobile: s.mobile || null,
    sharedEmail: !!s.sharedEmail, status: 'pending', signedAt: null, signaturePng: null, initials: null, startMarketingNow: null,
  });
  const fieldsFrom = v => ({ propertyAddress: v.propertyAddress, basis: v.basis, otherAgent: v.otherAgent, feePercent: v.feePercent, guidePrice: v.guidePrice });

  function invalid(errors) {
    return new HttpError(400, 'Please check the highlighted fields.', { errors });
  }

  // ---------- drafts and sending ----------

  async function createDraft(user, input) {
    const { value, errors } = validateDraft(input, template);
    if (Object.keys(errors).length) throw invalid(errors);
    const id = randomUUID();
    const contract = {
      id, familyId: id, version: 1, kind: 'new', replacesId: null, templateVersionId: null, fields: fieldsFrom(value), note: null,
      createdBy: { id: user.id, name: user.fullName }, sender: null, presentedPath: null, presentedSha256: null,
      finalPath: null, finalSha256: null, state: 'draft', rev: 1, createdAt: nowIso(), sentAt: null, completedAt: null,
    };
    const signers = value.signers.map((s, i) => newSigner(id, s, i));
    await store.commit({ contracts: [contract], signers, events: [ev(id, 'created', by(user))] });
    return { id };
  }

  async function updateDraft(user, id, input = {}) {
    const loaded = await load(id);
    if (derive(loaded).state !== 'draft') throw new HttpError(409, 'Only drafts can be edited.');
    if (loaded.contract.kind === 'fee_change') {
      if (Object.keys(input).some(k => !['feePercent', 'note'].includes(k))) throw new HttpError(400, 'Only the fee can change on a fee change.');
      const feeError = checkFee(input.feePercent);
      if (feeError) throw invalid({ feePercent: feeError });
      const note = input.note === undefined ? loaded.contract.note : String(input.note || '').trim().slice(0, 500) || null;
      await apply([{ loaded, patch: { fields: { ...loaded.contract.fields, feePercent: Number(input.feePercent) }, note } }]);
      return;
    }
    const { value, errors } = validateDraft(input, template);
    if (Object.keys(errors).length) throw invalid(errors);
    const signers = value.signers.map((s, i) => ({ ...(loaded.signers[i] ? { ...loaded.signers[i] } : newSigner(id, s, i)), name: s.name, email: s.email, mobile: s.mobile || null, sharedEmail: !!s.sharedEmail, position: i }));
    const removeSignerIds = loaded.signers.slice(value.signers.length).map(s => s.id);
    await apply([{ loaded, patch: { fields: fieldsFrom(value) }, signers }], { removeSignerIds });
  }

  async function previewPdf(id) {
    const { contract, signers } = await load(id);
    if (contract.finalPath) return mustGet(contract.finalPath);
    if (contract.presentedPath) return mustGet(contract.presentedPath);
    if (contract.state !== 'draft') throw new HttpError(404, 'No document is available for this contract.');
    const tv = await currentTemplate();
    return buildPresented({
      masterBytes: await mustGet(tv.path), fieldRects: tv.fieldRects, template, signers, contract,
      sender: { name: contract.createdBy?.name || '', signaturePng: null }, sentAt: nowIso(),
    });
  }

  async function mustGet(path) {
    const bytes = await blobs.get(path);
    if (!bytes) throw new HttpError(404, 'The document file is missing.');
    return bytes;
  }

  async function send(user, id) {
    const loaded = await load(id);
    const { contract, signers } = loaded;
    if (derive(loaded).state !== 'draft') throw new HttpError(409, 'This contract has already been sent.');
    const tv = await currentTemplate();
    const signature = await store.getSignature(user.id);
    if (!signature) throw new HttpError(409, 'Add your signature in Profile before sending.');

    const sentAt = nowIso();
    const sender = { id: user.id, email: user.email, name: user.fullName };
    const presented = await buildPresented({
      masterBytes: await mustGet(tv.path), fieldRects: tv.fieldRects, template, signers, contract,
      sender: { name: sender.name, signaturePng: signature }, sentAt,
    });
    // Named by fingerprint: a request that loses a race can never overwrite the file the log points at.
    const presentedSha256 = sha256Hex(presented);
    const presentedPath = `contracts/${id}/presented-${presentedSha256.slice(0, 16)}.pdf`;
    await blobs.put(presentedPath, presented);
    const issued = signers.map(s => ({ signer: s, ...newToken() }));
    await apply([{
      loaded,
      patch: { sender, sentAt, templateVersionId: tv.id, presentedPath, presentedSha256 },
      events: [ev(id, 'sent', { ...by(user), data: { presentedSha256, templateVersionId: tv.id } })],
    }], { tokens: issued.map(t => ({ hash: t.hash, signerId: t.signer.id, createdAt: sentAt })) });

    const failures = await emailEach(issued.map(({ signer, token }) => ({
      signerId: signer.id,
      msg: { to: [signer.email], ...signingRequestEmail({ signerName: signer.name, propertyAddress: contract.fields.propertyAddress, senderName: sender.name, link: link(token), kind: contract.kind }) },
    })));
    if (failures.length) {
      await recordEmailFailures(id, failures);
      throw new HttpError(502, 'Saved, but an email could not be sent. Use Chase to try again.');
    }
  }

  // ---------- the seller's link ----------

  async function byToken(token) {
    const found = await store.findByTokenHash(hashToken(String(token || '')));
    if (!found) throw new HttpError(404, 'This link is not valid.');
    return found;
  }

  // What the seller's link should treat the contract as: past 30 UK days unsigned counts as expired
  // even if the daily job hasn't run yet.
  function sellerState(found) {
    const { state } = derive(found);
    if (state === 'out' && found.contract.sentAt && calendarDaysBetween(found.contract.sentAt, now()) >= LINK_DAYS) return 'expired';
    return state;
  }

  function withinCopyWindow(contract) {
    return !!contract.completedAt && now().getTime() - Date.parse(contract.completedAt) <= COPY_DAYS * DAY;
  }

  function sellerMessage(state, signer, contract) {
    if (state === 'out') return signer.status === 'signed' ? MESSAGES.alreadySigned : null;
    if (state === 'signed' || state === 'cooling') return withinCopyWindow(contract) ? MESSAGES.signed : MESSAGES.copyGone;
    if (state === 'seller_cancelled') return MESSAGES.sellerCancelled;
    return MESSAGES[state] ?? MESSAGES.expired;
  }

  async function openLink(token, meta = {}) {
    const found = await byToken(token);
    const { contract, signers, events, signer } = found;
    const lastOpen = events.filter(e => e.type === 'opened' && e.signerId === signer.id).at(-1);
    if (!lastOpen || now().getTime() - Date.parse(lastOpen.at) >= OPEN_THROTTLE_MS) {
      try { await apply([{ loaded: found, events: [ev(contract.id, 'opened', { signerId: signer.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null })] }]); }
      catch (e) { if (!(e instanceof ConflictError)) throw e; }   // a busy moment is not worth failing the page for
    }
    const state = sellerState(found);
    const message = sellerMessage(state, signer, contract);
    return {
      signer: { name: signer.name, status: signer.status, initials: signer.initials },
      contract: { ref: contract.id.slice(0, 8).toUpperCase(), propertyAddress: contract.fields.propertyAddress, kind: contract.kind, version: contract.version, senderName: contract.sender?.name ?? '' },
      state,
      message,
      canSign: state === 'out' && signer.status === 'pending',
      otherSigners: signers.filter(s => s.id !== signer.id).map(s => ({ name: s.name, signed: s.status === 'signed' })),
      sharedEmail: !!signer.sharedEmail,
      documentAvailable: state === 'out' || (!!contract.finalPath && withinCopyWindow(contract)),
    };
  }

  async function documentForLink(token) {
    const found = await byToken(token);
    const { contract, signer } = found;
    const state = sellerState(found);
    if (state === 'out' && contract.presentedPath) return { bytes: await mustGet(contract.presentedPath), fileName: pdfFileName(contract.fields.propertyAddress) };
    if (contract.finalPath && withinCopyWindow(contract)) return { bytes: await mustGet(contract.finalPath), fileName: pdfFileName(contract.fields.propertyAddress) };
    if (contract.finalPath) throw new HttpError(410, MESSAGES.copyGone);
    throw new HttpError(410, sellerMessage(state, signer, contract) || MESSAGES.expired);
  }

  function checkSignInput(input) {
    if (input?.consent !== true) throw new HttpError(400, 'Please tick to agree to sign electronically.');
    if (typeof input.startMarketingNow !== 'boolean') throw new HttpError(400, 'Please choose whether we can start marketing now.');
    const initials = cleanText(input.initials, '');
    if (initials.length < 1 || initials.length > 6) throw new HttpError(400, 'Please add your initials (up to 6 letters).');
    parsePngDataUrl(input.signaturePng);
    return initials;
  }

  async function sign(token, input, meta = {}) {
    const initials = checkSignInput(input);
    for (let attempt = 0; ; attempt++) {
      const found = await byToken(token);
      const { contract, signers, signer } = found;
      const state = sellerState(found);
      if (state !== 'out' || signer.status !== 'pending') throw new HttpError(409, sellerMessage(state, signer, contract) || MESSAGES.expired);
      if (signer.sharedEmail && input.confirmIdentity !== true) throw new HttpError(400, `Please confirm you are ${signer.name}.`);

      const at = nowIso();
      const updated = { ...signer, status: 'signed', signedAt: at, signaturePng: input.signaturePng, initials, startMarketingNow: input.startMarketingNow };
      const events = [
        ev(contract.id, 'consented', { signerId: signer.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, at }),
        ev(contract.id, 'signed', { signerId: signer.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, at, data: { startMarketingNow: input.startMarketingNow } }),
      ];
      const last = signers.every(s => s.id === signer.id || s.status === 'signed');
      const changes = [];
      let patch = {}, finalBytes = null;
      if (last) {
        const allSigners = signers.map(s => (s.id === signer.id ? updated : s));
        const tv = await store.getTemplateVersion(contract.templateVersionId);
        const presentedBytes = await blobs.get(contract.presentedPath);
        if (!presentedBytes || sha256Hex(presentedBytes) !== contract.presentedSha256) {
          console.error(`Contract ${contract.id}: presented copy missing or does not match its fingerprint`);
          throw new HttpError(409, 'This document could not be checked, so it cannot be signed. Please contact the office.');
        }
        const evidence = evidenceFrom({ contract: { ...contract, presentedLength: presentedBytes.length }, signers: allSigners, events: [...found.events, ...events], templateVersion: tv });
        finalBytes = await buildFinal({ presentedBytes, fieldRects: tv.fieldRects, template, signers: allSigners, evidence });
        const finalSha256 = sha256Hex(finalBytes);
        const finalPath = `contracts/${contract.id}/final-${finalSha256.slice(0, 16)}.pdf`;
        await blobs.put(finalPath, finalBytes);
        patch = { finalPath, finalSha256, completedAt: at, presentedPath: null };
        events.push(ev(contract.id, 'completed', { at, data: { finalSha256, presentedSha256: contract.presentedSha256, presentedLength: presentedBytes.length } }));
        if (contract.kind === 'fee_change' && contract.replacesId) {
          const previous = await load(contract.replacesId);
          changes.push({ loaded: previous, events: [ev(previous.contract.id, 'replaced', { at, data: { byVersion: contract.version, byId: contract.id } })] });
        }
      }
      try {
        await apply([{ loaded: found, patch, signers: [updated], events }, ...changes]);
      } catch (e) {
        if (e instanceof ConflictError) {
          if (attempt === 0) continue;
          throw new HttpError(409, 'Someone else updated this contract at the same moment. Please try again.', { retry: true });
        }
        throw e;
      }
      if (last) {
        try { await afterCompletion(contract, signers.map(s => (s.id === signer.id ? updated : s)), finalBytes, contract.presentedPath); }
        catch (e) { console.error(`Contract ${contract.id}: after-signing step failed:`, e.message); }
      }
      return { allSigned: last };
    }
  }

  async function emailSignedCopy(contract, signers, finalBytes) {
    let officeCopyEmail = null;
    try { ({ officeCopyEmail } = await store.getSettings()); }
    catch (e) { console.error('Could not read the office copy address:', e.message); }
    const to = [...new Set([...signers.map(s => s.email), contract.sender?.email, officeCopyEmail].filter(Boolean))];
    await mailer.send({ to, ...signedCopyEmail({ propertyAddress: contract.fields.propertyAddress, ref: contract.id.slice(0, 8).toUpperCase() }), attachments: [{ filename: pdfFileName(contract.fields.propertyAddress), content: finalBytes }] });
  }

  async function afterCompletion(contract, signers, finalBytes, presentedPath) {
    // The signed copy starts with the presented bytes, so the separate presented file is no longer needed.
    try { if (presentedPath) await blobs.del(presentedPath); } catch (e) { console.error('Could not remove presented copy:', e.message); }
    try { await emailSignedCopy(contract, signers, finalBytes); }
    catch (e) { await recordEmailFailures(contract.id, [{ signerId: null, message: e.message }], 'signed_copy').catch(err => console.error(err.message)); }
  }

  async function resendSignedCopy(user, id) {
    const loaded = await load(id);
    const c = loaded.contract;
    if (!c.finalPath) throw new HttpError(409, 'Only signed contracts can be emailed again.');
    const bytes = await mustGet(c.finalPath);
    try { await emailSignedCopy(c, loaded.signers, bytes); }
    catch (e) {
      await recordEmailFailures(id, [{ signerId: null, message: e.message }], 'signed_copy');
      throw new HttpError(502, 'The signed copy could not be emailed. Please try again later.');
    }
    const fresh = await load(id);
    await apply([{ loaded: fresh, events: [ev(id, 'copy_emailed', by(user))] }]);
  }

  // ---------- office actions ----------

  async function chase(user, id) {
    const loaded = await load(id);
    if (derive(loaded).state !== 'out') throw new HttpError(409, 'Only contracts out for signing can be chased.');
    // A chase whose email failed doesn't count, so staff can retry straight away.
    const failedAfter = (ch, i) => loaded.events.slice(i + 1).some(f => f.type === 'email_failed' && f.signerId === ch.signerId);
    const lastChase = loaded.events.filter((e, i) => e.type === 'chased' && !failedAfter(e, i)).at(-1);
    if (lastChase && now().getTime() - Date.parse(lastChase.at) < CHASE_GAP_MS) throw new HttpError(429, 'Chased less than an hour ago.');
    const pending = loaded.signers.filter(s => s.status === 'pending');
    const issued = pending.map(s => ({ signer: s, ...newToken() }));
    await apply([{ loaded, events: pending.map(s => ev(id, 'chased', { ...by(user), signerId: s.id })) }], { tokens: issued.map(t => ({ hash: t.hash, signerId: t.signer.id, createdAt: nowIso() })) });
    const c = loaded.contract;
    const failures = await emailEach(issued.map(({ signer, token }) => ({
      signerId: signer.id,
      msg: { to: [signer.email], ...reminderEmail({ signerName: signer.name, propertyAddress: c.fields.propertyAddress, senderName: c.sender?.name ?? '', link: link(token), kind: c.kind }) },
    })));
    if (failures.length) {
      await recordEmailFailures(id, failures);
      throw new HttpError(502, 'Saved, but an email could not be sent. Use Chase to try again.');
    }
    return { emailed: issued.length };
  }

  async function cancel(user, id, reason) {
    const why = String(reason ?? '').trim();
    if (!why || why.length > 500) throw new HttpError(400, 'Give a reason for cancelling (up to 500 characters).');
    const loaded = await load(id);
    const { state } = derive(loaded);
    if (state !== 'draft' && state !== 'out') throw new HttpError(409, 'Only drafts and contracts out for signing can be cancelled.');
    await apply([{ loaded, events: [ev(id, 'cancelled', { ...by(user), data: { reason: why } })] }]);
    if (state === 'out') {
      const pending = loaded.signers.filter(s => s.status === 'pending');
      await emailEach(pending.map(s => ({ signerId: s.id, msg: { to: [s.email], ...cancelledEmail({ signerName: s.name, propertyAddress: loaded.contract.fields.propertyAddress }) } })))
        .then(f => recordEmailFailures(id, f)).catch(e => console.error(e));
    }
  }

  async function familyStates(familyId) {
    const members = await store.getFamily(familyId);
    const out = [];
    for (const m of members) {
      const got = await store.getContract(m.id);
      const d = derive(got);
      out.push({ id: m.id, version: m.version, kind: m.kind, state: d.state, label: d.label });
    }
    return out;
  }

  async function startFeeChange(user, id, { feePercent, note } = {}) {
    const loaded = await load(id);
    const { state } = derive(loaded);
    if (state !== 'signed' && state !== 'cooling') throw new HttpError(409, 'Only a signed contract can have a fee change.');
    const family = await familyStates(loaded.contract.familyId);
    const open = family.find(f => f.state === 'draft' || f.state === 'out');
    if (open) throw new HttpError(409, `A fee change is already in progress (v${open.version}).`);
    const feeError = checkFee(feePercent);
    if (feeError) throw invalid({ feePercent: feeError });
    const src = loaded.contract;
    const newId = randomUUID();
    const contract = {
      id: newId, familyId: src.familyId, version: Math.max(...family.map(f => f.version)) + 1, kind: 'fee_change', replacesId: src.id,
      templateVersionId: null, fields: { ...src.fields, feePercent: Number(feePercent) }, note: String(note ?? '').trim().slice(0, 500) || null,
      createdBy: { id: user.id, name: user.fullName }, sender: null, presentedPath: null, presentedSha256: null,
      finalPath: null, finalSha256: null, state: 'draft', rev: 1, createdAt: nowIso(), sentAt: null, completedAt: null,
    };
    const signers = loaded.signers.map((s, i) => newSigner(newId, s, i));
    try {
      await store.commit({ contracts: [contract], signers, events: [ev(newId, 'created', { ...by(user), data: { feeFrom: src.fields.feePercent, feeTo: Number(feePercent), replaces: src.id } })] });
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, `A fee change is already in progress (v${contract.version}).`);
      throw e;
    }
    return { id: newId };
  }

  async function recordSellerCancel(user, id, { date, note } = {}) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, 'Enter the date the seller cancelled.');
    const loaded = await load(id);
    const { state } = derive(loaded);
    const c = loaded.contract;
    if (!c.completedAt || state === 'seller_cancelled' || state === 'replaced') throw new HttpError(409, 'This contract cannot be marked as cancelled by the seller.');
    if (date > londonDate(now())) throw new HttpError(409, 'The cancellation date can’t be in the future.');
    if (date < londonDate(c.completedAt) || date > coolingOffEnds(c.completedAt)) throw new HttpError(409, 'Outside the 14-day cancellation period.');
    const open = (await familyStates(c.familyId)).find(f => f.id !== id && (f.state === 'draft' || f.state === 'out'));
    if (open) throw new HttpError(409, `Cancel the fee change in progress (v${open.version}) first.`);
    const changes = [{ loaded, events: [ev(id, 'seller_cancelled', { ...by(user), data: { date, note: String(note ?? '').trim().slice(0, 500) || null } })] }];
    if (c.kind === 'fee_change' && c.replacesId) {
      const previous = await load(c.replacesId);
      changes.push({ loaded: previous, events: [ev(previous.contract.id, 'reinstated', { ...by(user), data: { byVersion: c.version } })] });
    }
    await apply(changes);
  }

  // ---------- the daily job ----------

  async function runDaily() {
    const result = { reminded: 0, expired: 0, refreshed: 0 };
    const t = now().getTime();
    for (const row of await store.listWithEvents(['out', 'cooling'])) {
      try {
        const c = row.contract;
        if (c.state === 'cooling') {
          if (derive(row).state !== 'cooling') { await apply([{ loaded: row }]); result.refreshed++; }
          continue;
        }
        const days = calendarDaysBetween(c.sentAt, now());
        if (days >= LINK_DAYS) {
          await apply([{ loaded: row, events: [ev(c.id, 'expired')] }]);
          result.expired++;
          if (c.sender?.email) await mailer.send({ to: [c.sender.email], ...expiredNoticeEmail({ propertyAddress: c.fields.propertyAddress }) }).catch(e => console.error(e));
          continue;
        }
        const due = [];
        for (const s of row.signers.filter(x => x.status === 'pending')) {
          const sent = row.events.filter(e => e.type === 'reminded' && e.signerId === s.id).map(e => e.data?.day ?? 0);
          const day = REMINDER_DAYS.find(d => days >= d && !sent.some(x => x >= d));
          if (day) due.push({ signer: s, day, ...newToken() });
        }
        if (!due.length) continue;
        await apply([{ loaded: row, events: due.map(x => ev(c.id, 'reminded', { signerId: x.signer.id, data: { day: x.day } })) }],
          { tokens: due.map(x => ({ hash: x.hash, signerId: x.signer.id, createdAt: nowIso() })) });
        const failures = await emailEach(due.map(({ signer, token }) => ({
          signerId: signer.id,
          msg: { to: [signer.email], ...reminderEmail({ signerName: signer.name, propertyAddress: c.fields.propertyAddress, senderName: c.sender?.name ?? '', link: link(token), kind: c.kind }) },
        })));
        result.reminded += due.length - failures.length;
        await recordEmailFailures(c.id, failures);
      } catch (e) {
        console.error(`Daily job: contract ${row.contract.id} failed:`, e.message);
      }
    }
    return result;
  }

  // ---------- views for the office ----------

  async function detail(id) {
    const loaded = await load(id);
    const d = derive(loaded);
    const family = await familyStates(loaded.contract.familyId);
    const names = new Map(loaded.signers.map(s => [s.id, s.name]));
    const c = loaded.contract;
    const familyBusy = family.some(f => f.id !== c.id && (f.state === 'draft' || f.state === 'out'));
    return {
      contract: c,
      emailProblem: emailProblem(loaded.events, d.state),
      signers: loaded.signers.map(({ signaturePng, ...s }) => s),
      events: loaded.events.map(e => ({ ...e, signerName: e.signerId ? names.get(e.signerId) ?? null : null })),
      state: d.state, label: d.label, coolingOffUntil: d.coolingOffUntil, signedCount: d.signedCount, signerCount: d.signerCount, daysWaiting: d.daysWaiting,
      family,
      can: {
        edit: d.state === 'draft', send: d.state === 'draft', chase: d.state === 'out', cancel: d.state === 'draft' || d.state === 'out',
        feeChange: (d.state === 'signed' || d.state === 'cooling') && !familyBusy,
        sellerCancel: !!c.completedAt && !['seller_cancelled', 'replaced'].includes(d.state) && londonDate(now()) <= coolingOffEnds(c.completedAt),
      },
    };
  }

  // 'signing' when the latest signing email went wrong (cleared by a later successful send/chase/reminder),
  // 'signed_copy' when the signed copy didn't go out (cleared by "Email signed copy again").
  function emailProblem(events, state) {
    const copyFailed = events.findLastIndex(e => e.type === 'email_failed' && e.data?.kind === 'signed_copy');
    if (copyFailed >= 0 && events.findLastIndex(e => e.type === 'copy_emailed') < copyFailed) return 'signed_copy';
    if (state !== 'out') return null;
    const last = events.filter(e => ['sent', 'chased', 'reminded'].includes(e.type) || (e.type === 'email_failed' && e.data?.kind !== 'signed_copy')).at(-1);
    return last?.type === 'email_failed' ? 'signing' : null;
  }

  function rowLabel(c, signers) {
    switch (c.state) {
      case 'draft': return 'Draft';
      case 'out': return 'Out for signing';
      case 'cooling': return `Cooling off until ${longDate(coolingOffEnds(c.completedAt))}`;
      case 'signed': return signers.length && signers.every(s => s.startMarketingNow === true) && londonDate(now()) <= coolingOffEnds(c.completedAt) ? 'Signed – marketing may start' : 'Signed';
      case 'cancelled': return 'Cancelled by office';
      case 'expired': return 'Expired';
      case 'seller_cancelled': return 'Cancelled by seller';
      case 'replaced': return 'Replaced by a newer version';
      default: return c.state;
    }
  }

  async function list({ tab = 'out', mine = false, q = '', user, limit = 200 } = {}) {
    limit = Math.min(1000, Math.max(1, Number(limit) || 200));
    const states = TAB_STATES[tab] ?? TAB_STATES.out;
    const byState = await store.countByState();
    const counts = { out: 0, cooling: 0, signed: 0, ended: 0, drafts: 0 };
    for (const [s, n] of Object.entries(byState)) counts[tabOf(s)] += n;
    const needle = String(q || '').trim().toLowerCase();
    const matched = (await store.listContracts({ states, limit: needle ? 1000 : limit + 1 }))
      .filter(({ contract }) => !mine || (contract.sender ?? contract.createdBy)?.id === user?.id)
      .filter(({ contract, signers }) => !needle || contract.fields.propertyAddress.toLowerCase().includes(needle) || signers.some(s => s.name.toLowerCase().includes(needle)))
      .map(({ contract: c, signers }) => ({
        id: c.id, ref: c.id.slice(0, 8).toUpperCase(), version: c.version, kind: c.kind,
        propertyAddress: c.fields.propertyAddress, clientNames: joinNames(signers.map(s => s.name)),
        senderName: c.sender?.name ?? c.createdBy?.name ?? '', sentAt: c.sentAt, createdAt: c.createdAt, state: c.state, label: rowLabel(c, signers),
        signedCount: signers.filter(s => s.status === 'signed').length, signerCount: signers.length,
        daysWaiting: c.state === 'out' && c.sentAt ? Math.floor((now().getTime() - Date.parse(c.sentAt)) / DAY) : null,
      }));
    return { counts, rows: matched.slice(0, limit), more: matched.length > limit };
  }

  return { createDraft, updateDraft, previewPdf, send, openLink, documentForLink, sign, chase, cancel, startFeeChange, recordSellerCancel, resendSignedCopy, runDaily, detail, list };
}
