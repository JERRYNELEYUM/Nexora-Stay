-- ============================================================
-- Nexora Stay — Supabase schema (offline-first sync edition)
-- Run this once in your Supabase project's SQL editor
-- (Project -> SQL Editor -> New query -> paste -> Run).
--
-- This database is a SYNC TARGET, not the primary store -- the app
-- itself runs offline-first out of the browser's local storage on
-- each device, and pushes/pulls here whenever it has a connection.
-- Row Level Security is enabled with NO policies, so the anon/public
-- key can do nothing at all. Every read and write goes through the
-- Netlify Functions (push/sync), which use the service role key and
-- check a single shared SYNC_KEY before touching anything.
--
-- Every table has an `updated_at` column used for last-write-wins
-- merging: when a device pushes a record, it's only accepted if it
-- doesn't exist yet, or its updated_at is newer than what's already
-- stored. Staff PINs are NOT stored here -- PIN login is handled
-- entirely on-device, so this table only mirrors name/role/active
-- for cross-device visibility (e.g. an admin adding a new staff
-- member from one device so it shows up on others).
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- hotel settings (single row) ----------
create table if not exists hotel_settings (
  id text primary key default 'default',
  name text not null default 'Nexora Stay',
  address text default '',
  phone text default '',
  email text default '',
  taxpayer_number text default '',
  registration_number text default '',
  currency text not null default 'FCFA',
  tax_rate numeric not null default 19.25,
  updated_at timestamptz not null default now()
);
insert into hotel_settings (id) values ('default') on conflict (id) do nothing;

-- Safe to re-run this whole file on an existing database — this adds the
-- columns above if you set up your database before they existed.
alter table hotel_settings add column if not exists email text default '';
alter table hotel_settings add column if not exists taxpayer_number text default '';
alter table hotel_settings add column if not exists registration_number text default '';

-- ---------- staff (name/role mirror only -- PINs stay on-device) ----------
create table if not exists staff (
  id uuid primary key,
  name text not null,
  role text not null check (role in ('admin', 'staff')),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- room types ----------
create table if not exists room_types (
  id uuid primary key,
  name text not null,
  rate numeric not null default 0,       -- full night
  rate_1h numeric not null default 0,    -- 0 = not offered
  rate_3h numeric not null default 0,
  rate_night numeric not null default 0, -- short "all night" rate
  capacity int not null default 2,
  updated_at timestamptz not null default now()
);

-- ---------- rooms ----------
create table if not exists rooms (
  id uuid primary key,
  number text not null,
  type_id uuid references room_types(id) on delete restrict,
  status text not null default 'available' check (status in ('available', 'maintenance')),
  updated_at timestamptz not null default now()
);
create unique index if not exists rooms_number_unique on rooms (number);

-- ---------- guests ----------
create table if not exists guests (
  id uuid primary key,
  name text not null,
  phone text,
  id_number text,
  updated_at timestamptz not null default now()
);
create index if not exists guests_phone_idx on guests (phone);

-- ---------- bookings ----------
create table if not exists bookings (
  id uuid primary key,
  guest_id uuid references guests(id) on delete restrict,
  room_id uuid references rooms(id) on delete restrict,
  stay_type text not null default 'nightly' check (stay_type in ('nightly', '1hour', '3hours', 'allnight')),
  check_in timestamptz not null,
  check_out timestamptz not null,
  guests int not null default 1,
  notes text default '',
  status text not null default 'reserved' check (status in ('reserved', 'checked-in', 'checked-out', 'cancelled')),
  created_by uuid,
  updated_at timestamptz not null default now()
);
create index if not exists bookings_room_idx on bookings (room_id);
create index if not exists bookings_status_idx on bookings (status);

-- ---------- invoices ----------
create table if not exists invoices (
  id uuid primary key,
  booking_id uuid not null references bookings(id) on delete cascade,
  number text not null,
  tax_rate numeric not null default 19.25,
  discount_type text check (discount_type in ('percent', 'flat')),
  discount_value numeric,
  discount_note text default '',
  discount_applied_by text default '',
  voided boolean not null default false,
  voided_at timestamptz,
  voided_by text default '',
  void_reason text default '',
  updated_at timestamptz not null default now()
);
create unique index if not exists invoices_booking_unique on invoices (booking_id);

-- Safe to re-run this whole file on an existing database — this adds the
-- void columns above if you set up your database before they existed.
alter table invoices add column if not exists voided boolean not null default false;
alter table invoices add column if not exists voided_at timestamptz;
alter table invoices add column if not exists voided_by text default '';
alter table invoices add column if not exists void_reason text default '';

-- Safe to re-run this whole file on an existing database — this adds the
-- discount columns above if you set up your database before they existed.
alter table invoices add column if not exists discount_type text;
alter table invoices add column if not exists discount_value numeric;
alter table invoices add column if not exists discount_note text default '';
alter table invoices add column if not exists discount_applied_by text default '';

create table if not exists invoice_charges (
  id uuid primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  description text not null,
  amount numeric not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists invoice_payments (
  id uuid primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  amount numeric not null default 0,
  method text not null default 'Cash',
  paid_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- payroll: employees (salaried staff, not necessarily
--            app login accounts) and their salary payments ----------
create table if not exists employees (
  id uuid primary key,
  name text not null,
  role text not null default '',
  phone text,
  monthly_salary numeric not null default 0,
  status text not null default 'active' check (status in ('active', 'left')),
  date_joined date,
  updated_at timestamptz not null default now()
);

create table if not exists salary_payments (
  id uuid primary key,
  employee_id uuid references employees(id) on delete restrict,
  month text not null,
  amount_due numeric not null default 0,
  amount_paid numeric not null default 0,
  date date not null,
  method text not null default 'Cash',
  note text default '',
  updated_at timestamptz not null default now()
);

-- ---------- spending: general hotel expenses ----------
create table if not exists expenses (
  id uuid primary key,
  date date not null,
  category text not null default 'Other',
  description text not null,
  amount numeric not null default 0,
  method text not null default 'Cash',
  vendor text default '',
  recorded_by text default '',
  updated_at timestamptz not null default now()
);
alter table expenses add column if not exists recorded_by text default '';

-- ---------- cash/bank deposits — money moved out of the till, tracked
--            separately from expenses since it's a transfer, not a spend ----------
create table if not exists deposits (
  id uuid primary key,
  date date not null,
  amount numeric not null default 0,
  method text not null default 'Cash',
  destination text default '',
  note text default '',
  updated_at timestamptz not null default now()
);

-- ---------- lock everything down; only the service role (used by
--            Netlify Functions) can bypass RLS and read/write ----------
alter table hotel_settings enable row level security;
alter table staff enable row level security;
alter table room_types enable row level security;
alter table rooms enable row level security;
alter table guests enable row level security;
alter table bookings enable row level security;
alter table invoices enable row level security;
alter table invoice_charges enable row level security;
alter table invoice_payments enable row level security;
alter table employees enable row level security;
alter table salary_payments enable row level security;
alter table expenses enable row level security;
alter table deposits enable row level security;
-- No policies are created, so anon/authenticated roles have zero access.
