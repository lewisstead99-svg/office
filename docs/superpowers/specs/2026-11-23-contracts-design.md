# Contracts, and the office hub around it — design

Date: 23 November 2026. Client: Berkeleys Drummond, 1 Haven Road, Canford Cliffs, Poole (sales and lettings office; this tool is sales only). Owner: Lewis (Fabricatr).

Items marked *(Lewis's call)* came from Lewis in conversation. Items marked *(my call)* are proposals Lewis accepted wholesale ("go with all your suggestions"); they are the first things to revisit if something feels wrong.

## Intent

When a seller instructs Berkeleys Drummond, the office sends them the firm's Terms of Sale (a 10-page PDF: a one-page "Letter" with blanks, then nine pages of fixed terms) to sign. Today the team do this in Adobe Sign: open the library template, type the client's email, fill in the blanks, send; the client signs; Adobe logs it and returns a copy.

The team are struggling with it for two reasons *(Lewis's words)*: **too many steps in Adobe**, and **nobody can see what's unsigned**.

Lewis wants to replace Adobe Sign with the firm's own tool, and to make it the first part of **one umbrella for all their software** — one sign-in and one front door for Window Cards, Key Tracker and Contracts. *(Lewis's call)*

## Goals

1. Sending a Terms of Sale takes one short form and one click, from a screen that only asks for what changes per property.
2. Everyone in the office can see, at a glance, every contract that is out and unsigned, how long it has waited, and chase or cancel it.
3. Sellers sign on their phone or computer from an emailed link, with no account and nothing to install.
4. Each signed contract produces a tamper-evident PDF and evidence record the firm could rely on if a seller ever disputes the fee.
5. When the fee changes, the seller re-signs a new version in two clicks, and the history shows which version was in force when. *(Lewis's call: fee change is what triggers a re-sign)*
6. The hub's sign-in becomes the single sign-in that Keys and Window Cards later move under.

## Non-goals (this round)

- Lettings, tenancy agreements, or any document other than the sales Terms of Sale. The system should allow more templates later, but only this one ships.
- Editing the legal wording per contract. Negotiators fill blanks only; wording changes come from a new master PDF. *(Lewis's call: "all the obvious blank spaces need boxes to fill")*
- Moving Key Tracker or Window Cards into the hub. That is the next project; this round only links to them from the hub.
- A seller Decline button, an in-app backup download, and a storage meter. These are postponed to keep the first build short. *(Lewis's call, 23 Nov 2026)*
- ID / anti-money-laundering checks, CRM integration, importing past Adobe agreements, SMS codes, payments.

## Anti-goals (failure even if it works)

- Sending takes as many steps as Adobe did.
- A seller has to create an account or download anything.
- A signed record can be altered afterwards without it showing.
- The firm's legal wording gets changed by accident on a live contract.
- Seller emails or links look like phishing (random domain, unbranded sender) and get ignored or flagged as spam.

## Constraints

- **Look and stack match the sister apps.** Key Tracker (live at keys-xi-five.vercel.app) is the base: Node 22+, ES modules, no framework, plain HTML/CSS/JS front end, Vercel functions + Supabase, `node --test`. Latest Key Tracker code: `~/Downloads/BD_Both_Systems_Mobile_UI_Update/keys-main` (newer than the `key-tracker` git repo). Reuse its colour tokens (`public/styles.css` `:root`), its sign-in (`lib/auth.js`, and the `key_users` table from `SETUP-SECURITY-UPGRADE.sql`) and its patterns (server-only service key, HttpOnly cookies, append-only audit triggers, transactional RPC commits).
- **Dependencies:** the sister apps have none. This one adds exactly one: **`@cantoo/pdf-lib` 2.11.1**, the maintained version of pdf-lib (MIT licence). *(my call)* Writing a PDF engine by hand is not sensible. The original pdf-lib hasn't been updated since 2021 and can't open locked PDFs; see the next point. Nothing else without a reason.
- **The master copy is a locked PDF** (found while planning, 23 Nov 2026). It is AES-encrypted with an empty opening password and no restrictions, which is typical of an Adobe Sign export. `@cantoo/pdf-lib` opens it with an empty password; a test on a scratch copy filled the boxes correctly. Each master is prepared once, on upload:
  - unlock it;
  - drop the stray and Adobe-only boxes;
  - store each image once instead of once per page.
  
  That takes the master from 1.4 MB to about 0.54 MB, so the free 1 GB holds roughly three times as many signed contracts. A master that needs a real password is rejected with a clear message.
- **Personal data.** Names, phones, emails, addresses and signatures. Never in git; test fixtures use made-up people and addresses (as Key Tracker does); service-role key server-side only; the storage bucket is private.
- **English law applies** (office in Poole). Electronic signatures are valid for this kind of contract. Online signing means the seller is signing away from the office, so the 14-day cancellation rules (Consumer Contracts Regulations 2013) apply.
- **Hosting.** Hosted on Vercel like the others, because sellers and email links must reach it. *(my call: Lewis said "local umbrella"; read as "their own system", not "on an office PC")*
- **Free plans, in Lewis's own Vercel and Supabase accounts.** *(Lewis's call)* That brings four limits the build must work within:
  - **Scheduled jobs run once a day.** So reminders and link expiry run from one daily job. That's enough for day-3 and day-7 reminders.
  - **Supabase free gives 1 GB of storage and no backups.** See section 10 for how this is covered.
  - **Supabase free pauses projects after a week without activity.** The daily job keeps it awake.
  - **Vercel's free plan is for non-commercial use.** A tool for a client's business is outside that. Lewis accepts the risk, as with the two live apps. Moving to paid plans later should be a settings change, not a rebuild.

## Approaches considered

**Signing engine**

| | Approach | Trade-off |
|---|---|---|
| A | Keep Adobe Sign, hidden behind a simple form and tracker via Adobe's API | Least to build, Adobe keeps the legal record; but they keep paying Adobe and depend on their plan having API access |
| **B — chosen** | **Our own signing**: fill the master PDF, email a link, capture the signature, stamp an evidence page | Full control of the steps and no Adobe subscription; more to build and test, and the firm's evidence trail is ours to get right |
| C | Switch to a cheaper e-sign service with an API | Dropped: still a third party and a template migration, with no gain over A or B |

Lewis chose **B**.

**Umbrella shape**

| | Approach | Trade-off |
|---|---|---|
| **1 — chosen** | **One hub deployment that grows**: sign-in + home screen + Contracts now; Keys and Window Cards move in later as sections | One domain, one session, one user list. Moving the other two in later is real work, but it's done once |
| 2 | Keep three separate apps and share one login between them | Dropped: the apps live on different `*.vercel.app` addresses, which can't share a sign-in cookie. It would need a custom domain for every app plus single-sign-on plumbing |

*(my call, accepted)*

## What gets built

### 1. The hub

- Signing in uses **the same email and password staff already have for Key Tracker**. *(my call)* The hub uses **Key Tracker's existing Supabase project** for sign-in, and adds its Contracts tables and a private storage bucket there, using additive SQL only — Key Tracker is live and must not be disturbed. When Keys moves in later, its data is already in the same place.
- After sign-in: a home screen with three tiles — **Contracts** (inside the hub), **Keys** and **Window Cards** (open their current live sites for now).
- The live Key Tracker already signs staff in with individual accounts (seen at keys-xi-five.vercel.app on 23 Nov 2026).
- **Lewis created every staff account himself in Supabase**, and the account code in `keys-main` is his. *(Lewis's call)*
  - The hub only adds new tables alongside Key Tracker's (additive SQL). It doesn't change Key Tracker's tables or its Supabase sign-in users.
  - Before the first deploy, the builder confirms the live project has the `key_users` table with staff rows in it. If not, they stop and ask.
- **Everyone can do everything** *(Lewis's call)*. Any active account that can sign in to Key Tracker can use every part of the hub:
  - send, chase, cancel and change fee;
  - replace the master template;
  - settings.
  
  The hub has no roles, no director flag, no per-section switches, and no user-management screen. Lewis keeps making staff accounts in Supabase. A disabled account (`active` = false) can't sign in.
- The hub's working name is **"Berkeleys Office"** *(my call; easy to rename)*. It should be served from a subdomain of berkeleysdrummond.com (e.g. `office.berkeleysdrummond.com`) before go-live, because sellers receive links to it. *(my call)*

### 2. The template and its boxes

The master copy is `Contracts/BD Terms of Sale 2026 Master Copy.pdf` (A4, 10 pages). It was exported from Adobe and still contains Adobe's form fields. All blanks are on page 1. The app fills **this PDF itself**, so sellers receive a document identical to today's.

| PDF field | Where on page 1 | Becomes |
|---|---|---|
| `Client` | Client: | All sellers' names, joined ("Anna Smith and Ben Smith") |
| `Property Address` | Property Address: | Property address (one line) |
| `Mobile Telephone` | Mobile Telephone: | Lead seller's mobile |
| `Email Address` | Email Address: | Lead seller's email |
| `Text Field 3` | Remuneration bullet, before "of the gross sale proceeds" (narrow box, ~24pt) | Fee, a percentage, shown as e.g. "1.5%" |
| `Text Field 1` | Price: "…at a guide of ___ until further…" (~61pt box) | Guide price, formatted "£1,250,000" (text shrinks to fit) |
| `Initials 1` | Beside "Acknowledgment by Vendor" | Seller's initials (from signing) |
| `For the Vendor` | Signature line, left | Seller's signature image |
| `Name` / `Date` | Under it | Seller's name / date signed |
| `For Berkeleys` | Signature line, right | Sender's signature image |
| `Name 1` / `Date 1` | Under it | Sender's name / date sent |
| `Text Field 2` | Unlabelled box beside the "Price" heading | **Dropped**: looks left over *(my call)* |
| `ES_CERTIFYING_SIGNATURE` | Hidden Adobe field | **Removed** |

All fields are flattened in the final PDF so nothing stays editable.

**Basis of appointment** *(my call)*: page 1 hard-codes "Sole Agents until either party gives not less than 28 days written notice…". The form offers **Sole (default) / Joint sole / Multiple**. For Sole, the PDF is unchanged. For the other two, the bullet's text is replaced with that basis's wording. That wording must come from the client (see *Needs from the client*); until it does, only Sole is enabled. Joint sole also asks for the other agent's name.

**Joint sellers** *(my call)*: clause 5.1 says everyone responsible for the fee must sign, but page 1 has one vendor block. Each extra seller gets a block (signature, initials, printed name, date) on an **"Additional signatories" page inserted after page 1**, plus their own signing link. The lead seller signs on page 1.

**Right to cancel page** *(my call)*: inserted after the signature pages. It contains:
- a short notice of the 14-day right to cancel;
- the statutory model cancellation form;
- a tick box: *"I ask Berkeleys Drummond to start marketing my property now, during the 14-day cancellation period."*

The wording is for the client's solicitor to confirm (see *Needs from the client*).

**Evidence page**: appended last (see section 5).

### 3. Sending (negotiator)

Contracts → **New Terms of Sale**:

```
Client name(s)      [Anna Smith        ]  + add another seller (name, email, mobile)
Property address    [                  ]
Mobile              [                  ]
Email               [                  ]   ← the signing link goes here
Basis               (•) Sole  ( ) Joint sole  ( ) Multiple
Fee                 [1.5] %  of gross sale proceeds, excl. VAT
Guide price         £ [                ]
                                   [Preview PDF]  [Send for signing]
```

- **Preview** shows the exact PDF the seller will see, with empty signature spots.
- **Send** applies the sender's saved signature, name and today's date to the "For Berkeleys" block, emails each seller their link, and puts the contract under Out for signing.
- Before their first send, each user draws or types a signature once in their profile. *(my call)*
- Drafts can be saved and finished later. *(my call)*
- Basic checks before sending: valid email and UK mobile, fee between 0.1% and 10%, guide price a number. *(my call)*
- **Joint sellers sharing one email address** are allowed, with a warning to the negotiator. *(my call)*
  - Each seller still gets their own email and link, addressed to them by name ("This link is for Ben Smith").
  - The signing page asks them to confirm they are that person.
  - The evidence page notes that the address was shared.

### 4. Signing (seller)

Email from "Berkeleys Drummond" with a button to review and sign. The link opens a page with no sign-in, which:

1. Shows the full document (page 1 filled in, plus the full terms) in a phone-friendly reader, with a download option.
2. Asks the seller to tick that they agree to sign electronically and have read the Letter and the terms.
3. Shows the right-to-cancel choice: the "start marketing now" tick box, unticked by default.
4. Asks for their signature (draw with finger or mouse, or type their name, shown in a script font), with initials pre-filled from their name and editable.
5. **Sign**: a confirmation screen; the signed copy is emailed once everyone has signed.

Rules *(my call)*:
- Each seller has their own link. A link only works for that seller's signing, and stops working once that seller has signed, the contract is cancelled, or it expires.
- Links expire after 30 days.
- The contract counts as signed when the last seller signs.
- There is **no Decline button** this round *(Lewis's call, 23 Nov 2026)*. A seller who won't sign simply doesn't. The office cancels the contract with a reason, or it expires after 30 days.

### 5. The signed record

When the last seller signs, the app builds the final PDF:
- page 1 filled in and flattened;
- additional signatories page (if any);
- right-to-cancel page with each seller's choice;
- pages 2–10 untouched;
- an **evidence page**.

The evidence page lists, for every signer and for the sender:
- name and email;
- when the link was sent, each time it was opened (time, IP address, device/browser), when they agreed to sign electronically, and when they signed;
- the cancellation-period choice;
- a SHA-256 fingerprint of the document as presented for signing.

The final file's own fingerprint is stored in an append-only database log *(Key Tracker's trigger pattern)*, so any later change to the file is detectable.

**No certificate signature this round** *(my call, from the builder check)*. Adobe's copies carry Acrobat's "certified" banner; ours won't. The record is:
- the evidence page;
- the fingerprint held in the append-only log;
- the copies emailed to every party.

Adding a certificate later would need a second library, plus a signing certificate bought yearly from a trusted provider. A free self-made certificate makes Acrobat warn "unknown identity", which looks worse than no banner at all.

The final PDF goes to each seller, the sender, and an office copy address set in Settings. It is kept in the private storage bucket. The seller's link shows the signed copy for 30 days after signing; after that it just says the copy was emailed. *(my call)*

### 6. The tracker (Contracts home)

```
Out for signing (4)   Signed (31)   Cooling off (3)   Ended (5)      [Mine | Everyone]  [search address/client]
 14 Elm Road      Smith     New         Sent by Jo   5 days   1 of 2 signed   [Chase] [Cancel] [Open]
 ...
```

Statuses:
- **Draft**
- **Out for signing** (shows "n of m signed")
- **Signed**, then either:
  - **Cooling off until 〈date〉**, if any seller didn't ask for marketing to start now; or
  - **Marketing may start**, if every seller ticked the box.
- **Ended** — one of: Expired, Cancelled by office, Cancelled by seller, Replaced (by a later fee change).

Each contract's page shows its full timeline, the PDFs, and each seller's status.

Reminders *(my call)*:
- Automatic reminder emails on day 3 and day 7 to sellers who haven't signed.
- **Chase** sends one immediately (at most one per hour).
- **Cancel** stops all links and needs a reason.

**Cancelled by seller**: if a seller cancels within the 14 days (by email, post or the form), staff record it with the date. No self-service cancel button for sellers. *(my call)*

The tracker works on a phone and on a computer (the sister apps both got mobile updates on 19 Nov).

### 7. Fee change (re-sign)

On a Signed contract: **Change fee**. This opens a copy of the contract with everything locked except the fee (and an optional note for the file). Send works as in section 3 and goes to the same seller(s).
- The tracker shows it as **Fee change** and links the versions (v1, v2…).
- When the new version is fully signed, the earlier one shows **Replaced by v2 on 〈date〉**. Until then, the earlier version stays in force.
- **Cooling-off on a fee change** *(my call; for the client's solicitor to confirm)*. The fee change is also signed away from the office, so v2 includes the right-to-cancel page and gets its own 14 days. If a seller cancels v2 in that time, staff record it, and v1 shows as back in force. The contract's status is always worked out from its event log, so this needs no editing of past records.

**Anyone can send a fee change** *(Lewis's call)*. The sender's signature goes in the "For Berkeleys" block.

A note for the client: clause 28 of their own terms says no variation is valid unless confirmed by a director. A fee change sent by someone who isn't a director could therefore be challenged. The app doesn't enforce this. Either the office makes sure a director sends fee changes, or their solicitor relaxes clause 28.

### 8. Templates

Settings → Templates (open to everyone, like the rest of the hub). There is one template at launch, "Terms of Sale", with its version history.
- **Upload new master copy** (e.g. after the solicitor updates the terms). The app checks that the new PDF has the same named boxes (table above) and shows a preview before it goes live.
- New contracts use the latest version. Contracts already sent keep the version they were sent with.

Adding a new kind of template (e.g. a lettings agreement) is a config change for Lewis, not a screen in the app. *(my call)*

### 9. Email

- Sent through a transactional email service. The builder picks one, e.g. Resend or Postmark.
- Sent from a berkeleysdrummond.com address (e.g. `contracts@`), with the domain's sender records set up so mail isn't marked as spam. The Supabase sign-in emails should use the same sender. *(my call)*
- Messages:
  - to the seller: signing request, reminder, signed copy, cancelled notice;
  - to the sender: signed, expired.

### 10. Data, retention, security

- Tables: contracts, contract versions, signers, events (append-only), templates and template versions. Plus a private storage bucket for master PDFs and signed PDFs.
- Signing tokens: long random values, stored only as hashes, limited to one signer. Signing pages are marked not to be indexed by search engines. Sign/open endpoints are rate-limited.
- **Backups and space on the free plan** *(my call)*:
  - Every signed PDF is already emailed to the office copy address. That inbox is the off-site copy of the documents.
  - The contract records can be exported from Supabase's table editor when needed.
  - **No backup button or storage meter this round** *(Lewis's call, 23 Nov 2026: postponed to keep the build short)*. SETUP.md shows Lewis where to check storage use in Supabase.
  - Masters are slimmed on upload (see Constraints): about 0.54 MB, down from 1.4 MB. Signed copies are about that size plus the extra pages, so roughly 1,500 or more fit in the free 1 GB.
- Signed contracts and evidence are kept for **7 years** (6-year limitation period for contract claims, plus a margin). Clause 26's "destroy correspondence after completion" doesn't apply to the signed Letter. *(my call; the client can change it)*
- Local mode (file store, emails written to the console instead of sent) is for development and tests only. Unlike the sister apps, there's no office-PC install. *(my call)*

## Needs from the client before go-live

1. Wording for the **Joint sole** and **Multiple agency** basis lines (or confirm they only ever use Sole, and the choice disappears).
2. Their solicitor's OK on:
   - the **right-to-cancel page** (notice, model form, "start marketing now" wording);
   - whether a **fee change** gets its own 14 days (section 7). While they're at it, the terms cite outdated law: Money Laundering Regulations 2003, Data Protection Acts 1984/1998, the repealed Property Misdescriptions Act 1991, the 1987 advertisement regulations. Page 7 also has a stray "Page 5 of 7".
3. Access to berkeleysdrummond.com's DNS (or whoever manages it), for the email sender records and the hub's subdomain.
4. The **office copy** email address.
5. Awareness that clause 28 wants a director to confirm fee changes (section 7).

## Left to the builder

- Choice of email service.
- Signature drawing component and script font (open-licence).
- Exact table design and SQL.
- How the hub routes are laid out on Vercel.
- How the PDF reader on the signing page works (rendered page images or the browser's PDF viewer).
- How basis wording is overlaid on page 1.
- How the additional signatories, cancellation and evidence pages are typeset (match the master's font and footer).
- Test strategy: `node --test` with made-up data, plus an end-to-end run that sends to a test inbox.
