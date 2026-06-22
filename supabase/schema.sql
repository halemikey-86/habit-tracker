-- ============================================================
-- Quest Tracker — Supabase schema
-- Run this once in the Supabase SQL editor (Project > SQL Editor > New query)
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- USERS (custom login, not Supabase Auth) ----------
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  display_name text unique not null,
  password_hash text not null,
  role text not null check (role in ('coach','player')),
  created_at timestamptz default now()
);

alter table app_users enable row level security;
-- Intentionally NO policies for anon on app_users: the only way in is the
-- security-definer login() function below, so the password hash is never
-- directly selectable from the client.

-- Login check: returns a row only if name + password match.
create or replace function public.login(p_name text, p_password text)
returns table(id uuid, role text, display_name text)
language sql
security definer
set search_path = public
as $$
  select id, role, display_name
  from app_users
  where lower(display_name) = lower(p_name)
    and password_hash = crypt(p_password, password_hash);
$$;

grant execute on function public.login(text, text) to anon, authenticated;

-- ---------- QUEST STATE (single row, id = 1) ----------
create table if not exists quest_state (
  id int primary key default 1,
  current_tic int not null default 1,
  phase_index int not null default 0,
  phase_start_tic int not null default 1,
  phase_start_date timestamptz not null default now(),
  pending_spin boolean not null default false,
  game_complete boolean not null default false,
  updated_at timestamptz default now()
);
insert into quest_state (id) values (1) on conflict (id) do nothing;

-- ---------- PHASES / TIERS ----------
create table if not exists phases (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tics int not null check (tics > 0),
  order_index int not null
);

-- ---------- CHECKLIST ITEMS ----------
create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  repeat_days int not null default 1 check (repeat_days > 0)
);

-- ---------- SETBACK CONDITIONS ----------
create table if not exists conditions (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  setback int not null default 1 check (setback > 0)
);

-- ---------- REWARDS POOL ----------
create table if not exists rewards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text default '',
  timing text not null default 'immediate' check (timing in ('immediate','delay')),
  timing_value int not null default 0
);

-- ---------- DAY LOGS (one row per tic) ----------
create table if not exists day_logs (
  tic int primary key,
  checks jsonb not null default '{}'::jsonb,
  comment text default '',
  flagged boolean not null default false,
  flag_reason text default '',
  setback int default 0,
  completed_at timestamptz
);

-- ---------- HISTORY ----------
create table if not exists history (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('complete','setback','note')),
  tic int not null,
  amount int,
  reason text,
  comment text,
  at timestamptz default now()
);

-- ---------- EARNED REWARDS ----------
create table if not exists earned_rewards (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid references rewards(id) on delete set null,
  name text not null,
  description text default '',
  won_at_tic int not null,
  won_at timestamptz default now(),
  used boolean not null default false,
  used_at timestamptz,
  usable_at_tic int not null default 0
);

-- ---------- PHASE REPORTS ----------
create table if not exists phase_reports (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid references phases(id) on delete set null,
  phase_name text not null,
  start_tic int not null,
  end_tic int not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  setback_count int not null default 0,
  accepted boolean not null default false,
  created_at timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- This app uses a custom name+password login instead of Supabase Auth,
-- so there's no auth.uid() to check against. The pragmatic approach here
-- is: anon (the public API key) can read/write the app data tables, but
-- NOT app_users directly. Only people with your Supabase URL + anon key
-- can reach this data at all — don't publish those anywhere public.
-- If you want stronger isolation later, migrate to Supabase Auth and
-- swap these policies for auth.uid()-based ones.
-- ============================================================

alter table quest_state enable row level security;
alter table phases enable row level security;
alter table checklist_items enable row level security;
alter table conditions enable row level security;
alter table rewards enable row level security;
alter table day_logs enable row level security;
alter table history enable row level security;
alter table earned_rewards enable row level security;
alter table phase_reports enable row level security;

create policy "anon full access" on quest_state for all using (true) with check (true);
create policy "anon full access" on phases for all using (true) with check (true);
create policy "anon full access" on checklist_items for all using (true) with check (true);
create policy "anon full access" on conditions for all using (true) with check (true);
create policy "anon full access" on rewards for all using (true) with check (true);
create policy "anon full access" on day_logs for all using (true) with check (true);
create policy "anon full access" on history for all using (true) with check (true);
create policy "anon full access" on earned_rewards for all using (true) with check (true);
create policy "anon full access" on phase_reports for all using (true) with check (true);

-- ============================================================
-- SEED DATA — starter defaults so the app isn't empty on first load.
-- Edit/delete these in the Setup tab once the app is running.
-- ============================================================

insert into phases (name, tics, order_index) values
  ('Phase 1', 90, 0),
  ('Phase 2', 90, 1),
  ('Phase 3', 90, 2),
  ('Phase 4', 95, 3)
on conflict do nothing;

insert into checklist_items (label, repeat_days) values
  ('Example: 10 min check-in', 1)
on conflict do nothing;

insert into conditions (label, setback) values
  ('Missed check-in', 3)
on conflict do nothing;

insert into rewards (name, description, timing, timing_value) values
  ('Movie night pick', 'You choose the movie, no vetoes.', 'immediate', 0)
on conflict do nothing;

-- ============================================================
-- ADD YOUR TWO LOGINS
-- Replace the placeholders below, then run just this block.
-- Password = name + birthday, exactly the string you want to type to log in
-- (e.g. 'Alex0815'). It gets hashed before storage — the plain text is
-- never saved.
-- ============================================================

insert into app_users (display_name, password_hash, role) values
  ('SpouseAName', crypt('SpouseAName0101', gen_salt('bf')), 'coach'),
  ('SpouseBName', crypt('SpouseBName0202', gen_salt('bf')), 'player')
on conflict (display_name) do nothing;
