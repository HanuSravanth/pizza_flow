-- PizzaFlow — Supabase schema.
-- Preferred: `npm run db:setup` applies this file + seed.sql in one command
-- (needs SUPABASE_DB_URL in .env.local — see .env.example). Alternative:
-- paste into the Supabase SQL editor (Dashboard > SQL Editor > New query),
-- then run seed.sql. Either way, create the admin login afterwards under
-- Authentication > Users > "Add user" — no signup flow is exposed.
-- Idempotent: safe to re-run after edits.
--
-- Design notes:
--  * 5 tables: menu_items, orders, order_items, order_item_toppings, settings.
--  * Orders snapshot item NAMES and PRICES at purchase time, so editing the
--    menu tomorrow never rewrites yesterday's bills.
--  * CHECK constraints mirror the app's validation rules — bad data cannot
--    enter even through the REST API directly.
--  * RLS: anyone may read the menu and place an order; only the
--    authenticated admin may read orders.

-- ---------------------------------------------------------------- menu
create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('base', 'pizza', 'topping')),
  name text not null,
  price numeric(10, 2) not null check (price > 0),
  is_active boolean not null default true,
  is_veg boolean not null default true,
  created_at timestamptz not null default now(),
  unique (category, name)
);

-- Upgrade path for databases created before veg/non-veg tagging existed.
alter table menu_items add column if not exists is_veg boolean not null default true;

-- Upgrade path for databases created before per-pizza base/topping combo tagging
-- existed. NULL/absent means "nothing allowed" (meaningful only on pizza rows;
-- ignored for bases/toppings) — the backfill below fills every existing pizza
-- with every base/topping so nothing goes dark on upgrade, and only touches
-- rows still NULL so it never undoes an admin's later narrowing.
alter table menu_items add column if not exists allowed_base_ids uuid[];
alter table menu_items add column if not exists allowed_topping_ids uuid[];

update menu_items set allowed_base_ids = (
  select coalesce(array_agg(id), '{}') from menu_items where category = 'base'
) where category = 'pizza' and allowed_base_ids is null;

update menu_items set allowed_topping_ids = (
  select coalesce(array_agg(id), '{}') from menu_items where category = 'topping'
) where category = 'pizza' and allowed_topping_ids is null;

-- ---------------------------------------------------------------- orders
-- Lifecycle: 'placed' from the first "Confirm and order" click (payment_mode
-- still null — the customer may add more pizzas and confirm again, each time
-- appending order_items to this same row), then 'paid' once "Finish and pay"
-- sets a payment_mode. Kitchen delivery itself is out of scope; this table
-- only tracks what's been confirmed and what's been paid for.
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  session_started_at timestamptz not null,
  customer_name text not null check (customer_name ~ '^[A-Za-z][A-Za-z ]{0,38}[A-Za-z]$'),
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  subtotal numeric(10, 2) not null check (subtotal >= 0),
  discount numeric(10, 2) not null default 0 check (discount >= 0),
  gst numeric(10, 2) not null check (gst >= 0),
  total numeric(10, 2) not null check (total >= 0),
  payment_mode text check (payment_mode in ('Cash', 'Card', 'UPI')),
  table_number int check (table_number between 1 and 50),
  status text not null default 'placed' check (status in ('placed', 'paid')),
  offer_tier text check (offer_tier is null or length(offer_tier) between 1 and 50),
  offer_incentive text check (offer_incentive is null or length(offer_incentive) between 1 and 150)
);

-- Upgrade path for databases created before dine-in table tracking existed.
alter table orders add column if not exists table_number int check (table_number between 1 and 50);

-- Upgrade path for databases created before the confirm/pay lifecycle existed.
-- Default 'paid' here (unlike the fresh-create default above) because it
-- backfills rows created under the old one-shot flow, which were always
-- fully paid already; every new insert/update from the app passes status
-- explicitly, so this default only ever applies to pre-existing rows.
alter table orders add column if not exists status text not null default 'paid' check (status in ('placed', 'paid'));
alter table orders alter column payment_mode drop not null;

