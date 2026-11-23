# Berkeleys Office: Contracts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build "Berkeleys Office", a signed-in hub for Berkeleys Drummond staff. Its first section, Contracts:
- fills the firm's Terms of Sale PDF;
- emails sellers a link to sign online;
- keeps a tamper-evident signed copy;
- tracks every contract until it's signed, cancelled or replaced by a fee change.

**Architecture:** A no-framework Node 22 app shaped like Key Tracker.
- `lib/router.js` serves `/api/*`, both from `server.js` (local) and from `api/index.js` (Vercel).
- The rules live in `lib/contracts.js`, which talks to swappable adapters:
  - store: in memory locally and in tests, Supabase when hosted;
  - blob storage: memory / Supabase Storage;
  - mailer: memory / console / Resend;
  - sign-in: local users / Supabase Auth.
- PDF work is in `lib/pdf/`, on `@cantoo/pdf-lib`. The front end is plain HTML/CSS/JS in `public/`.

**Tech Stack:** Node ≥ 22 (ES modules, `node --test`), `@cantoo/pdf-lib` 2.11.1, Supabase (REST, Auth, Storage via `fetch`), Resend, Vercel (functions + one daily cron).

**Spec:** `docs/superpowers/specs/2026-11-23-contracts-design.md`. Read it first; this plan argues from it.

## Global Constraints

- **Node and dependencies:** Node `>=22`, `"type": "module"`, `node --test`. Exactly one dependency: `"@cantoo/pdf-lib": "2.11.1"`. No front-end build step.
- **Repo:** `~/Downloads/02 Clients/Berkeleys Drummond/berkeleys-office`, branch `main`, no remote. Lewis uploads to GitHub by hand.
- **No real data in git:** ignore `data/`, `seed/`, `.env*` and `node_modules/`. Tests use made-up people and addresses (`Anna Example`, `anna@example.com`, `12 Sample Road, Testville, AB1 2CD`).
- **The real master:** it sits at `~/Downloads/02 Clients/Berkeleys Drummond/Contracts/BD Terms of Sale 2026 Master Copy.pdf`. Copy it to `seed/terms-of-sale-master.pdf` for local checks; never commit it.
- **Supabase:** hosted mode uses **Key Tracker's existing Supabase project**.
  - SQL is additive only, and new tables are prefixed `bo_`.
  - Never alter, drop or write to `key_*` tables. The only exceptions are reading `key_users` and inserting into `key_security_log`.
