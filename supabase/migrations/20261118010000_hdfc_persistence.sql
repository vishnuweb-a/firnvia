-- HDFC persistence: additive columns + two atomic write functions for the backend.
-- Additive only: no table is dropped or recreated, no existing row is touched.
-- Apply BEFORE setting HDFC_DB_ENABLED=true. Safe to re-run.

begin;

-- ── Columns needed for restart recovery and crash-safe initiation ───────────
alter table public.hdfc_payment_attempts
  -- sha256-derived customer reference (x-customerid for the Order Status API); not an email.
  add column if not exists customer_ref text
    check (customer_ref is null or customer_ref ~ '^[A-Za-z0-9]{1,64}$'),
  -- HDFC's own order object id (e.g. "ordeh_..."), returned by POST /session.
  add column if not exists provider_order_ref text
    check (provider_order_ref is null or length(provider_order_ref) between 1 and 128),
  -- payment_filter options sent on the session (UPI, or UPI+CARD in sandbox card-test mode).
  add column if not exists allowed_payment_methods text[] not null default '{UPI}'
    check (allowed_payment_methods <@ array['UPI', 'CARD']::text[] and cardinality(allowed_payment_methods) > 0),
  add column if not exists provider_created_at timestamptz, -- Order Status date_created
  add column if not exists provider_updated_at timestamptz, -- Order Status last_updated
  -- Our POST /session failed ("timeout", "http_400", ...). HDFC may still hold the order on timeout.
  add column if not exists session_error text
    check (session_error is null or session_error ~ '^[a-z0-9_]{1,40}$'),
  -- Why `conflicted` was set: duplicate_charge, non_upi, mismatch_amount, refunded_after_charge, ...
  add column if not exists conflict_reason text
    check (conflict_reason is null or conflict_reason ~ '^[a-z0-9_]{1,40}$');