-- Upgrade path for databases created before loyalty rewards existed on orders.
alter table orders add column if not exists offer_tier text check (offer_tier is null or length(offer_tier) between 1 and 50);
alter table orders add column if not exists offer_incentive text check (offer_incentive is null or length(offer_incentive) between 1 and 150);

create index if not exists orders_created_at_idx on orders (created_at desc);

-- ------------------------------------------------------------ line items
create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  base_id uuid references menu_items (id),
  pizza_id uuid references menu_items (id),
  base_name text not null,   -- snapshot at purchase time
  pizza_name text not null,  -- snapshot at purchase time
  quantity int not null check (quantity between 1 and 10),
  unit_price numeric(10, 2) not null check (unit_price > 0)
);

create index if not exists order_items_order_id_idx on order_items (order_id);

create table if not exists order_item_toppings (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items (id) on delete cascade,
  topping_id uuid references menu_items (id),
  topping_name text not null, -- snapshot at purchase time
  price numeric(10, 2) not null check (price >= 0)
);

create index if not exists order_item_toppings_item_idx on order_item_toppings (order_item_id);

-- ---------------------------------------------------------------- feedback
-- Post-payment ratings/feedback captured on the bill page. Keyed by pizza
-- NAME (not order_item id) because order ids are generated client-side and
-- never read back — names are what the bill page already has on hand.
create table if not exists order_feedback (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  created_at timestamptz not null default now(),
  overall_rating int check (overall_rating between 1 and 5),
  pizza_ratings jsonb not null default '{}'::jsonb, -- { "Margherita": 5, ... }
  quick_tags text[] not null default '{}',
  comments text check (comments is null or length(comments) <= 1000)
);

create index if not exists order_feedback_order_id_idx on order_feedback (order_id);

alter table order_feedback enable row level security;

drop policy if exists "feedback insertable by anyone" on order_feedback;
create policy "feedback insertable by anyone" on order_feedback
  for insert with check (true);
drop policy if exists "feedback readable by admin" on order_feedback;
create policy "feedback readable by admin" on order_feedback
  for select to authenticated using (true);