- **Access:** everyone signed in can do everything. A `key_users` row with `active = false` can't sign in.
- **Security:**
  - the service-role key stays on the server;
  - cookies `bo_session`/`bo_refresh` are HttpOnly, `SameSite=Strict`, and `Secure` in production;
  - a POST/PUT from another origin gets 403 (copy Key Tracker's check).
- **Language and dates:** UK English. Europe/London dates, shown as `7 December 2026` or `23 November 2026, 14:05`.
- **Numbers pinned by the spec:**
  - links expire 30 days after sending;
  - reminders on day 3 and day 7;
  - Chase at most once an hour per contract;
  - cooling-off ends 14 London days after the last signature;
  - the seller's link shows the signed copy for 30 days after completion;
  - nothing is deleted except `presented.pdf` after completion.
- **Validation:** 1–6 sellers; names up to 100 characters; address up to 200 characters, one line; the lead seller's mobile is required and must be a UK mobile (`/^(?:\+447\d{9}|07\d{9})$/` after stripping spaces and dashes); fee 0.1–10 with at most 2 decimals; guide price a whole number of pounds, 1–100,000,000.
- **Look:** copy Key Tracker's `:root` tokens and base styles, plus `bd-logo.png`, favicons and icons, from `~/Downloads/BD_Both_Systems_Mobile_UI_Update/keys-main/public/`. Works at 360px wide and on desktop; dark mode follows the system.
- **Out of scope** (spec non-goals): Decline button, backup download, storage meter, roles, user management.

## Review Focus

1. **Characters Helvetica can't draw** (`Zoë Łukasz-Nowak`, curly quotes, emoji): the PDF still builds, showing `Zoë Lukasz-Nowak` with emoji → `?`. Tested in Task 3.
2. **Text too long for its box** (four names in Client, a 200-character address, `12.25%` in the 24pt fee box): it shrinks to 5pt, then cuts with `…`, and never overlaps. Tested in Task 3.
3. **The last two joint sellers signing at the same moment:** both signatures are kept and completion happens once. A conflicting `sign` re-reads and retries once. If the contract was cancelled meanwhile, the seller gets the cancelled message (409). Tested in Task 4.
4. **Stale links** (after cancel, expiry, replacement, already signed, or 30 days after completion): a plain message, no signature box, nothing recorded except the open. Tested in Task 5.
5. **Email service failing on Send or Chase:** the contract stays Out for signing, an `email_failed` event shows on its timeline, and Chase re-sends. Tested in Task 4.

---

## Shared shapes

```
Contract { id, familyId, version, kind: 'new'|'fee_change', replacesId, templateVersionId,
  fields: { propertyAddress, basis, otherAgent, feePercent, guidePrice }, note,
  createdBy: { id, name }, sender: { id, email, name } | null,
  presentedPath, presentedSha256, finalPath, finalSha256, state, rev, createdAt, sentAt, completedAt }
Signer { id, contractId, position, name, email, mobile, sharedEmail, status: 'pending'|'signed',
  signedAt, signaturePng, initials, startMarketingNow }
Token { hash, signerId, createdAt }   // one per email sent; all of a signer's tokens stay valid
Event { id, contractId, signerId, type, at, actorId, actorEmail, ip, userAgent, data }
TemplateVersion { id, templateId, version, path, sha256, bytes, fieldRects, uploadedBy, uploadedAt, activatedAt }
```

Links are stored only as hashes, so every signing email (send, reminder, chase) issues a **new** token. Whether a link works depends only on the contract state and the signer's status.

---

### Task 1: Foundations — repo, server, rules that need no storage

**Files:**
- Create: `package.json`, `.gitignore`, `server.js`
- Create: `lib/http.js`, `lib/tokens.js`, `lib/dates.js`, `lib/status.js`, `lib/templates.js`, `lib/validate.js`, `lib/router.js` (skeleton)
- Create: `test/helpers/{boot.js,clock.js}`, `test/foundations.test.js`

**Produces:**
- `lib/http.js`:
  - `HttpError(status, message, extra?)`
  - `send(res, status, body, headers?)` (JSON, `no-store`)
  - `readJson(req, limit = 5e6)`: 400 for bad JSON, 413 when too big
  - `readBody(req, limit)`
  - `clientMeta(req) → { ip, userAgent }`: the first `x-forwarded-for` entry, and the user agent cut to 300 characters
  - `serveStatic(res, dir, pathname) → boolean`: refuses `..`
- `lib/tokens.js`: `sha256Hex(bytes|string)`, `newToken() → { token, hash }` (32 random bytes, base64url), `hashToken(token)`.
- `lib/dates.js`: `londonDate(x) → 'YYYY-MM-DD'`, `addDays(ymd, n)`, `longDate(x)`, `londonDateTime(iso)`, `daysBetween(a, b)` (floor), `coolingOffEnds(completedAtIso) = addDays(londonDate(completedAt), 14)`. Use `Intl` only.
- `lib/status.js`: `EV` (`created sent email_failed opened consented signed reminded chased cancelled expired completed seller_cancelled replaced reinstated`), `deriveState({ contract, signers, events, now }) → { state, label, coolingOffUntil, signedCount, signerCount, daysWaiting }`, `tabOf(state)`. `deriveState` applies the first matching row:

| Condition | state | label |
|---|---|---|
| `cancelled` event | `cancelled` | `Cancelled by office` |
| no `sent` event | `draft` | `Draft` |
| `expired` event | `expired` | `Expired` |
| no `completed` | `out` | `Out for signing` |
| last of `replaced`/`reinstated` is `replaced` | `replaced` | `Replaced by v{data.byVersion} on {longDate}` |
| `seller_cancelled` | `seller_cancelled` | `Cancelled by seller` |
| a signer has `startMarketingNow === false` and today ≤ cooling-off end | `cooling` | `Cooling off until {longDate(end)}` |
| all ticked, within 14 days | `signed` | `Signed – marketing may start` |
| otherwise | `signed` | `Signed` |

  - `tabOf`: `draft` → drafts, `out` → out, `cooling` → cooling, `signed` → signed, everything else → ended.
  - `daysWaiting` is set only while `out`.
- `lib/templates.js`:
  - `TERMS_OF_SALE` (below), `getTemplate(id)`
  - `enabledBases(t)`: a basis is enabled when `enabled` is true **and** it is `sole` or has `text`
  - `CANCEL_NOTICE`, `MARKETING_REQUEST`, `MODEL_FORM_LINES` (exact copy below)
- `lib/validate.js`:
  - `validateDraft(input, template) → { value, errors }`. `errors` is keyed by `signers.0.email`, `feePercent` and so on. `value.signers[i].sharedEmail` is set when emails match case-insensitively. Address newlines become `, `.
  - `parsePngDataUrl(s) → Uint8Array`: requires the `data:image/png;base64,` prefix and the PNG magic bytes, at most 150,000 bytes decoded. Otherwise `HttpError(400, 'Please sign again.')`.
- `lib/router.js`: `createApp(deps) → { handle, close }`. In this task: `GET /api/health`, static files, and the SPA fallback (`/`, `/contracts…`, `/settings`, `/profile` → `index.html`; `/s/:token` → `sign.html`).
- Test helpers:
  - `boot(deps) → { base, call(method, path, body?, headers?), close }`, the same shape as Key Tracker's `test/server.test.js`;
  - `fakeClock(iso)` returns a function that returns a `Date`, with `.set(iso)` and `.advanceDays(n)`.

```js
export const TERMS_OF_SALE = {
  id: 'terms-of-sale', name: 'Terms of Sale',
  fields: { client: 'Client', propertyAddress: 'Property Address', mobile: 'Mobile Telephone', email: 'Email Address',
    feePercent: 'Text Field 3', guidePrice: 'Text Field 1', sellerInitials: 'Initials 1', sellerSignature: 'For the Vendor',
    sellerName: 'Name', sellerDate: 'Date', senderSignature: 'For Berkeleys', senderName: 'Name 1', senderDate: 'Date 1' },
  dropFields: ['Text Field 2', 'ES_CERTIFYING_SIGNATURE'],
  bases: { sole: { label: 'Sole', text: null, enabled: true },
           jointSole: { label: 'Joint sole', text: null, enabled: false, needsOtherAgent: true },
           multiple: { label: 'Multiple', text: null, enabled: false } },
  basisRect: { page: 0, x: 88, y: 514, width: 456, height: 30 },
  headerBox: { left: 50, bottom: 730, right: 190, top: 790 },
  footerBox: { left: 0, bottom: 0, right: 596, top: 66 },
};
export const CANCEL_NOTICE = [
  'Your right to cancel',
  'You have the right to cancel this contract within 14 days without giving any reason. The cancellation period will expire 14 days after the day this contract was agreed.',
  'To cancel, tell us of your decision by a clear statement (for example, a letter sent by post or an email) to Berkeleys Drummond, 1 Haven Road, Canford Cliffs, Poole, BH13 7LE, hello@berkeleysdrummond.com, 01202 708383. You may use the model cancellation form below, but you do not have to.',
  'To meet the cancellation deadline, it is enough for you to send your message before the cancellation period has expired.',
  'If you cancel, we will stop marketing your property. If you asked us to start marketing during the cancellation period, you will pay an amount in proportion to the service provided until you told us you were cancelling, compared with the full coverage of the contract.',
];
export const MARKETING_REQUEST = 'asks Berkeleys Drummond to start marketing the property now, during the 14-day cancellation period.';
export const MODEL_FORM_LINES = [
  'Model cancellation form', '(Complete and return this form only if you wish to cancel the contract.)',
  'To: Berkeleys Drummond, 1 Haven Road, Canford Cliffs, Poole, BH13 7LE. hello@berkeleysdrummond.com',
  'I/We hereby give notice that I/We cancel my/our contract for the supply of the following service: estate agency services for the sale of {propertyAddress}',
  'Agreed on: ______________________', 'Name(s) of consumer(s): ______________________',
  'Address of consumer(s): ______________________',
  'Signature of consumer(s) (only if this form is sent on paper): ______________________', 'Date: ______________________',
];
```

- [ ] **Step 1:** `git init -b main`.
  - `package.json`: `type: module`, engines `>=22`, scripts `start: node server.js` and `test: node --test`, the one dependency.
  - `.gitignore`: `node_modules/ data/ seed/ .env* .vercel/ .DS_Store`.
  - Run `npm install`.
- [ ] **Step 2: Write the failing tests** in `test/foundations.test.js`:
  - `/api/health` → `{ok:true}`; `/`, `/contracts/x` and `/profile` serve HTML; `/%2e%2e/package.json` → 404;
  - `readJson` → 400 on `{bad` and 413 over the limit; `clientMeta` takes the first forwarded IP and trims the user agent to 300;
  - `newToken` hash = `hashToken(token)`, and two tokens differ;
  - `coolingOffEnds('2026-10-20T23:30:00Z') === '2026-11-04'`; `longDate('2026-12-07') === '7 December 2026'`;
  - `deriveState` gives each table row its state and label (one assertion each), including a cancelled **draft** → `cancelled`, and `reinstated` after `replaced` → `signed`;
  - `enabledBases(TERMS_OF_SALE)` → `['sole']`;
  - `validateDraft` with every field wrong → errors on exactly `feePercent, guidePrice, propertyAddress, signers.0.email, signers.0.mobile, signers.0.name`; 7 sellers → `errors.signers === 'Up to 6 sellers.'`; a shared email sets `sharedEmail` on both;
  - `parsePngDataUrl('data:image/png;base64,AAAA')` → 400.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL.
- [ ] **Step 4:** Implement. `server.js` starts on `PORT || 8479`; its deps are filled in later tasks.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `"Foundations: server skeleton, dates, status rules, template, validation"`. Include `docs/`.

---

### Task 2: Storage and email adapters

**Files:**
- Create: `lib/store-memory.js`, `lib/store-supabase.js`, `lib/store-errors.js`, `SETUP-SUPABASE.sql`, `lib/blobs.js`, `lib/mailer.js`, `lib/emails.js`, `test/adapters.test.js`

**Produces:**
- `ConflictError` (409).
- `createMemoryStore()` and `createSupabaseStore({ url, key, fetchImpl })` share one interface:
  - `commit({ contracts = [], signers = [], events = [], tokens = [] })`. All or nothing. A new contract has `rev: 1`; an existing one must arrive as stored `rev + 1`, else `ConflictError` with nothing saved. Signers are upserted, tokens and events inserted; the store assigns event `id`.
  - `getContract(id) → { contract, signers, events } | null`: signers by position, events by id.
  - `getFamily(familyId) → Contract[]`, sorted by version.
  - `findByTokenHash(hash) → { contract, signers, events, signer } | null`
  - `listContracts({ states, limit = 500 }) → [{ contract, signers }]`: newest first.
  - `countByState() → { [state]: n }`
  - `listWithEvents(states) → [{ contract, signers, events }]`
  - `addTemplateVersion(tv)`, `activateTemplateVersion(id, at)`, `getTemplateVersion(id)`, `listTemplateVersions(tid)`, `currentTemplateVersion(tid)` (the newest activated one)
  - `getSettings() → { officeCopyEmail }`, `saveSettings(patch)`, `getSignature(userId)`, `saveSignature(userId, png)`
- `SETUP-SUPABASE.sql`:
  - tables `bo_contracts` (jsonb `fields`/`sender`/`created_by`, int `rev`, indexes on `state` and `family_id`), `bo_signers`, `bo_signer_tokens` (`hash` pk), `bo_events` (bigserial), `bo_template_versions`, `bo_settings`, `bo_user_signatures`;
  - RLS on with no policies; revoke from `anon`/`authenticated`;
  - an append-only trigger on `bo_events` (Key Tracker's pattern, new function name `bo_reject_event_mutation`);
  - RPC `bo_commit(p_contracts, p_signers, p_events, p_tokens jsonb)`: insert when `rev = 1`, else update `where rev = new_rev − 1`; if nothing changed, `raise exception 'bo_conflict'`. The store maps that to `ConflictError`;
  - RPC `bo_state_counts()`;
  - `insert into storage.buckets (id, name, public) values ('contracts','contracts',false) on conflict do nothing`.
- Blob storage: `createMemoryBlobs()` and `createSupabaseBlobs({ url, key, bucket = 'contracts', fetchImpl })` → `{ put(path, bytes, type = 'application/pdf'), get(path) → bytes|null, del(path) }`.
  - Supabase calls: `POST /storage/v1/object/{bucket}/{path}` with `x-upsert: true`; `GET` the same; `DELETE /storage/v1/object/{bucket}` with `{ prefixes: [path] }`.
- Mailers: `createMemoryMailer()` (with `.sent` and `.failNext(n)`), `createConsoleMailer()` (prints the subject, recipients and any `/s/` link), `createResendMailer({ apiKey, from, fetchImpl })` (`POST https://api.resend.com/emails`, attachments as base64, throws on non-2xx). All implement `send({ to: [], subject, text, html, attachments? })`.
- `lib/emails.js`: each function returns `{ subject, text, html }`, with every value HTML-escaped. The body is short and plain, signed "Berkeleys Drummond, 01202 708383", and shows the link both as a button and as text. Subjects:

| Function | Subject |
|---|---|
| `signingRequestEmail({ signerName, propertyAddress, senderName, link, kind })` | `Please sign: Terms of Sale for {address}`; for `fee_change`: `Please sign: updated fee for {address}` |
| `reminderEmail(same)` | `Reminder: please sign the Terms of Sale for {address}` |
| `signedCopyEmail({ propertyAddress, ref })` | `Signed: Terms of Sale for {address}` |
| `cancelledEmail({ signerName, propertyAddress })` | `Cancelled: Terms of Sale for {address}` |
| `expiredNoticeEmail({ propertyAddress })` | `Expired unsigned: {address}` |

- [ ] **Step 1: Write the failing tests:**
  - one store suite runs against the memory store and against the Supabase store with a fake `fetchImpl`. For Supabase, assert `POST /rest/v1/rpc/bo_commit`. Cover: commit and read back sorted; a stale `rev` → `ConflictError` with nothing saved; two tokens for one signer both resolve; unactivated template versions are ignored; `countByState`;
  - the SQL file has no `drop table`, no `alter table` and no `insert into` on `key_` tables, only `bo_` tables are created, and every one has RLS enabled;
  - the Resend body shape and auth header; the Supabase blob URLs;
  - `signingRequestEmail` escapes `<script>` and contains the link;
  - the fee-change subject.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `"Stores, Supabase SQL, blob storage, mailers, email copy"`.

---

### Task 3: PDFs — prepare the master, the presented copy, the signed copy

**Files:**
- Create: `lib/pdf/{master.js,text.js,layout.js,compose.js}`, `lib/evidence.js`, `scripts/prepare-master.mjs`
- Create: `test/helpers/{fixture-master.js,pdf.js}`, `test/pdf.test.js`

**Produces:**
- `prepareMaster(bytes, template) → { bytes, sha256, pageCount, fieldRects: { [name]: { page, x, y, width, height } } }`. It throws `MasterError` with a readable message. Steps:
  1. Load with `{ password: '' }`. On failure: `This PDF needs a password to open. Export it again as a normal PDF.`
  2. Require every field in `template.fields`. If any are missing: `The PDF is missing these boxes: …`.
  3. Record the field rects.
  4. Remove `dropFields`.
  5. Delete leftover encryption objects: any `PDFInvalidObject`, or a dict whose `/Filter` is `/Standard`.
  6. Merge duplicate images: hash the raw contents + `Width`/`Height` + the already-merged `SMask`, merging images without an SMask first. Point references at the first copy and delete the rest.
  7. Save with `useObjectStreams`. **Don't flatten.**
  
  `scripts/prepare-master.mjs in out` prints the size before and after, the sha256 and the field names.
- `lib/pdf/text.js`:
  - `safeText(font, s)`: the NFKD base letter, else `?`; explicit `Ł→L ł→l Đ→D đ→d`; curly quotes become straight.
  - `fitText(font, s, width, { max = 10, min = 5 }) → { text, size }`: shrinks, then cuts with `…`.
  - `formatFee(1.5) = '1.5%'`, `formatPrice(1250000) = '£1,250,000'`, `joinNames(['A','B','C']) = 'A, B and C'`.
- `lib/pdf/layout.js`: `extraPagesLayout(n) → { additionalPageCount, blocks: [{ signerIndex, pageIndex, signature, initials, name, date }], cancelPageIndex, ticks: [{ signerIndex, x, y, size: 12 }] }`.
  - Signer 0 signs on page 1.
  - Additional pages hold 4 blocks each, with block top `650 − i·140`:
    - signature `{72, top−70, 220, 44}`
    - initials `{320, top−70, 80, 44}`
    - name `{72, top−92, 220, 14}`
    - date `{320, top−92, 180, 14}`
  - The cancel page follows, with tick `i` at `{72, 430 − 22i}`.
- `buildPresented({ masterBytes, fieldRects, template, signers, contract, sender: { name, signaturePng }, sentAt }) → bytes`:
  1. Fill page 1. Each value goes through `safeText` + `fitText` against its field width:
     - Client = `joinNames`;
     - address;
     - the lead's mobile and email;
     - fee;
     - guide price;
     - `Name 1` = the sender;
     - `Date 1` = `longDate(sentAt)`.
  2. Remove the seller boxes and `For Berkeleys`. Draw the sender's PNG inside the `For Berkeleys` rect, scaled to fit.
  3. If the basis has `text`, draw a white box over `basisRect` and wrapped `• {text}` (10.5pt).
  4. Flatten.
  5. After page 1, insert the additional-signatory pages (only if there's more than one seller) and the cancel page. Both get the header and footer from page 1 via `embedPage(page, box)`.
     - Additional-signatory pages: "Additional signatories", then `Seller {n}: {name}` blocks.
     - The cancel page has three parts:
       - `CANCEL_NOTICE` from y 690, at width 451 and 9.5pt;
       - a "Starting marketing now" heading at y 452, then an empty box plus `{name} {MARKETING_REQUEST}` per signer;
       - `MODEL_FORM_LINES` from y 290, with the address filled in.
- `buildSample({ masterBytes, fieldRects, template })`: the same with made-up data and no signature.
- `evidenceFrom({ contract, signers, events, templateVersion }) → { ref (first 8 of id, uppercase), propertyAddress, templateVersion: { version, sha256 }, presentedSha256, sender: { name, email, sentAt }, signers: [{ name, email, sharedEmail, sentAt, opens (first 5) + moreOpens, consentedAt, signedAt, ip, userAgent, startMarketingNow }] }`.
- `buildFinal({ presentedBytes, fieldRects, signers, evidence }) → bytes`. It draws:
  - the lead's signature, initials, name and date in the page 1 rects;
  - the others in their blocks;
  - a two-stroke tick in each box where `startMarketingNow` is true, and "No" beside each box where it's false.
  
  Then it appends "Signing record" page(s) with the header and footer, 9pt at width 451, starting a new page when y < 90. The record lists:
  - Ref and Property;
  - Template version and its fingerprint;
  - "Fingerprint of the document as presented for signing: …";
  - "Sent by …";
  - per signer: name, email (+ "shared with another seller"), link sent, each open (time · IP · device), agreed to sign electronically, signed (time · IP · device), and the marketing choice;
  - closing: "Times are UK time. A fingerprint of this complete file is kept in Berkeleys Drummond's signing log."
- Test helpers:
  - `makeFixtureMaster({ encrypted = true, userPassword = '', omit = [] })` builds 3 A4 pages. Page 1 has every template field plus `Text Field 2`, at the rects measured from the real master: `Client 164,638,380,17 · Property Address 165,615,378,17 · Mobile Telephone 164,593,379,17 · Email Address 164,571,379,17 · Text Field 3 92,459,24,17 · Text Field 2 92,355,100,19 · Text Field 1 262,333,61,16 · Initials 1 196,310,49,18 · For the Vendor 121,169,156,21 · For Berkeleys 407,171,151,20 · Name 89,139,189,18 · Name 1 378,140,180,17 · Date 89,115,188,19 · Date 1 379,117,179,16`. One small PNG is embedded separately on each page. It's encrypted via `doc.encrypt({ userPassword, ownerPassword: 'owner' })`.
  - `test/helpers/pdf.js`: `countImageObjects(doc)`, and `pageText(bytes, i)`, which inflates the page's content streams and the form XObjects they draw (one level), then decodes `<hex> Tj` and `(lit) Tj`.

- [ ] **Step 1: Write the failing tests** in `test/pdf.test.js`:
  - Prepared fixture:
    - no `/Encrypt` or `/Standard` in the bytes; it loads without a password;
    - `Text Field 2` is gone;
    - `countImageObjects === 1`;
    - `fieldRects['Text Field 3']` equals `{page:0,x:92,y:459,width:24,height:17}`;
    - `sha256` matches.
  - A missing `Mobile Telephone` → rejects naming it; `userPassword: 'secret'` → rejects with /password/.
  - Presented, 2 sellers:
    - no form fields remain;
    - page count is 3 + 1 + 1;
    - page 0 text contains `Anna Example and Ben Example`, `1.5%`, `£1,250,000`.
    
    With 1 seller, the page count is 3 + 1.
  - `buildPresented` with the name `Zoë Łukasz-Nowak 😀` resolves; `safeText(helvetica, 'Zoë Łukasz') === 'Zoë Lukasz'`.
  - `fitText(helvetica, '12.25%', 24)` fits within 24 at ≥ 5pt; a 200-character string at 378 ends with `…`.
  - A basis override with `text` draws that text on page 0.
  - `extraPagesLayout(6)`: 2 additional pages, cancel page index 3, every tick y > 290.
  - Final, 2 sellers:
    - page count 6;
    - the last page contains `Signing record` and the presented sha256;
    - at least 3 images.
    
    6 signers with 10 opens each → the evidence runs to 2 pages, with 5 opens listed per signer.
  - `test/real-master.test.js`: if `seed/terms-of-sale-master.pdf` exists, it prepares to under 700,000 bytes with 10 pages; otherwise skip.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. With the real master in `seed/`, write a sample and a 2-seller final to `/tmp` and `open` them. Check by eye:
  - values sit on their lines;
  - logo and footer appear on the added pages;
  - signatures sit in their boxes;
  - nothing overlaps.
- [ ] **Step 5: Commit** `"PDFs: master preparation, presented and signed copies, evidence page"`.

---

### Task 4: Contract rules

**Files:**
- Create: `lib/contracts.js`, `lib/template-admin.js`, `test/helpers/deps.js`, `test/contracts.test.js`

**Produces:**
- `createContracts({ store, blobs, mailer, clock, baseUrl, template })`. Every commit sets `state = deriveState(...).state` and `rev + 1`. Methods:
  - `createDraft(user, input) → { id }`: `createdBy` = user; 400 `{ errors }` if invalid.
  - `updateDraft(user, id, input)`: drafts only. On a fee-change draft only `feePercent`/`note` may change, else 400 `Only the fee can change on a fee change.`
  - `previewPdf(id)`: a draft is built on the fly; a sent contract returns the presented PDF; a completed one returns the final.
  - `send(user, id)`:
    - needs a saved signature (409 `Add your signature in Profile before sending.`) and an active template (409 `Upload the Terms of Sale master in Settings first.`);
    - builds and stores `contracts/{id}/presented.pdf`;
    - commits a `sent` event `{ presentedSha256, templateVersionId }` with one new token per signer;
    - **then** emails each signer a `signingRequestEmail` linking to `${baseUrl}/s/${token}`;
    - if an email fails: commit `email_failed { signerId, message }` and throw 502 `Saved, but an email could not be sent. Use Chase to try again.`
  - `openLink(token, meta) → { signer: { name, status, initials }, contract: { ref, propertyAddress, kind, version, senderName }, state, message, canSign, otherSigners: [{ name, signed }], sharedEmail, documentAvailable }`:
    - records `opened` at most once per signer per 10 minutes;
    - an unknown token → 404 `This link is not valid.`
  - `documentForLink(token)`: presented while out; final until 30 days after completion; then 410 `The signed copy was emailed to you. Please contact the office for another copy.`
  - `sign(token, { consent, confirmIdentity, startMarketingNow, signaturePng, initials }, meta) → { allSigned }`:
    - requires consent, a boolean `startMarketingNow`, a valid PNG, and initials of 1–6 characters; `confirmIdentity` is required only when `sharedEmail`;
    - the contract must be `out` and the signer `pending`, else 409 with the `openLink` message;
    - commits `consented` + `signed`;
    - **if this is the last pending signer, in the same commit:**
      - build the final, store `final.pdf`, and record `completed { finalSha256, presentedSha256 }`;
      - set `presentedPath: null`;
      - for a fee change, add `replaced { byVersion, byId }` on the predecessor;
    - after the commit: delete `presented.pdf`, then email `signedCopyEmail` with the PDF attached to all signers, the sender, and `officeCopyEmail` if set;
    - on `ConflictError`, re-read and retry once from the start. A second conflict → 409 `Someone else updated this contract at the same moment. Please try again.`
  - `chase(user, id)`: `out` only; a `chased` event within the last hour → 429 `Chased less than an hour ago.`; a new token and `reminderEmail` per pending signer; email failure as in `send`.
  - `cancel(user, id, reason)`: `draft` or `out`, reason 1–500 characters; commits `cancelled`; emails pending signers `cancelledEmail` (not for drafts).
  - `startFeeChange(user, id, { feePercent, note }) → { id }`:
    - the source must be `signed` or `cooling`, and no family member may be `draft`/`out` (409 `A fee change is already in progress (v{n}).`);
    - creates a draft with `kind: 'fee_change'`, `version: max + 1`, the same family, `replacesId`, a copy of the fields and signers (new ids), and the new fee.
  - `recordSellerCancel(user, id, { date, note })`: completed, and `londonDate(completedAt) ≤ date ≤ coolingOffEnds`, else 409 `Outside the 14-day cancellation period.`; commits `seller_cancelled`; for a fee change, also `reinstated` on the predecessor.
  - `runDaily() → { reminded, expired, refreshed }`. For contracts that are `out`:
    - from 30 days after `sentAt`: commit `expired` and email `expiredNoticeEmail` to the sender;
    - otherwise, for day 3 and day 7, each pending signer without `reminded {day}` gets a new token + `reminderEmail` + `reminded {day}`.
    
    For `cooling` contracts that are now `signed`, re-commit the state. One contract failing is logged and skipped.
  - `detail(id) → { contract, signers (no signaturePng), events (+ signerName), state, label, coolingOffUntil, family: [{ id, version, kind, state, label }], can: { edit, send, chase, cancel, feeChange, sellerCancel } }`. Tokens are never returned.
  - `list({ tab, mine, q, user }) → { counts, rows: [{ id, ref, version, kind, propertyAddress, clientNames, senderName, sentAt, state, label, signedCount, signerCount, daysWaiting }] }`. `q` matches the address or signer names case-insensitively; `mine` means `(sender ?? createdBy).id === user.id`.
- `createTemplateAdmin({ store, blobs, clock, template })`:
  - `upload(user, bytes) → { versionId, version, fieldNames }` (a `MasterError` becomes 400);
  - `samplePdf(id)`;
  - `activate(user, id)`;
  - `list()`.
- `test/helpers/deps.js`: `makeDeps({ now })` → memory store, blobs and mailer, a fake clock, `contracts`, `templateAdmin`, a `user`, and `seedTemplate()`. `seedTemplate()` uploads and activates the fixture master and saves the user's signature.

- [ ] **Step 1: Write the failing tests** in `test/contracts.test.js`:
  - **send:** state `out`, the sha stored, 2 emails with different links, and each link resolves to its signer; no signature → 409; no template → 409; `mailer.failNext(1)` → 502, state still `out`, and `email_failed` recorded.
  - **two sellers sign:** state `cooling` (one didn't tick), one `completed` event, `presented.pdf` gone and `final.pdf` there, and the last email is `Signed:` with a PDF attached.
  - **simultaneous last signatures** (`Promise.all`): both fulfil, one `completed`, one `Signed:` email. A cancel that lands first → the seller gets 409 with the cancelled message.
  - shared email without `confirmIdentity` → 400; signing twice → 409 with the already-signed message.
  - **chase:** the new and old links both work; a second chase within the hour → 429.
  - **cancel:** needs a reason, emails pending sellers, and signing is blocked afterwards.
  - **fee change:** v2 has the new fee and the family is `[1,2]`; a second fee change → 409 `in progress (v2)`; editing the address on v2 → 400; v2 completed → v1 `replaced`; v2 seller-cancelled within 14 days → v1 `signed` again; outside 14 days → 409.
  - **daily:** day 2 nothing; day 3 one reminder per pending signer, and running twice on day 3 still gives one; day 7 the second; day 30 expired, the sender notified, every link showing the expired message; a cooling contract on day 15 → `signed`; one mailer failure doesn't stop the others.
  - `list` counts and `q` search; `detail` hides `signaturePng`.
  - **template admin:** upload the fixture → `samplePdf` → activate → current. An encrypted fixture with a password → 400 with the `MasterError` message.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `"Contract rules: send, sign, chase, cancel, fee change, daily job, templates"`.

---

### Task 5: Web API, sign-in and hosting

**Files:**
- Create: `lib/auth.js`, `lib/auth-local.js`, `lib/rate-limit.js`, `api/index.js`, `vercel.json`, `scripts/check-supabase.mjs`
- Create: `test/api.test.js`
- Modify: `lib/router.js`, `server.js`

**Produces:**
- `createAuth({ url, serviceKey, fetchImpl }) → { login(email, pw) → { user, cookies }, current(req, res) → user|null, cookieHeaders }`, with `user = { id, email, fullName }`.
  - Port it from `keys-main/lib/auth.js`: cookies `bo_session`/`bo_refresh`; **no** bootstrap admin, invites or user editing.
  - It needs an active `key_users` row: no row → 403 `Your account is not set up. Ask Lewis.`; inactive → 403 `This account is disabled.`
  - It logs `office.login.success`/`office.login.failed` to `key_security_log`.
- `createLocalAuth(users)` has the same interface, with in-memory sessions.
- `createRateLimiter({ limit, windowMs }) → key => boolean`
- `createApp({ contracts, templateAdmin, store, auth, publicDir, cronSecret, links: { keys, windowCards } })`:
  - an `HttpError` becomes `{ error, ...extra }` with its status; anything else becomes a logged 500 `Something went wrong.`
  - Staff routes need sign-in (401 `Sign in required`):

| Route | Does |
|---|---|
| `POST /api/auth/login` (10/min per IP) · `POST /api/auth/logout` · `GET /api/auth/me` | sign-in |
| `GET /api/hub` | `{ user, links }` |
| `GET /api/contracts?tab&mine&q` · `POST /api/contracts` · `PUT/GET /api/contracts/:id` | list / create / update / detail |
| `GET /api/contracts/:id/document.pdf` | `previewPdf`; `content-disposition: inline` with an ASCII-safe filename plus `filename*=UTF-8''…` |
| `POST /api/contracts/:id/{send,chase,cancel,fee-change,seller-cancelled}` | the matching method |
| `GET/PUT /api/me/signature` | `parsePngDataUrl`, then save |
| `GET/PUT /api/settings` | `{ officeCopyEmail }`, validated or empty |
| `GET /api/templates` · `POST /api/templates/terms-of-sale` (raw PDF, ≤ 4 MB) · `GET /api/templates/versions/:id/sample.pdf` · `POST …/:id/activate` | template admin |

  - Public routes. Each gets `referrer-policy: no-referrer`, `x-robots-tag: noindex, nofollow` and `no-store`, and is limited to 30 requests/min per IP (429 `Too many requests. Please wait a minute.`):
    - `GET /api/sign/:token`
    - `GET /api/sign/:token/document.pdf`
    - `POST /api/sign/:token`
  - `GET /api/cron/daily` needs `authorization: Bearer {cronSecret}` (else 401) and returns `runDaily()`.
- `server.js`: memory adapters, the console mailer, `createLocalAuth` with one user from `DEV_EMAIL`/`DEV_PASSWORD` (it refuses to start without them), `baseUrl http://localhost:8479`, and `cronSecret = CRON_SECRET || 'dev'`. If `seed/terms-of-sale-master.pdf` exists, it uploads and activates it at start.
- `api/index.js`:
  - needs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RESEND_API_KEY`, `MAIL_FROM`, `PUBLIC_URL` and `CRON_SECRET`. `KEYS_URL` and `WINDOW_CARDS_URL` default to `https://keys-xi-five.vercel.app` and `https://window-cards.vercel.app`;
  - a missing variable → 500 `Berkeleys Office is not set up yet: missing X` (Key Tracker's pattern).
- `vercel.json`:

```json
{
  "outputDirectory": "public",
  "functions": { "api/index.js": { "maxDuration": 30 } },
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index.js" },
    { "source": "/s/:token", "destination": "/sign.html" },
    { "source": "/(contracts|contracts/.*|settings|profile)", "destination": "/index.html" }
  ],
  "crons": [{ "path": "/api/cron/daily", "schedule": "0 8 * * *" }]
}
```
- `scripts/check-supabase.mjs`: reads `key_users` and prints the active count, **exiting 1** if the table is missing or empty. It also reports which `bo_` tables and the `contracts` bucket are missing.

- [ ] **Step 1: Write the failing tests** in `test/api.test.js`:
  - signed out → 401; a wrong password → 401; the 11th login attempt in a minute → 429; a cross-origin POST → 403;
  - over HTTP: draft → send → open link → sign → the staff detail shows signed;
  - public routes carry the three headers; an unknown token → 404;
  - the stale-link matrix (cancelled, expired, replaced, already signed, 31 days after completion): `canSign` false with the right message, and the document → 410 after 31 days;
  - the cron route with no or a wrong secret → 401, and with the right one → counts; the 31st public request in a minute → 429;
  - template upload → sample → activate over HTTP;
  - `createAuth` with a fake fetch: no `key_users` row → 403 `not set up`; inactive → 403; the cookie names are right;
  - `api/index.js` with no env → 500 `missing SUPABASE_URL`;
  - `vercel.json` has the cron path and the `/s/:token` rewrite.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: the full suite passes.
- [ ] **Step 5: Commit** `"Web API, sign-in, signing links, cron, Vercel entry"`.

---

### Task 6: Screens and the setup guide

**Files:**
- Create: `public/{index.html,styles.css,api.js,app.js,contracts.js,settings.js,signature-pad.js,sign.html,sign.js}`
- Create: `public/fonts/{Caveat-Regular.woff2,OFL.txt}`, plus the assets copied from Key Tracker
- Create: `SETUP.md`, `test/static.test.js`

**Produces:**
- `public/api.js`: `api(method, path, body?)`. It throws with `.status` and `.errors`; a 401 goes to sign-in.
- `public/signature-pad.js`:
  - `createSignaturePad(canvas) → { clear(), isEmpty(), toPng() }` (pointer events, transparent, trimmed to the ink with 8px padding);
  - `typedSignaturePng(name, font = '48px Caveat')`.
  
  Caveat is from Google Fonts `ofl/caveat`; ship `OFL.txt` with it.
- **Hub screens** (routed by pathname with `pushState`):
  - **Sign-in:** logo, "Berkeleys Office", the server's error message.
  - **Home:** three tiles: Contracts (with its Out-for-signing count), Keys and Window Cards (each opens its link in a new tab). The header shows the user's name, Profile, Settings and Sign out.
  - **Tracker** (`/contracts`):
    - tabs Out for signing / Cooling off / Signed / Ended / Drafts, with counts;
    - a Mine | Everyone toggle and search (300 ms debounce);
    - "New Terms of Sale";
    - rows: address, clients, `New`/`Fee change v{n}`, sent by, days waiting, label, `n of m signed`. They stack as cards on phones;
    - an empty state per tab; polls every 30 s while the page is visible.
  - **New / draft** (spec §3):
    - up to 6 sellers, added and removed;
    - basis from `enabledBases`, shown as text when there's only one, with "Other agent" for Joint sole;
    - fee with a `%` suffix, and guide price with `£` and live thousands separators;
    - errors shown beside their fields;
    - the shared-email warning "Two sellers share this email. Each will still get their own link.";
    - buttons: Save draft, Preview PDF (new tab), Send for signing (confirms "Send to {names}?").
    
    If the user has no saved signature, the page links to Profile.
  - **Contract page:**
    - label, a version chain (v1 → v2), each seller's status;
    - a timeline (time, what happened, who, and the IP for seller events);
    - buttons by `can`: Chase, Cancel (asks for a reason), Change fee (asks for the fee and a note, then opens the fee-change draft), Record seller cancellation (date + note), Download PDF.
  - **Profile:** draw or type a signature, preview, Save.
  - **Settings:**
    - Terms of Sale master: the current version and who uploaded it; "Upload new master" → the detected boxes + "View sample" → "Make this the live version"; version history; server errors shown as they come;
    - office copy email.
- **Seller page** (`/s/:token`): logo only, `noindex` and `no-referrer` meta tags, phone first. In order:
  1. "Hello {name}", who sent it and for which property, "Read the document (PDF)", and the other sellers' status.
  2. "I am {name}" (only when the email is shared).
  3. "I have read the Letter and the Terms and Conditions of Business, and I agree to sign them electronically."
  4. "Starting marketing now": a box with `I {MARKETING_REQUEST}`, plus "If you don't tick this, we'll wait until the 14-day cancellation period ends before marketing."
  5. Draw / Type signature, Clear, and initials pre-filled from the name.
  6. **Sign**, disabled until ready, then a thank-you screen.
  
  When `canSign` is false, show only the message (plus Download if `documentAvailable`).
- `SETUP.md`, plain steps for Lewis:
  1. Run `node scripts/check-supabase.mjs` against Key Tracker's project, and stop if it fails.
  2. Run `SETUP-SUPABASE.sql`.
  3. In Auth → URL configuration, **add** the new URL to the redirect URLs. Don't change the Site URL.
  4. Set up Resend: add and verify `berkeleysdrummond.com`. Until then, `MAIL_FROM` can only send to Lewis.
  5. Create the Vercel project from the GitHub upload and set each environment variable (with where to find it).
  6. Deploy, sign in, upload the master in Settings, set the office copy email, and save a signature.
  7. Send yourself a test contract and sign it on your phone.
  8. Later: a `berkeleysdrummond.com` subdomain, then update `PUBLIC_URL`.
  
  It also covers where to see storage use in Supabase (Project → Usage) and how to export the `bo_` tables. It includes the client's to-do list from the spec and the note about Vercel's free-plan terms.

- [ ] **Step 1: Write the failing test**, `test/static.test.js`: `/`, `/contracts`, `/app.js`, `/styles.css`, `/sign.html` and `/s/abc` return 200 with the right content types.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Build the screens and `SETUP.md`.
- [ ] **Step 4:** Run `npm test` (expected: PASS). Then run `DEV_EMAIL=dev@example.com DEV_PASSWORD=dev-password-123 npm start` with the real master in `seed/`, and check in a browser at 375px and on desktop:
  - sign in;
  - save a signature;
  - a draft with errors shows its messages; fix them, Preview, then Send;
  - the console prints two `/s/` links;
  - sign both (one draws, one types; one ticks marketing) → the tracker shows Cooling off; the console shows the `Signed:` email;
  - the final PDF has both signatures, the tick/"No" and the evidence page;
  - reopening a link shows the signed message;
  - Chase twice → "Chased less than an hour ago.";
  - a fee change → v2 draft → send → the version chain shows;
  - Settings: upload the master again → sample → make live;
  - no sideways scrolling anywhere.
- [ ] **Step 5:** Make `~/Downloads/02 Clients/Berkeleys Drummond/Berkeleys Office - GitHub upload/` by copying the repo without `node_modules`, `data`, `seed`, `.git` and `.env*`. Then check nothing personal got in:

  ```bash
  find "Berkeleys Office - GitHub upload" \( -name data -o -name seed -o -name node_modules -o -name '*.pdf' -o -name '.env*' \)
  ```

  Expected: no output.
- [ ] **Step 6: Commit** `"Screens: hub, tracker, contract forms, settings, seller signing page; setup guide"`.

---

## Self-review

- **Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Hub §1 | 5, 6 |
| Boxes, basis, joint sellers, cancel page §2 | 1, 3 |
| Sending §3 | 4, 6 |
| Signing §4 | 4, 5, 6 |
| Record §5 | 3, 4 |
| Tracker §6 | 4, 6 |
| Fee change §7 | 4, 6 |
| Templates §8 | 4, 5, 6 |
| Email §9 | 2, 6 |
| Data and security §10 | 2, 5 |
| Free-plan limits | 4 (daily job), 6 (SETUP) |
| Locked master | 3 |

  The postponed items (Decline, backup download, storage meter) appear nowhere.
- **Names checked across tasks:** `deriveState`, `tabOf`, `EV`, `prepareMaster`, `buildPresented`, `buildFinal`, `evidenceFrom`, `extraPagesLayout`, every store method, `createContracts` methods, `createTemplateAdmin`.
- **Left to the implementer:**
  - email body copy;
  - visual details within Key Tracker's tokens;
  - signature smoothing;
  - `pageText` internals.
