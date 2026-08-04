-- Cutting Room Ledger — Supabase schema
-- Run this once in your Supabase project's SQL editor (Database > SQL Editor > New query).

create table if not exists items (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists customers (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security is on by default for new Supabase projects.
-- These policies allow the app's anon key to read/write everything —
-- there is NO login in this app, so anyone with the deployed URL can
-- see and edit pricing, cost, and inventory data. That's fine for an
-- internal tool on a private link, but if you want real access control
-- later, replace these with Supabase Auth + per-user policies.

alter table items enable row level security;
alter table customers enable row level security;
alter table orders enable row level security;

create policy "allow all - items" on items for all using (true) with check (true);
create policy "allow all - customers" on customers for all using (true) with check (true);
create policy "allow all - orders" on orders for all using (true) with check (true);
