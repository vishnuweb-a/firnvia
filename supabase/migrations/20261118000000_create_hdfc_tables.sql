-- HDFC SmartGateway transaction store (project azqxremgccowthlmphhi, merchant SG6601).
-- Backend-only: RLS on, no policies, anon/authenticated revoked; service_role (BYPASSRLS) is the only client.
-- No card numbers, CVVs, passwords or customer PII are stored anywhere in this schema.

begin;

-- Shared updated_at trigger function.
create or replace function public.hdfc_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- History is evidence: rows may be added, never changed or removed.
create or replace function public.hdfc_block_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'hdfc_status_history is append-only (% blocked)', tg_op;
end;
$$;

-- ── Website order (one per checkout) ────────────────────────────────────────
create table public.hdfc_orders (
  id               uuid primary key default gen_random_uuid(),
  website_order_id text not null unique check (length(website_order_id) between 1 and 64),
  merchant_id      text not null check (length(merchant_id) between 1 and 64),
  expected_amount  numeric(12,2) not null check (expected_amount > 0),
  currency         char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  order_status     text not null default 'pending' check (order_status in ('pending', 'paid', 'failed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── One row per HDFC session; many per website order ────────────────────────
create table public.hdfc_payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references public.hdfc_orders(id) on delete restrict,
  hdfc_order_id       text not null unique check (hdfc_order_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  hdfc_transaction_id text unique check (hdfc_transaction_id is null or length(hdfc_transaction_id) between 1 and 128),
  attempt_number      integer not null check (attempt_number > 0),
  payment_method_type text not null default 'UNKNOWN' check (payment_method_type in ('UPI', 'CARD', 'UNKNOWN')),
  payment_method      text check (payment_method is null or length(payment_method) <= 64), -- e.g. UPI_COLLECT, VISA; never a card number
  transaction_amount  numeric(12,2) not null check (transaction_amount > 0),
  currency            char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  transaction_status  text not null default 'NEW' check (transaction_status ~ '^[A-Z0-9_]{1,40}$'), -- raw HDFC status
  hdfc_status_id      integer,
  error_code          text check (error_code is null or length(error_code) <= 60),
  conflicted          boolean not null default false,
  gateway_environment text not null check (gateway_environment in ('sandbox', 'production')),
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (order_id, attempt_number),
  -- verified_at is only set once HDFC's Order Status API confirmed CHARGED
  check (verified_at is null or transaction_status = 'CHARGED')
);
-- PostgreSQL UNIQUE treats NULLs as distinct, so hdfc_transaction_id is unique only when present.

-- ── Product snapshot at purchase time (independent of the live catalog) ─────
create table public.hdfc_order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.hdfc_orders(id) on delete restrict,
  product_name text not null check (length(product_name) between 1 and 200),
  product_type text not null check (length(product_type) between 1 and 50),
  sku          text check (sku is null or length(sku) between 1 and 64),
  quantity     integer not null check (quantity > 0),
  unit_price   numeric(12,2) not null check (unit_price >= 0),
  total_price  numeric(12,2) not null check (total_price >= 0),
  created_at   timestamptz not null default now(),
  check (total_price = unit_price * quantity)
);

-- ── Append-only status trail per attempt (success and failure alike) ─────────
create table public.hdfc_status_history (
  id                 uuid primary key default gen_random_uuid(),
  payment_attempt_id uuid not null references public.hdfc_payment_attempts(id) on delete restrict,
  previous_status    text check (previous_status is null or previous_status ~ '^[A-Z0-9_]{1,40}$'),
  new_status         text not null check (new_status ~ '^[A-Z0-9_]{1,40}$'),
  event_source       text not null check (event_source in ('session_create', 'return_url', 'webhook', 'order_status_api', 'reconciliation', 'manual')),
  event_timestamp    timestamptz not null,
  created_at         timestamptz not null default now()
);

-- ── Indexes (unique constraints above already index their columns) ──────────
create index hdfc_orders_status_created_idx        on public.hdfc_orders (order_status, created_at desc);
create index hdfc_payment_attempts_order_idx        on public.hdfc_payment_attempts (order_id);
create index hdfc_payment_attempts_status_idx       on public.hdfc_payment_attempts (transaction_status, created_at desc);
create index hdfc_payment_attempts_conflicted_idx   on public.hdfc_payment_attempts (created_at desc) where conflicted;
create index hdfc_order_items_order_idx             on public.hdfc_order_items (order_id);
create index hdfc_status_history_attempt_ts_idx     on public.hdfc_status_history (payment_attempt_id, event_timestamp);

-- ── Triggers ─────────────────────────────────────────────────────────────────
create trigger hdfc_orders_set_updated_at
  before update on public.hdfc_orders
  for each row execute function public.hdfc_set_updated_at();
create trigger hdfc_payment_attempts_set_updated_at
  before update on public.hdfc_payment_attempts
  for each row execute function public.hdfc_set_updated_at();
create trigger hdfc_status_history_append_only
  before update or delete on public.hdfc_status_history
  for each row execute function public.hdfc_block_history_mutation();
create trigger hdfc_status_history_no_truncate
  before truncate on public.hdfc_status_history
  for each statement execute function public.hdfc_block_history_mutation();

-- ── Security: backend (service_role) only ───────────────────────────────────
alter table public.hdfc_orders           enable row level security;
alter table public.hdfc_payment_attempts enable row level security;
alter table public.hdfc_order_items      enable row level security;
alter table public.hdfc_status_history   enable row level security;
-- No policies are created: anon/authenticated get zero rows even if a grant slips back in.

revoke all on public.hdfc_orders, public.hdfc_payment_attempts, public.hdfc_order_items, public.hdfc_status_history
  from public, anon, authenticated, service_role;
grant select, insert, update on public.hdfc_orders, public.hdfc_payment_attempts to service_role;
grant select, insert         on public.hdfc_order_items, public.hdfc_status_history to service_role;

revoke all on function public.hdfc_set_updated_at(), public.hdfc_block_history_mutation() from public, anon, authenticated;

commit;
