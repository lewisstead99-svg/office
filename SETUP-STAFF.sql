-- Berkeleys Office on a Supabase project OF ITS OWN (not Key Tracker's).
-- Run this once, BEFORE SETUP-SUPABASE.sql. It creates the staff list and the sign-in log.
-- (They are called key_users / key_security_log because the app was built to share Key Tracker's
--  project and reads those names. In this project they belong to Berkeleys Office only.)

create table if not exists public.key_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  role text not null default 'staff',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.key_security_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  action text not null,
  details text
);

-- Only the server (service role) may read or write these.
alter table public.key_users enable row level security;
alter table public.key_security_log enable row level security;
revoke all on public.key_users, public.key_security_log from anon, authenticated;
grant all on public.key_users, public.key_security_log to service_role;
grant usage, select on sequence public.key_security_log_id_seq to service_role;

-- Adding a member of staff (after creating them in Authentication → Users → Add user):
--   insert into public.key_users (id, email, full_name)
--   select id, lower(email), 'Their Full Name' from auth.users where lower(email) = 'their@email.com';
-- Turning someone off:
--   update public.key_users set active = false where email = 'their@email.com';
