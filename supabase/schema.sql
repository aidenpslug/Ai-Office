-- The AI Office: database setup.
-- Paste this whole file into Supabase (SQL Editor > New query) and press Run. Running it twice is safe.

-- Every person's office is a set of small JSON records: their agents ("staff") and tickets.
create table if not exists public.docs (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, id)
);
alter table public.docs enable row level security;
alter table public.docs replica identity full;

drop policy if exists "own office: read" on public.docs;
drop policy if exists "own office: add" on public.docs;
drop policy if exists "own office: change" on public.docs;
drop policy if exists "own office: remove" on public.docs;
create policy "own office: read" on public.docs for select to authenticated using (user_id = auth.uid());
create policy "own office: add" on public.docs for insert to authenticated with check (user_id = auth.uid());
create policy "own office: change" on public.docs for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own office: remove" on public.docs for delete to authenticated using (user_id = auth.uid());

-- Live updates, so the office redraws the moment Jarvis (or another tab) changes something.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- The private key each person's Siri shortcut uses to reach their own office.
create table if not exists public.jarvis_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table public.jarvis_tokens enable row level security;
drop policy if exists "own token: read" on public.jarvis_tokens;
drop policy if exists "own token: set" on public.jarvis_tokens;
drop policy if exists "own token: change" on public.jarvis_tokens;
drop policy if exists "own token: remove" on public.jarvis_tokens;
create policy "own token: read" on public.jarvis_tokens for select to authenticated using (user_id = auth.uid());
create policy "own token: set" on public.jarvis_tokens for insert to authenticated with check (user_id = auth.uid() and length(token) >= 32);
create policy "own token: change" on public.jarvis_tokens for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and length(token) >= 32);
create policy "own token: remove" on public.jarvis_tokens for delete to authenticated using (user_id = auth.uid());

-- Daily Claude usage per person, so one account can't run up the bill. Only the server writes here.
create table if not exists public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  calls integer not null default 0,
  primary key (user_id, day)
);
alter table public.usage enable row level security;
drop policy if exists "own usage: read" on public.usage;
create policy "own usage: read" on public.usage for select to authenticated using (user_id = auth.uid());

create or replace function public.bump_usage(p_user uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.usage (user_id, day, calls) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set calls = public.usage.calls + 1
  returning calls into n;
  if n > p_limit then
    update public.usage set calls = calls - 1 where user_id = p_user and day = current_date;
    return -1;
  end if;
  return n;
end $$;
revoke all on function public.bump_usage(uuid, integer) from public, anon, authenticated;
grant execute on function public.bump_usage(uuid, integer) to service_role;

-- Screenshots and PDFs attached to tickets. Each person can only see their own folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('office', 'office', false, 52428800)
on conflict (id) do nothing;
-- PDFs attached to tickets can be up to 50 MB (the site also raises this itself if needed).
update storage.buckets set file_size_limit = 52428800 where id = 'office' and coalesce(file_size_limit, 0) < 52428800;
drop policy if exists "own screenshots: read" on storage.objects;
drop policy if exists "own screenshots: add" on storage.objects;
drop policy if exists "own screenshots: remove" on storage.objects;
create policy "own screenshots: read" on storage.objects for select to authenticated
  using (bucket_id = 'office' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own screenshots: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'office' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own screenshots: remove" on storage.objects for delete to authenticated
  using (bucket_id = 'office' and (storage.foldername(name))[1] = auth.uid()::text);

-- ===== Who may use the office, and how many tickets each person gets per month =====
-- Only the server reads and writes these. The first person to sign in becomes the owner.
create table if not exists public.members (
  email text primary key check (email = lower(email)),
  role text not null default 'member' check (role in ('owner', 'member')),
  monthly_tickets integer check (monthly_tickets is null or monthly_tickets >= 0),  -- empty means unlimited
  note text,
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;
create unique index if not exists members_one_owner on public.members ((role)) where role = 'owner';

create table if not exists public.ticket_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  month text not null,
  tickets integer not null default 0,
  primary key (user_id, month)
);
alter table public.ticket_usage enable row level security;
drop policy if exists "own tickets: read" on public.ticket_usage;
create policy "own tickets: read" on public.ticket_usage for select to authenticated using (user_id = auth.uid());

-- Counts one agent run. Returns the new monthly count, or -1 when the allowance is used up (null limit = unlimited).
create or replace function public.spend_ticket(p_user uuid, p_limit integer)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer; m text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  insert into public.ticket_usage (user_id, month, tickets) values (p_user, m, 1)
  on conflict (user_id, month) do update set tickets = public.ticket_usage.tickets + 1
  returning tickets into n;
  if p_limit is not null and n > p_limit then
    update public.ticket_usage set tickets = tickets - 1 where user_id = p_user and month = m;
    return -1;
  end if;
  return n;
end $$;
revoke all on function public.spend_ticket(uuid, integer) from public, anon, authenticated;
grant execute on function public.spend_ticket(uuid, integer) to service_role;

-- Makes this email the owner if the office has none yet. Returns true when the email is the owner.
create or replace function public.claim_owner(p_email text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.members where role = 'owner') then
    insert into public.members (email, role, monthly_tickets) values (lower(p_email), 'owner', null)
    on conflict (email) do update set role = 'owner', monthly_tickets = null;
  end if;
  return exists (select 1 from public.members where email = lower(p_email) and role = 'owner');
exception when unique_violation then
  return exists (select 1 from public.members where email = lower(p_email) and role = 'owner');
end $$;
revoke all on function public.claim_owner(text) from public, anon, authenticated;
grant execute on function public.claim_owner(text) to service_role;
