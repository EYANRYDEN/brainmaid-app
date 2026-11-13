-- BrainMaid family app: database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Safe to run once.

create extension if not exists pgcrypto;

-- Household and who belongs to it ---------------------------------------
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists members (
  user_id uuid primary key references auth.users on delete cascade,
  household_id uuid not null references households on delete cascade,
  name text not null,
  initials text not null check (initials in ('R','T')),
  created_at timestamptz not null default now()
);

-- Emails allowed to join a household (only these people can see its data)
create table if not exists invites (
  email text primary key,
  household_id uuid not null references households on delete cascade,
  name text not null,
  initials text not null check (initials in ('R','T'))
);

create or replace function my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from members where user_id = auth.uid()
$$;

create or replace function claim_invite() returns members
language plpgsql security definer set search_path = public as $$
declare m members; i invites;
begin
  select * into m from members where user_id = auth.uid();
  if found then return m; end if;
  select * into i from invites where lower(email) = lower(auth.jwt() ->> 'email');
  if not found then raise exception 'not_invited'; end if;
  insert into members (user_id, household_id, name, initials)
    values (auth.uid(), i.household_id, i.name, i.initials) returning * into m;
  return m;
end $$;

revoke all on function claim_invite() from public;
grant execute on function claim_invite() to authenticated;
grant execute on function my_household() to authenticated;

-- Shared data -------------------------------------------------------------
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  title text not null,
  notes text,
  due date,
  who text not null default 'both' check (who in ('R','T','both')),
  repeat text check (repeat in ('daily','weekly','monthly','yearly')),
  done boolean not null default false,
  done_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  title text not null,
  date date not null,
  time time,
  who text not null default 'both' check (who in ('R','T','both')),
  repeat text check (repeat in ('weekly','monthly','yearly')),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  name text not null,
  kind text not null default 'general' check (kind in ('shop','general')),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null default my_household() references households on delete cascade,
  list_id uuid not null references lists on delete cascade,
  name text not null,
  qty text,
  aisle text,
  tier text not null default 'w' check (tier in ('w','m')),
  who text check (who in ('R','T','both')),
  done boolean not null default false,
  added_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists meals (
  household_id uuid not null default my_household() references households on delete cascade,
  id text not null,
  week int not null,
  slot int not null,
  title text not null,
  mins int,
  kit text,
  protein text,
  steps jsonb not null default '[]',
  mila text,
  spice text,
  plates jsonb not null default '{}',
  lunch jsonb not null default '{}',
  ing jsonb not null default '[]',
  primary key (household_id, id)
);

create table if not exists meal_ratings (
  household_id uuid not null default my_household() references households on delete cascade,
  meal_id text not null,
  date date not null,
  r int check (r in (-1,0,1)),
  t int check (t in (-1,0,1)),
  m int check (m in (-1,0,1)),
  note text,
  primary key (household_id, meal_id, date)
);

create table if not exists plan (
  household_id uuid primary key default my_household() references households on delete cascade,
  start_date date not null default '2026-11-02',
  default_takeout text not null default 'wed',
  takeout jsonb not null default '{}',
  staples jsonb not null default '{}'
);

-- Each phone's notification subscription (used by the notification sender)
create table if not exists push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  household_id uuid not null default my_household() references households on delete cascade,
  sub jsonb not null,
  prefs jsonb not null default '{"morning":true,"dinner":true,"shop":true,"events":true}',
  created_at timestamptz not null default now()
);

-- Security: each person only ever sees their own household -----------------
do $$
declare t text;
begin
  foreach t in array array['tasks','events','lists','list_items','meals','meal_ratings','plan'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists household_only on %I', t);
    execute format('create policy household_only on %I for all to authenticated using (household_id = my_household()) with check (household_id = my_household())', t);
  end loop;
end $$;

alter table households enable row level security;
drop policy if exists my_household_row on households;
create policy my_household_row on households for select to authenticated using (id = my_household());

alter table members enable row level security;
drop policy if exists household_members on members;
create policy household_members on members for select to authenticated using (household_id = my_household());

alter table invites enable row level security; -- no policies: only the join function reads it

alter table push_subs enable row level security;
drop policy if exists own_subs on push_subs;
create policy own_subs on push_subs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates between both phones
do $$
declare t text;
begin
  foreach t in array array['tasks','events','lists','list_items','meals','meal_ratings','plan'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Invited family members are confirmed automatically, so no confirmation email is needed
create or replace function public.autoconfirm_invited() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.invites where lower(email) = lower(new.email)) then
    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  end if;
  return new;
end $$;
revoke execute on function public.autoconfirm_invited() from public, anon, authenticated;
drop trigger if exists autoconfirm_invited on auth.users;
create trigger autoconfirm_invited before insert on auth.users for each row execute function public.autoconfirm_invited();
revoke execute on function public.claim_invite() from anon, public;
revoke execute on function public.my_household() from anon, public;
