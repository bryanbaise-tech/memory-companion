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
declare k text;
begin
  if not public.is_family(p_circle) then raise exception 'Only family can create codes'; end if;
  if p_role not in ('family', 'device') then raise exception 'Unknown role'; end if;
  delete from codes where expires_at < now();
  loop
    k := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from codes where code = k);
  end loop;
  insert into codes (code, circle_id, role) values (k, p_circle, p_role);
  return k;
end $$;

create or replace function public.redeem_code(p_code text, p_display text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r codes%rowtype;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  -- Slow down guessing: at most 10 tries per hour per account.
  if (select count(*) from code_attempts where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many tries. Please wait an hour and try again.';
  end if;
  insert into code_attempts (user_id) values (auth.uid());
  select * into r from codes where code = regexp_replace(coalesce(p_code, ''), '\D', '', 'g') and expires_at > now();
  if not found then raise exception 'That code is not right or has expired'; end if;
  if r.role = 'family' and public.is_anonymous() then
    raise exception 'Please sign in with your email to join as family';
  end if;
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
revoke all on function public.redeem_code(text, text) from public, anon;
grant execute on function public.create_circle(text, text) to authenticated;
grant execute on function public.make_code(uuid, text) to authenticated;
grant execute on function public.redeem_code(text, text) to authenticated;

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
grant select, insert, update, delete on public.circles, public.members, public.items to authenticated;
grant all on public.circles, public.members, public.items, public.codes, public.code_attempts to service_role;
revoke truncate, trigger, references on public.circles, public.members, public.items, public.codes, public.code_attempts from anon, authenticated;