-- ---------------------------------------------------------------- settings
-- Outlet-level configuration editable from the admin console (e.g. the
-- outlet's display name). Key/value keeps it schema-stable as settings grow.
create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------- dine in tables
create table if not exists dine_in_tables (
  table_number int primary key check (table_number between 1 and 50),
  capacity int not null default 4 check (capacity > 0),
  status text not null default 'vacant' check (status in ('vacant', 'occupied', 'reserved')),
  customer_name text check (customer_name is null or length(customer_name) between 1 and 50),
  group_size int check (group_size is null or group_size > 0),
  seated_at timestamptz,
  offer_tier text check (offer_tier is null or length(offer_tier) between 1 and 50),
  offer_incentive text check (offer_incentive is null or length(offer_incentive) between 1 and 150),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- waitlist
create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null check (length(customer_name) between 2 and 40),
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  group_size int not null check (group_size > 0),
  joined_at timestamptz not null default now(),
  time_offset_minutes int not null default 0,
  status text not null default 'waiting' check (status in ('waiting', 'seated', 'cancelled')),
  seated_table_number int check (seated_table_number between 1 and 50),
  seated_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
alter table menu_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_item_toppings enable row level security;
alter table settings enable row level security;
alter table dine_in_tables enable row level security;
alter table waitlist enable row level security;

-- Seating & Waitlist Policies
drop policy if exists "admin do everything on dine_in_tables" on dine_in_tables;
create policy "admin do everything on dine_in_tables" on dine_in_tables
  for all to authenticated using (true) with check (true);

drop policy if exists "admin do everything on waitlist" on waitlist;
create policy "admin do everything on waitlist" on waitlist
  for all to authenticated using (true) with check (true);

drop policy if exists "anyone can select dine_in_tables" on dine_in_tables;
create policy "anyone can select dine_in_tables" on dine_in_tables
  for select using (true);

drop policy if exists "anyone can select waitlist" on waitlist;
create policy "anyone can select waitlist" on waitlist
  for select using (true);

drop policy if exists "anyone can insert waitlist" on waitlist;
create policy "anyone can insert waitlist" on waitlist
  for insert with check (true);

-- Settings: everyone can read the public settings (the ordering page shows the
-- outlet name), EXCEPT `secret_`-prefixed rows (e.g. the OpenRouter API key),
-- which are hidden from anon clients and never returned by the public REST API.
-- The signed-in admin (authenticated) can read and change everything; the
-- server's service-role client bypasses RLS to read secrets in the AI routes.
drop policy if exists "settings readable by all" on settings;
create policy "settings readable by all" on settings
  for select using (key not like 'secret\_%');
drop policy if exists "settings editable by admin" on settings;
create policy "settings editable by admin" on settings
  for all to authenticated using (true) with check (true);

-- Menu: readable by everyone (the ordering page is public).
drop policy if exists "menu readable by all" on menu_items;
create policy "menu readable by all" on menu_items
  for select using (true);

-- Menu edits: admin only.
drop policy if exists "menu editable by admin" on menu_items;
create policy "menu editable by admin" on menu_items
  for all to authenticated using (true) with check (true);

-- Orders: the public counter flow may INSERT; only the signed-in admin may SELECT.
-- NOTE: because anon has no SELECT policy, inserts from the app must NOT use
-- RETURNING (PostgREST .select() after .insert()) — Postgres checks returned
-- rows against SELECT policies and rejects the whole insert. The app therefore
-- generates ids client-side and inserts with no read-back.
drop policy if exists "orders insertable by anyone" on orders;
create policy "orders insertable by anyone" on orders
  for insert with check (true);
drop policy if exists "orders readable by admin" on orders;
create policy "orders readable by admin" on orders
  for select to authenticated using (true);
-- The public flow updates its own order (running totals on each "Confirm and
-- order", then payment_mode + status on "Finish and pay") — but only while it
-- is still 'placed'; once 'paid', anon can no longer write to it. WITH CHECK
-- must be spelled out as `true`: without it, Postgres reuses the USING clause
-- as the check on the RESULTING row too, which would reject the one update
-- that matters most — setting status to 'paid'.
drop policy if exists "orders updatable while placed" on orders;
create policy "orders updatable while placed" on orders
  for update using (status = 'placed') with check (true);

drop policy if exists "order items insertable by anyone" on order_items;
create policy "order items insertable by anyone" on order_items
  for insert with check (true);
drop policy if exists "order items readable by admin" on order_items;
create policy "order items readable by admin" on order_items
  for select to authenticated using (true);

drop policy if exists "toppings insertable by anyone" on order_item_toppings;
create policy "toppings insertable by anyone" on order_item_toppings
  for insert with check (true);
drop policy if exists "toppings readable by admin" on order_item_toppings;
create policy "toppings readable by admin" on order_item_toppings
  for select to authenticated using (true);

-- ---------------------------------------------------------- best sellers
-- Units sold per pizza, all-time (paid orders only — a placed-but-abandoned
-- cart shouldn't earn a pizza the "Best seller" tag). order_items is
-- admin-only (see policy above), but this view exposes nothing beyond a
-- pizza id/name and a summed quantity — no customer data, no individual
-- orders — so it is safe for the public ordering page to read. Views run
-- with the owner's privileges by default (not the querying role's), so this
-- bypasses the order_items/orders RLS restrictions without loosening them.
create or replace view best_seller_pizzas as
  select oi.pizza_id, oi.pizza_name, sum(oi.quantity)::int as total_quantity
  from order_items oi
  join orders o on o.id = oi.order_id
  where oi.pizza_id is not null and o.status = 'paid'
  group by oi.pizza_id, oi.pizza_name
  order by total_quantity desc;

grant select on best_seller_pizzas to anon, authenticated;

-- Applied via a direct Postgres connection (db:setup), not Supabase's own
-- migration UI, so PostgREST's schema/policy cache may not auto-refresh —
-- ask it to reload explicitly so new columns/policies take effect immediately.
notify pgrst, 'reload schema';
