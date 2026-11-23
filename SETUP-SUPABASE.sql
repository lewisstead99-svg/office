-- Berkeleys Office (Contracts) — run once in the SQL editor of KEY TRACKER'S Supabase project.
-- Additive only: creates new bo_ tables, two functions and one private storage bucket.
-- It never changes Key Tracker's own tables or its users.

create table if not exists public.bo_contracts (
  id uuid primary key,
  family_id uuid not null,
  version int not null,
  kind text not null check (kind in ('new', 'fee_change')),
  replaces_id uuid,
  template_version_id uuid,
  fields jsonb not null,
  note text,
  created_by jsonb,
  sender jsonb,
  presented_path text,
  presented_sha256 text,
  final_path text,
  final_sha256 text,
  state text not null,
  rev int not null,
  created_at timestamptz not null,
  sent_at timestamptz,
  completed_at timestamptz,
  unique (family_id, version)
);
create index if not exists bo_contracts_state on public.bo_contracts (state, created_at desc);
create index if not exists bo_contracts_family on public.bo_contracts (family_id, version);

create table if not exists public.bo_signers (
  id uuid primary key,
  contract_id uuid not null references public.bo_contracts(id),
  position int not null,
  name text not null,
  email text not null,
  mobile text,
  shared_email boolean not null default false,
  status text not null check (status in ('pending', 'signed')),
  signed_at timestamptz,
  signature_png text,
  initials text,
  start_marketing_now boolean
);
create index if not exists bo_signers_contract on public.bo_signers (contract_id, position);

create table if not exists public.bo_signer_tokens (
  hash text primary key,
  signer_id uuid not null references public.bo_signers(id),
  created_at timestamptz not null default now()
);

create table if not exists public.bo_events (
  id bigserial primary key,
  contract_id uuid not null references public.bo_contracts(id),
  signer_id uuid,
  type text not null,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  ip text,
  user_agent text,
  data jsonb not null default '{}'::jsonb
);
create index if not exists bo_events_contract on public.bo_events (contract_id, id);

create table if not exists public.bo_template_versions (
  id uuid primary key,
  template_id text not null,
  version int not null,
  path text not null,
  sha256 text not null,
  bytes int not null,
  field_rects jsonb not null,
  uploaded_by jsonb,
  uploaded_at timestamptz not null,
  activated_at timestamptz,
  unique (template_id, version)
);

create table if not exists public.bo_settings (
  key text primary key,
  value jsonb not null
);

create table if not exists public.bo_user_signatures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  png text not null,
  updated_at timestamptz not null default now()
);

-- Only the server (service role) may read or write these tables.
alter table public.bo_contracts enable row level security;
alter table public.bo_signers enable row level security;
alter table public.bo_signer_tokens enable row level security;
alter table public.bo_events enable row level security;
alter table public.bo_template_versions enable row level security;
alter table public.bo_settings enable row level security;
alter table public.bo_user_signatures enable row level security;
revoke all on public.bo_contracts, public.bo_signers, public.bo_signer_tokens, public.bo_events,
  public.bo_template_versions, public.bo_settings, public.bo_user_signatures from anon, authenticated;
grant all on public.bo_contracts, public.bo_signers, public.bo_signer_tokens, public.bo_events,
  public.bo_template_versions, public.bo_settings, public.bo_user_signatures to service_role;
grant usage, select on sequence public.bo_events_id_seq to service_role;

-- The signing log cannot be rewritten: updates and deletes are refused.
create or replace function public.bo_reject_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Berkeleys Office signing log is append-only';
end;
$$;
drop trigger if exists bo_events_no_update on public.bo_events;
create trigger bo_events_no_update before update or delete on public.bo_events
for each row execute function public.bo_reject_event_mutation();

-- Save contracts, sellers, link tokens and events in one transaction (and drop sellers removed from a draft).
-- A contract row with rev 1 is new; otherwise the stored rev must be exactly rev - 1,
-- or someone else changed it first and nothing is saved ('bo_conflict').
create or replace function public.bo_commit(p_contracts jsonb, p_signers jsonb, p_events jsonb, p_tokens jsonb, p_remove_signers jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c jsonb;
  changed integer;
begin
  for c in select * from jsonb_array_elements(coalesce(p_contracts, '[]'::jsonb)) loop
    if (c->>'rev')::int = 1 then
      insert into bo_contracts select * from jsonb_populate_record(null::bo_contracts, c);
    else
      update bo_contracts t set
        family_id = r.family_id, version = r.version, kind = r.kind, replaces_id = r.replaces_id,
        template_version_id = r.template_version_id, fields = r.fields, note = r.note, created_by = r.created_by,
        sender = r.sender, presented_path = r.presented_path, presented_sha256 = r.presented_sha256,
        final_path = r.final_path, final_sha256 = r.final_sha256, state = r.state, rev = r.rev,
        sent_at = r.sent_at, completed_at = r.completed_at
      from jsonb_populate_record(null::bo_contracts, c) r
      where t.id = r.id and t.rev = r.rev - 1;
      get diagnostics changed = row_count;
      if changed = 0 then
        raise exception 'bo_conflict';
      end if;
    end if;
  end loop;

  -- Sellers removed from a draft before it was sent (drafts have no links yet).
  delete from bo_signers
    where id in (select (jsonb_array_elements_text(coalesce(p_remove_signers, '[]'::jsonb)))::uuid)
      and not exists (select 1 from bo_signer_tokens t where t.signer_id = bo_signers.id);

  insert into bo_signers
    select * from jsonb_populate_recordset(null::bo_signers, coalesce(p_signers, '[]'::jsonb))
  on conflict (id) do update set
    position = excluded.position, name = excluded.name, email = excluded.email, mobile = excluded.mobile,
    shared_email = excluded.shared_email, status = excluded.status, signed_at = excluded.signed_at,
    signature_png = excluded.signature_png, initials = excluded.initials, start_marketing_now = excluded.start_marketing_now;

  insert into bo_signer_tokens (hash, signer_id, created_at)
    select hash, signer_id, coalesce(created_at, now())
    from jsonb_populate_recordset(null::bo_signer_tokens, coalesce(p_tokens, '[]'::jsonb));

  insert into bo_events (contract_id, signer_id, type, at, actor_id, actor_email, ip, user_agent, data)
    select contract_id, signer_id, type, coalesce(at, now()), actor_id, actor_email, ip, user_agent, coalesce(data, '{}'::jsonb)
    from jsonb_populate_recordset(null::bo_events, coalesce(p_events, '[]'::jsonb));
end;
$$;

create or replace function public.bo_state_counts()
returns table(state text, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.state, count(*) from bo_contracts c group by c.state;
$$;

revoke execute on function public.bo_commit(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.bo_state_counts() from public, anon, authenticated;
grant execute on function public.bo_commit(jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.bo_state_counts() to service_role;

-- Private bucket for master copies and contract PDFs.
insert into storage.buckets (id, name, public) values ('contracts', 'contracts', false)
on conflict (id) do nothing;
