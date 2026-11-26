-- Memory Companion: shared, private storage for one "care circle" per loved one.
-- Every row belongs to a circle; only members of that circle can see or change it.

create table if not exists public.circles (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  circle_id uuid not null references public.circles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('family', 'device')),
  display_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (circle_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

-- All app records (tasks, medicines, events, messages, people, media, completions, settings).
create table if not exists public.items (
  circle_id uuid not null references public.circles(id) on delete cascade,
  store text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (circle_id, store, id)
);

-- Short codes to pair the loved one's phone or invite another family member.
create table if not exists public.codes (
  code text primary key,
  circle_id uuid not null references public.circles(id) on delete cascade,
  role text not null check (role in ('family', 'device')),
  created_by uuid default auth.uid(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.code_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists code_attempts_idx on public.code_attempts(user_id, at);
alter table public.codes add column if not exists created_at timestamptz not null default now();
alter table public.code_attempts add column if not exists ok boolean not null default false;
alter table public.code_attempts add column if not exists with_circle boolean not null default false;
alter table public.code_attempts add column if not exists circle_id uuid;
create index if not exists code_attempts_circle_idx on public.code_attempts(circle_id, at);

-- ---------------------------------------------------------------- helpers
create or replace function public.is_member(c uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where circle_id = c and user_id = auth.uid());
$$;

create or replace function public.is_family(c uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from members where circle_id = c and user_id = auth.uid() and role = 'family');
$$;

create or replace function public.is_anonymous() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

-- ---------------------------------------------------------------- row-level security
alter table public.circles enable row level security;
alter table public.members enable row level security;
alter table public.items enable row level security;
alter table public.codes enable row level security;
alter table public.code_attempts enable row level security;

drop policy if exists circles_select on public.circles;
drop policy if exists circles_update on public.circles;
drop policy if exists circles_delete on public.circles;
create policy circles_select on public.circles for select to authenticated using (public.is_member(id));
create policy circles_update on public.circles for update to authenticated using (public.is_family(id)) with check (public.is_family(id));
create policy circles_delete on public.circles for delete to authenticated using (public.is_family(id));

drop policy if exists members_select on public.members;
drop policy if exists members_delete on public.members;
drop policy if exists members_update_self on public.members;
create policy members_select on public.members for select to authenticated using (public.is_member(circle_id));
create policy members_delete on public.members for delete to authenticated using (public.is_family(circle_id) or user_id = auth.uid());
create policy members_update_self on public.members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists items_all on public.items;
drop policy if exists items_select on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
drop policy if exists items_delete on public.items;
create policy items_select on public.items for select to authenticated using (public.is_member(circle_id));
create policy items_insert on public.items for insert to authenticated with check (public.is_member(circle_id));
create policy items_update on public.items for update to authenticated
  using (public.is_member(circle_id)) with check (public.is_member(circle_id));
-- The app deletes by writing a tombstone (data.deleted = true), so real deletes are rare:
-- family only, except a device un-checking its own task.
create policy items_delete on public.items for delete to authenticated
  using (public.is_family(circle_id) or (store = 'completions' and public.is_member(circle_id)));
do $$ begin
  alter table public.items add constraint items_data_size check (octet_length(data::text) < 262144);
exception when duplicate_object then null; end $$;

-- Record who changed each item and when; the client can't fake either.
create or replace function public.stamp_item() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists items_stamp on public.items;
create trigger items_stamp before insert or update on public.items
  for each row execute function public.stamp_item();
-- codes and code_attempts: no direct access; only through the functions below.

-- ---------------------------------------------------------------- actions
create or replace function public.create_circle(p_name text, p_display text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c uuid;
begin
  if auth.uid() is null or public.is_anonymous() then
    raise exception 'Please sign in with your email first';
  end if;
  insert into circles (name, created_by) values (left(coalesce(p_name, ''), 60), auth.uid()) returning id into c;
  insert into members (circle_id, user_id, role, display_name) values (c, auth.uid(), 'family', left(coalesce(p_display, ''), 60));
  return c;
end $$;

create or replace function public.make_code(p_circle uuid, p_role text)
returns text language plpgsql security definer set search_path = public as $$
declare k text; tries int := 0;
begin
  if not public.is_family(p_circle) then raise exception 'Only family can create codes'; end if;
  if p_role not in ('family', 'device') then raise exception 'Unknown role'; end if;
  delete from codes where expires_at < now();
  -- At most 3 live codes per circle: making a new one retires the oldest.
  delete from codes where code in (select code from codes where circle_id = p_circle order by created_at desc offset 2);
  loop
    tries := tries + 1;
    if tries > 20 then raise exception 'Could not make a code just now. Please try again.'; end if;
    k := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 100000000)::text, 8, '0');
    exit when not exists (select 1 from codes where code = k);
  end loop;
  insert into codes (code, circle_id, role, expires_at) values (k, p_circle, p_role, now() + interval '24 hours');
  return k;
end $$;

-- Links and QR codes carry the circle id and an 8-digit code. A code typed by hand
-- (no circle id) only works in its first 30 minutes. Wrong guesses are limited per
-- account (10/hour) and, for links, per target circle (30/hour). Failures return null
-- (not an error) so the attempt is recorded and counts toward the limits.
drop function if exists public.redeem_code(text, text);
create or replace function public.redeem_code(p_code text, p_display text, p_circle uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare r codes%rowtype; k text := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  delete from code_attempts where at < now() - interval '1 day';
  if (select count(*) from code_attempts where user_id = auth.uid() and not ok and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many tries. Please wait an hour and try again.';
  end if;
  if p_circle is not null and (select count(*) from code_attempts where circle_id = p_circle and not ok and at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many tries for this family just now. Please ask for a new link in an hour.';
  end if;
  if p_circle is null then
    select * into r from codes where code = k and expires_at > now() and created_at > now() - interval '30 minutes';
  else
    select * into r from codes where code = k and circle_id = p_circle and expires_at > now();
  end if;
  if not found or (r.role = 'family' and public.is_anonymous()) then
    insert into code_attempts (user_id, ok, with_circle, circle_id) values (auth.uid(), false, p_circle is not null, p_circle);
    return null;
  end if;
  insert into code_attempts (user_id, ok, with_circle, circle_id) values (auth.uid(), true, p_circle is not null, r.circle_id);
  insert into members (circle_id, user_id, role, display_name)
  values (r.circle_id, auth.uid(), r.role, left(coalesce(p_display, ''), 60))
  -- Never turn a family member into a device by accident.
  on conflict (circle_id, user_id) do update
    set role = case when members.role = 'family' then 'family' else excluded.role end,
        display_name = case when members.role = 'family' then members.display_name else excluded.display_name end;
  delete from codes where code = r.code;
  return r.circle_id;
end $$;

revoke all on function public.create_circle(text, text) from public, anon;
revoke all on function public.make_code(uuid, text) from public, anon;
revoke all on function public.redeem_code(text, text, uuid) from public, anon;
grant execute on function public.create_circle(text, text) to authenticated;
grant execute on function public.make_code(uuid, text) to authenticated;
grant execute on function public.redeem_code(text, text, uuid) to authenticated;

-- ---------------------------------------------------------------- live updates
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;
-- DELETE events skip row-level security, so they would reach every subscriber.
-- Only inserts and updates are published; the app deletes by writing tombstones.
alter publication supabase_realtime set (publish = 'insert, update');

-- ---------------------------------------------------------------- file storage
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do nothing;
update storage.buckets set allowed_mime_types = array['image/*', 'video/*', 'audio/*'] where id = 'media';
insert into storage.buckets (id, name, public)
values ('voice', 'voice', false)
on conflict (id) do nothing;

create or replace function public.member_of_path(p text) returns boolean
language plpgsql security definer stable set search_path = public as $$
begin
  return public.is_member((split_part(p, '/', 1))::uuid);
exception when others then
  return false;
end $$;

create or replace function public.family_of_path(p text) returns boolean
language plpgsql security definer stable set search_path = public as $$
begin
  return public.is_family((split_part(p, '/', 1))::uuid);
exception when others then
  return false;
end $$;

drop policy if exists media_select on storage.objects;
drop policy if exists media_insert on storage.objects;
drop policy if exists media_update on storage.objects;
drop policy if exists media_delete on storage.objects;
create policy media_select on storage.objects for select to authenticated using (bucket_id = 'media' and public.member_of_path(name));
create policy media_insert on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.member_of_path(name));
create policy media_update on storage.objects for update to authenticated using (bucket_id = 'media' and public.family_of_path(name));
create policy media_delete on storage.objects for delete to authenticated using (bucket_id = 'media' and public.family_of_path(name));
-- The 'voice' bucket has no policies: only the voice function (server side) can use it.

-- ---------------------------------------------------------------- table permissions
-- (Row-level security above still decides WHICH rows each person can touch.)
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.items to authenticated;
grant select, delete on public.circles to authenticated;
revoke update on public.circles from authenticated;
grant update (name) on public.circles to authenticated;
grant select, delete on public.members to authenticated;
-- Circles and memberships are only created inside create_circle / redeem_code, and a
-- member may change nothing about their own row except their display name.
revoke insert on public.circles from authenticated;
revoke insert, update on public.members from authenticated;
grant update (display_name) on public.members to authenticated;
revoke all on public.codes, public.code_attempts from anon, authenticated;
revoke all on public.circles, public.members, public.items from anon;
grant all on public.circles, public.members, public.items, public.codes, public.code_attempts to service_role;
revoke truncate, trigger, references on public.circles, public.members, public.items, public.codes, public.code_attempts from anon, authenticated;

-- ---------------------------------------------------------------- server-only tables
-- Cloned voices belong to exactly one circle. Only the edge functions (service role) touch this.
create table if not exists public.voices (
  voice_id text primary key,
  circle_id uuid not null references public.circles(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists voices_circle_idx on public.voices(circle_id);

-- Warm-voice spending: characters synthesized per user per day (cache hits are free).
create table if not exists public.tts_usage (
  user_id uuid not null,
  day date not null default current_date,
  chars int not null default 0,
  primary key (user_id, day)
);
alter table public.voices enable row level security;
alter table public.tts_usage enable row level security;
revoke all on public.voices, public.tts_usage from anon, authenticated;
grant all on public.voices, public.tts_usage to service_role;

create or replace function public.tts_charge(p_user uuid, p_chars int, p_limit int) returns boolean
language plpgsql security definer set search_path = public as $$
declare used int;
begin
  insert into tts_usage (user_id, day, chars) values (p_user, current_date, 0) on conflict do nothing;
  update tts_usage set chars = chars + p_chars
    where user_id = p_user and day = current_date and chars + p_chars <= p_limit
    returning chars into used;
  delete from tts_usage where day < current_date - 30;
  return used is not null;
end $$;
revoke all on function public.tts_charge(uuid, int, int) from public, anon, authenticated;
grant execute on function public.tts_charge(uuid, int, int) to service_role;

-- A circle always keeps at least one family member (unless the circle itself is being deleted).
create or replace function public.keep_last_family() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'family'
     and exists (select 1 from circles where id = old.circle_id)
     and not exists (select 1 from members where circle_id = old.circle_id and role = 'family' and user_id <> old.user_id) then
    raise exception 'You are the last family member. Delete the care circle instead, or invite someone first.';
  end if;
  return old;
end $$;
drop trigger if exists members_keep_last_family on public.members;
create trigger members_keep_last_family before delete on public.members
  for each row execute function public.keep_last_family();

-- Lock down helper functions that clients never call directly.
revoke all on function public.stamp_item() from public, anon, authenticated;
revoke all on function public.keep_last_family() from public, anon, authenticated;

-- ---------------------------------------------------------------- scheduled cleanup (pg_cron)
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname in ('mc-purge-tombstones', 'mc-purge-anonymous');
select cron.schedule('mc-purge-tombstones', '17 3 * * *',
  $$delete from public.items where data->>'deleted' = 'true' and updated_at < now() - interval '30 days'$$);
-- Anonymous accounts that never paired with a circle are removed after 30 days.
select cron.schedule('mc-purge-anonymous', '27 3 * * *',
  $$delete from auth.users u where u.is_anonymous and u.created_at < now() - interval '30 days'
    and not exists (select 1 from public.members m where m.user_id = u.id)$$);