-- ── Begin an attempt: order + product snapshot + attempt + history, atomically ──
-- Called BEFORE POST /session, so a payment link never exists without a durable record.
-- The order row lock serializes concurrent initiations; expected_previous_attempt
-- is an optimistic check that the caller reconciled the latest attempt it saw.
create or replace function public.hdfc_begin_attempt(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order   public.hdfc_orders;
  v_amount  numeric(12,2) := (p->>'expected_amount')::numeric;
  v_last    integer;
  v_status  text;
  v_attempt uuid;
begin
  insert into public.hdfc_orders (website_order_id, merchant_id, expected_amount, currency)
  values (p->>'website_order_id', p->>'merchant_id', v_amount, 'INR')
  on conflict (website_order_id) do nothing;

  select * into v_order from public.hdfc_orders
  where website_order_id = p->>'website_order_id'
  for update;

  if v_order.expected_amount <> v_amount or v_order.merchant_id <> p->>'merchant_id'
     or (p->>'transaction_amount')::numeric <> v_amount then
    raise exception 'hdfc_order_mismatch' using errcode = 'P0001';
  end if;
  if v_order.order_status = 'paid' then
    raise exception 'hdfc_order_paid' using errcode = 'P0001';
  end if;

  -- Snapshot once per website order; it must add up to the order total.
  if not exists (select 1 from public.hdfc_order_items where order_id = v_order.id) then
    insert into public.hdfc_order_items (order_id, product_name, product_type, sku, quantity, unit_price, total_price)
    select v_order.id, i.product_name, i.product_type, i.sku, i.quantity, i.unit_price, i.unit_price * i.quantity
    from jsonb_to_recordset(coalesce(p->'items', '[]'::jsonb))
      as i(product_name text, product_type text, sku text, quantity integer, unit_price numeric);
    if (select coalesce(sum(total_price), 0) from public.hdfc_order_items where order_id = v_order.id) <> v_amount then
      raise exception 'hdfc_items_total_mismatch' using errcode = 'P0001';
    end if;
  end if;

  select attempt_number, transaction_status into v_last, v_status
  from public.hdfc_payment_attempts where order_id = v_order.id
  order by attempt_number desc limit 1;
  v_last := coalesce(v_last, 0);

  if v_last <> (p->>'expected_previous_attempt')::integer then
    raise exception 'hdfc_attempt_conflict' using errcode = 'P0001';
  end if;
  -- Backstop: never open a new attempt while the last one may still complete.
  if v_status in ('PENDING', 'PENDING_VBV', 'AUTHORIZING', 'CHARGED') then
    raise exception 'hdfc_attempt_unresolved' using errcode = 'P0001';
  end if;

  insert into public.hdfc_payment_attempts
    (order_id, hdfc_order_id, attempt_number, transaction_amount, currency, gateway_environment,
     customer_ref, allowed_payment_methods)
  values
    (v_order.id, p->>'hdfc_order_id', v_last + 1, v_amount, 'INR', p->>'gateway_environment',
     p->>'customer_ref', array(select jsonb_array_elements_text(p->'allowed_payment_methods')))
  returning id into v_attempt;

  insert into public.hdfc_status_history (payment_attempt_id, previous_status, new_status, event_source, event_timestamp)
  values (v_attempt, null, 'NEW', 'session_create', now());

  update public.hdfc_orders set order_status = 'pending'
  where id = v_order.id and order_status <> 'pending';

  return jsonb_build_object('attempt_number', v_last + 1);
end;
$$;

-- ── Apply an Order-Status-API-verified state to one attempt, atomically ─────
-- Compare-and-set on transaction_status: a stale or duplicate writer gets
-- applied=false and nothing changes. History is written only on a real change,
-- so duplicate returns/webhooks add no rows. An order becomes 'paid' only from a
-- verified CHARGED attempt and is never downgraded.
create or replace function public.hdfc_apply_status(p jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_a        public.hdfc_payment_attempts;
  v_new      text    := p->>'transaction_status';
  v_verified boolean := coalesce((p->>'verified')::boolean, false) and v_new = 'CHARGED';
  v_latest   integer;
begin
  select * into v_a from public.hdfc_payment_attempts
  where hdfc_order_id = p->>'hdfc_order_id'
  for update;
  if not found then
    raise exception 'hdfc_attempt_not_found' using errcode = 'P0001';
  end if;

  if v_a.transaction_status <> p->>'expected_status'
     or (v_a.transaction_status = 'CHARGED' and v_new not in ('CHARGED', 'AUTO_REFUNDED')) then
    return jsonb_build_object('applied', false, 'current', v_a.transaction_status);
  end if;

  update public.hdfc_payment_attempts set
    transaction_status  = v_new,
    hdfc_status_id      = coalesce((p->>'hdfc_status_id')::integer, hdfc_status_id),
    payment_method_type = coalesce(p->>'payment_method_type', payment_method_type),
    payment_method      = coalesce(p->>'payment_method', payment_method),
    hdfc_transaction_id = coalesce(p->>'hdfc_transaction_id', hdfc_transaction_id),
    error_code          = p->>'error_code',
    provider_created_at = coalesce(provider_created_at, (p->>'provider_created_at')::timestamptz),
    provider_updated_at = coalesce((p->>'provider_updated_at')::timestamptz, provider_updated_at),
    conflicted          = conflicted or coalesce((p->>'conflicted')::boolean, false),
    conflict_reason     = coalesce(conflict_reason, p->>'conflict_reason'),
    verified_at         = case when v_verified then coalesce(verified_at, now()) end
  where id = v_a.id;

  if v_new <> v_a.transaction_status then
    insert into public.hdfc_status_history (payment_attempt_id, previous_status, new_status, event_source, event_timestamp)
    values (v_a.id, v_a.transaction_status, v_new, p->>'event_source',
            coalesce((p->>'provider_updated_at')::timestamptz, now()));
  end if;

  if v_verified then
    update public.hdfc_orders set order_status = 'paid'
    where id = v_a.order_id and order_status <> 'paid';
  elsif p->>'order_status' in ('pending', 'failed') then
    select max(attempt_number) into v_latest from public.hdfc_payment_attempts where order_id = v_a.order_id;
    if v_a.attempt_number = v_latest then -- only the latest attempt decides an open order
      update public.hdfc_orders set order_status = p->>'order_status'
      where id = v_a.order_id and order_status not in ('paid', p->>'order_status');
    end if;
  end if;

  return jsonb_build_object('applied', true, 'changed', v_new <> v_a.transaction_status);
end;
$$;

-- ── Security: backend (service_role) only ───────────────────────────────────
-- public's default ACL grants EXECUTE on new functions to anon/authenticated; revoke it.
revoke all on function public.hdfc_begin_attempt(jsonb), public.hdfc_apply_status(jsonb)
  from public, anon, authenticated;
grant execute on function public.hdfc_begin_attempt(jsonb), public.hdfc_apply_status(jsonb) to service_role;

commit;
