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
create policy circles_update on public.circles for update to authenticated using (public.is_family(id));
create policy circles_delete on public.circles for delete to authenticated using (public.is_family(id));

drop policy if exists members_select on public.members;
drop policy if exists members_delete on public.members;
drop policy if exists members_update_self on public.members;
create policy members_select on public.members for select to authenticated using (public.is_member(circle_id));
create policy members_delete on public.members for delete to authenticated using (public.is_family(circle_id) or user_id = auth.uid());
create policy members_update_self on public.members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists items_all on public.items;
create policy items_all on public.items for all to authenticated
  using (public.is_member(circle_id)) with check (public.is_member(circle_id));

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
  insert into circles (name, created_by) values (coalesce(p_name, ''), auth.uid()) returning id into c;
  insert into members (circle_id, user_id, role, display_name) values (c, auth.uid(), 'family', coalesce(p_display, ''));
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
    k := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from codes where code = k);
  end loop;
  insert into codes (code, circle_id, role, expires_at) values (k, p_circle, p_role, now() + interval '24 hours');
  return k;
end $$;

-- Links and QR codes carry the circle id, so a leaked 6-digit code alone is useless.
-- A code typed by hand (no circle id) only works in its first 30 minutes, with a
-- cap on wrong guesses across everyone. Failures return null (not an error) so
-- the attempt is recorded and counts toward the limits.
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
  if p_circle is null and (select count(*) from code_attempts where not ok and not with_circle and at > now() - interval '1 hour') >= 200 then
    raise exception 'Too many tries right now. Please use the link or QR code instead, or try again later.';
  end if;
  if p_circle is null then
    select * into r from codes where code = k and expires_at > now() and created_at > now() - interval '30 minutes';
  else
    select * into r from codes where code = k and circle_id = p_circle and expires_at > now();
  end if;
  if not found or (r.role = 'family' and public.is_anonymous()) then
    insert into code_attempts (user_id, ok, with_circle) values (auth.uid(), false, p_circle is not null);
    return null;
  end if;
  insert into code_attempts (user_id, ok, with_circle) values (auth.uid(), true, p_circle is not null);
  insert into members (circle_id, user_id, role, display_name)
  values (r.circle_id, auth.uid(), r.role, coalesce(p_display, ''))
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

-- ---------------------------------------------------------------- file storage
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do nothing;
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

drop policy if exists media_select on storage.objects;
drop policy if exists media_insert on storage.objects;
drop policy if exists media_update on storage.objects;
drop policy if exists media_delete on storage.objects;
create policy media_select on storage.objects for select to authenticated using (bucket_id = 'media' and public.member_of_path(name));
create policy media_insert on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.member_of_path(name));
create policy media_update on storage.objects for update to authenticated using (bucket_id = 'media' and public.member_of_path(name));
create policy media_delete on storage.objects for delete to authenticated using (bucket_id = 'media' and public.member_of_path(name));
-- The 'voice' bucket has no policies: only the voice function (server side) can use it.

-- ---------------------------------------------------------------- table permissions
-- (Row-level security above still decides WHICH rows each person can touch.)
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.items to authenticated;
grant select, update, delete on public.circles to authenticated;
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
