# Setting up Berkeleys Office (Contracts)

Berkeleys Office is the staff hub for Berkeleys Drummond. Its first section, **Contracts**, sends the Terms of Sale for online signing and tracks them. It runs on **your free Vercel and Supabase accounts**, and uses **Key Tracker's existing Supabase project** for sign-in and storage. Staff sign in with the same email and password as Key Tracker.

Allow about an hour. Do the steps in order.

## 1. Check Key Tracker's database first

In Supabase, open Key Tracker's project → Project Settings → API. Copy the **Project URL** and the **service_role** key (keep it secret). Then, in this folder on your Mac:

```bash
SUPABASE_URL=https://YOUR-PROJECT.supabase.co SUPABASE_SERVICE_KEY=YOUR-SERVICE-KEY node scripts/check-supabase.mjs
```

- It must say `OK: N active staff account(s) in key_users`. If it says **STOP**, don't go further. The staff accounts or Key Tracker's account upgrade aren't in place.
- The first time, it will also say the Berkeleys Office tables aren't set up yet. That's expected.

## 2. Add the Berkeleys Office tables

Supabase → SQL Editor → New query → paste the whole of `SETUP-SUPABASE.sql` → Run.

It only **adds** things: new `bo_` tables, two functions and a private storage bucket called `contracts`. It doesn't change Key Tracker's tables or users. Run step 1 again; it should now say everything exists.

## 3. Let sign-in links work on the new address

Supabase → Authentication → URL Configuration → **Redirect URLs** → add your new Berkeleys Office address (from step 5, e.g. `https://berkeleys-office.vercel.app/**`).

**Don't change the Site URL.** Key Tracker uses it.

## 4. Email (Resend)

1. Create a free account at resend.com and make an API key.
2. Add the domain `berkeleysdrummond.com` and send the DNS records Resend shows you to whoever manages the domain. Once they're added, Resend marks the domain as verified.
3. Until then you can only send test emails to your own address, from Resend's test sender.

## 5. Vercel

Upload the code to a new **private** GitHub repository, using the "Berkeleys Office - GitHub upload" folder, as you did for Key Tracker. Create a new Vercel project from it, then add these Environment Variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Key Tracker's Supabase Project URL (step 1) |
| `SUPABASE_SERVICE_KEY` | Key Tracker's service_role key (step 1) |
| `RESEND_API_KEY` | from step 4 |
| `MAIL_FROM` | `Berkeleys Drummond <contracts@berkeleysdrummond.com>` once the domain is verified (until then: `onboarding@resend.dev`) |
| `PUBLIC_URL` | the site's address, e.g. `https://berkeleys-office.vercel.app` (no slash at the end) |
| `CRON_SECRET` | any long random text. Vercel uses it to run the daily reminders |
| `KEYS_URL` / `WINDOW_CARDS_URL` | optional. They default to the two live sites |

Deploy. Vercel runs the daily job (reminders, expiry) once a day at 08:00 UTC by itself.

## 6. First sign-in

1. Open the site and sign in with your Key Tracker email and password.
2. **Settings** → upload `BD Terms of Sale 2026 Master Copy.pdf` → **View sample** → **Make this the live version**.
3. **Settings** → set the office copy email (for example the sales inbox). Every signed contract is emailed there. That inbox is also your off-site copy.
4. **Profile** → draw or type your signature → Save. Everyone who sends contracts needs to do this once.

## 7. Test it on yourself

Send a Terms of Sale to your own email, with yourself as the seller. Sign it on your phone. Check that:

- the signed PDF arrives;
- the tracker shows it as signed or cooling off.

Then cancel any test contracts so they sit under Ended.

## 8. Later: a proper address

Point a subdomain such as `office.berkeleysdrummond.com` at the Vercel project (Vercel → Domains). Then update `PUBLIC_URL`, and the redirect URL from step 3. Sellers trust links on the firm's own domain more than a `vercel.app` one.

## Keeping an eye on it

- **Storage:** the free Supabase plan has 1 GB. Each signed contract is about 0.6 MB, so roughly 1,500 contracts fit. Check Supabase → Project → Usage now and then.
- **Records:** the free plan has no backups. Signed PDFs are in the office copy inbox. To export the records, go to Supabase → Table Editor → each `bo_` table → Export → CSV.
- **Vercel's free plan** is for non-commercial use. A tool for a client's business is outside that, which is the same risk the two live apps carry. Moving to Vercel Pro is a plan change, not a rebuild.

## Still needed from Berkeleys Drummond

1. Wording for the **Joint sole** and **Multiple agency** lines, if they use them. Until then only Sole is offered.
2. Their solicitor's OK on the **right-to-cancel page** (notice, model form, "start marketing now" wording), and on whether a **fee change** gets its own 14 days. While they're at it: the terms cite out-of-date law (Money Laundering Regulations 2003, Data Protection Acts 1984/1998, the repealed Property Misdescriptions Act 1991, the 1987 advertisement regulations) and have a stray "Page 5 of 7" on page 7.
3. DNS access for `berkeleysdrummond.com` (steps 4 and 8).
4. The office copy email address.
5. A note that clause 28 of their own terms says fee changes need a director's confirmation. The app doesn't enforce this.

## Running it on your Mac (for trying things out)

```bash
DEV_EMAIL=you@example.com DEV_PASSWORD=a-long-password npm start
```

Then open http://localhost:8479.

- Data is kept in memory and disappears when you stop it.
- Emails are printed in the terminal instead of being sent, including the signing links.
- If `seed/terms-of-sale-master.pdf` exists, it's loaded automatically. The `seed/` folder is never uploaded.

`npm test` runs the automatic checks.
