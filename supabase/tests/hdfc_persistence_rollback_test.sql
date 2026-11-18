-- Rolled-back verification of 20261118010000_hdfc_persistence.sql.
-- Usage: node supabase/tests/run-hdfc-sql-test.mjs  (builds: begin; <migration body>; <this file>)
-- The DO block ALWAYS ends by raising, so the migration and every test row are
-- rolled back. Success = error text "HDFC_SQL_TESTS_PASSED". Nothing persists.

do $$
declare
  r jsonb;
  n integer;
  o public.hdfc_orders;
  a public.hdfc_payment_attempts;
  base jsonb := jsonb_build_object(
    'website_order_id', 'FIR-sqltest-A', 'merchant_id', 'TESTMID', 'expected_amount', '1498.00',
    'transaction_amount', '1498.00', 'gateway_environment', 'sandbox', 'customer_ref', 'cabc123',
    'allowed_payment_methods', '["UPI"]'::jsonb, 'expected_previous_attempt', 0,
    'items', '[{"product_name":"Technical Website Audit","product_type":"service","sku":"technical-website-audit","quantity":2,"unit_price":499},
               {"product_name":"WordPress Error Fixing","product_type":"service","sku":"wordpress-error-fixing","quantity":1,"unit_price":500}]'::jsonb);
  st jsonb := jsonb_build_object('event_source', 'order_status_api', 'verified', false);
begin
  set local role service_role;

  -- 1. first attempt: order + snapshot + attempt + NEW history, in one call
  r := public.hdfc_begin_attempt(base || jsonb_build_object('hdfc_order_id', 'FIRsqltestA1'));
  assert (r->>'attempt_number')::int = 1, 'attempt 1';
  select * into o from public.hdfc_orders where website_order_id = 'FIR-sqltest-A';
  assert o.order_status = 'pending' and o.expected_amount = 1498.00 and o.currency = 'INR', 'order row';
  select count(*) into n from public.hdfc_order_items where order_id = o.id and sku = 'technical-website-audit' and quantity = 2 and total_price = 998.00;
  assert n = 1, 'snapshot line 1';
  select count(*) into n from public.hdfc_order_items where order_id = o.id;
  assert n = 2, 'snapshot has 2 lines';
  select * into a from public.hdfc_payment_attempts where hdfc_order_id = 'FIRsqltestA1';
  assert a.customer_ref = 'cabc123' and a.allowed_payment_methods = '{UPI}' and a.transaction_status = 'NEW', 'attempt row';
  select count(*) into n from public.hdfc_status_history where payment_attempt_id = a.id and previous_status is null and new_status = 'NEW' and event_source = 'session_create';
  assert n = 1, 'NEW history';

  -- 2. concurrent initiation: a second caller that also saw 0 attempts loses
  begin
    perform public.hdfc_begin_attempt(base || jsonb_build_object('hdfc_order_id', 'FIRsqltestA9'));
    raise exception 'no conflict';
  exception when others then if sqlerrm <> 'hdfc_attempt_conflict' then raise; end if;
  end;
  -- 3. amount tampering / mismatch
  begin
    perform public.hdfc_begin_attempt(base || jsonb_build_object('hdfc_order_id', 'FIRsqltestA9', 'expected_amount', '1.00', 'transaction_amount', '1.00', 'expected_previous_attempt', 1));
    raise exception 'no mismatch';
  exception when others then if sqlerrm <> 'hdfc_order_mismatch' then raise; end if;
  end;

  -- 4. NEW -> PENDING (webhook): applied + history
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA1', 'expected_status', 'NEW',
         'transaction_status', 'PENDING', 'order_status', 'pending', 'event_source', 'webhook', 'payment_method_type', 'UPI'));
  assert (r->>'applied')::boolean and (r->>'changed')::boolean, 'pending applied';
  -- 5. no new attempt while one is in flight
  begin
    perform public.hdfc_begin_attempt(base || jsonb_build_object('hdfc_order_id', 'FIRsqltestA2', 'expected_previous_attempt', 1));
    raise exception 'no unresolved';
  exception when others then if sqlerrm <> 'hdfc_attempt_unresolved' then raise; end if;
  end;
  -- 6. stale / duplicate writer (still thinks NEW) changes nothing
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA1', 'expected_status', 'NEW',
         'transaction_status', 'AUTHORIZATION_FAILED', 'order_status', 'failed'));
  assert not (r->>'applied')::boolean and r->>'current' = 'PENDING', 'stale rejected';

  -- 7. PENDING -> AUTHENTICATION_FAILED: order failed, error code kept
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA1', 'expected_status', 'PENDING',
         'transaction_status', 'AUTHENTICATION_FAILED', 'order_status', 'failed', 'error_code', 'ZM', 'hdfc_status_id', 26,
         'hdfc_transaction_id', 'FIRsqltestA1-1', 'provider_updated_at', '2026-11-18T10:00:00Z'));
  assert (r->>'applied')::boolean, 'failed applied';
  select order_status into o.order_status from public.hdfc_orders where id = o.id;
  assert o.order_status = 'failed', 'order failed';
  select * into a from public.hdfc_payment_attempts where hdfc_order_id = 'FIRsqltestA1';
  assert a.error_code = 'ZM' and a.hdfc_status_id = 26 and a.hdfc_transaction_id = 'FIRsqltestA1-1' and a.verified_at is null, 'failed fields';
  select count(*) into n from public.hdfc_status_history where payment_attempt_id = a.id
    and event_timestamp = '2026-11-18T10:00:00Z' and previous_status = 'PENDING' and new_status = 'AUTHENTICATION_FAILED';
  assert n = 1, 'failed history uses provider timestamp';

  -- 8. retry: attempt 2 does not overwrite attempt 1; order back to pending
  r := public.hdfc_begin_attempt(base || jsonb_build_object('hdfc_order_id', 'FIRsqltestA2', 'expected_previous_attempt', 1));
  assert (r->>'attempt_number')::int = 2, 'attempt 2';
  select count(*) into n from public.hdfc_payment_attempts where order_id = o.id;
  assert n = 2, 'two attempts kept';
  select count(*) into n from public.hdfc_order_items where order_id = o.id;
  assert n = 2, 'snapshot not duplicated on retry';
  select order_status into o.order_status from public.hdfc_orders where id = o.id;
  assert o.order_status = 'pending', 'order pending on retry';

  -- 9. late update on the OLD attempt never decides the open order
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA1', 'expected_status', 'AUTHENTICATION_FAILED',
         'transaction_status', 'JUSPAY_DECLINED', 'order_status', 'failed'));
  select order_status into o.order_status from public.hdfc_orders where id = o.id;
  assert o.order_status = 'pending', 'old attempt does not fail order';

  -- 10. verified CHARGED: order paid
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA2', 'expected_status', 'NEW',
         'transaction_status', 'CHARGED', 'order_status', 'paid', 'verified', true, 'event_source', 'return_url',
         'payment_method_type', 'UPI', 'payment_method', 'UPI_COLLECT', 'hdfc_transaction_id', 'FIRsqltestA2-1', 'hdfc_status_id', 21));
  select * into a from public.hdfc_payment_attempts where hdfc_order_id = 'FIRsqltestA2';
  select order_status into o.order_status from public.hdfc_orders where id = o.id;
  assert a.verified_at is not null and a.payment_method = 'UPI_COLLECT' and o.order_status = 'paid', 'paid';
  select count(*) into n from public.hdfc_status_history where payment_attempt_id = a.id;
  assert n = 2, 'NEW + CHARGED history';

  -- 11. duplicate webhook for the same CHARGED: applied, unchanged, no new history
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA2', 'expected_status', 'CHARGED',
         'transaction_status', 'CHARGED', 'order_status', 'paid', 'verified', true, 'event_source', 'webhook'));
  assert (r->>'applied')::boolean and not (r->>'changed')::boolean, 'dup idempotent';
  select count(*) into n from public.hdfc_status_history where payment_attempt_id = a.id;
  assert n = 2, 'no duplicate history';
  -- 12. CHARGED never moves back to pending
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA2', 'expected_status', 'CHARGED',
         'transaction_status', 'PENDING', 'order_status', 'pending'));
  assert not (r->>'applied')::boolean, 'no downgrade';
  -- 13. no new attempt on a paid order
  begin
    perform public.hdfc_begin_attempt(base || jsonb_build_object('hdfc_order_id', 'FIRsqltestA3', 'expected_previous_attempt', 2));
    raise exception 'no paid';
  exception when others then if sqlerrm <> 'hdfc_order_paid' then raise; end if;
  end;
  -- 14. paid order never downgraded by a failure; conflict flag recorded
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestA2', 'expected_status', 'CHARGED',
         'transaction_status', 'AUTO_REFUNDED', 'order_status', 'paid', 'conflicted', true, 'conflict_reason', 'refunded_after_charge'));
  select * into a from public.hdfc_payment_attempts where hdfc_order_id = 'FIRsqltestA2';
  select order_status into o.order_status from public.hdfc_orders where id = o.id;
  assert o.order_status = 'paid' and a.verified_at is null and a.conflicted and a.conflict_reason = 'refunded_after_charge', 'refund flagged';

  -- 15. CARD (UAT) attempt recorded
  r := public.hdfc_begin_attempt(base || jsonb_build_object('website_order_id', 'FIR-sqltest-C', 'hdfc_order_id', 'FIRsqltestC1',
         'allowed_payment_methods', '["UPI","CARD"]'::jsonb));
  r := public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'FIRsqltestC1', 'expected_status', 'NEW',
         'transaction_status', 'CHARGED', 'order_status', 'paid', 'verified', true, 'payment_method_type', 'CARD', 'payment_method', 'VISA'));
  select * into a from public.hdfc_payment_attempts where hdfc_order_id = 'FIRsqltestC1';
  assert a.payment_method_type = 'CARD' and a.allowed_payment_methods = '{UPI,CARD}' and a.verified_at is not null, 'card';

  -- 16. snapshot that does not add up: nothing is created
  begin
    perform public.hdfc_begin_attempt(base || jsonb_build_object('website_order_id', 'FIR-sqltest-D', 'hdfc_order_id', 'FIRsqltestD1',
      'items', '[{"product_name":"X","product_type":"service","sku":"x","quantity":1,"unit_price":1}]'::jsonb));
    raise exception 'no items mismatch';
  exception when others then if sqlerrm <> 'hdfc_items_total_mismatch' then raise; end if;
  end;
  select count(*) into n from public.hdfc_orders where website_order_id = 'FIR-sqltest-D';
  assert n = 0, 'mismatched snapshot left no order';

  -- 17. unknown attempt
  begin
    perform public.hdfc_apply_status(st || jsonb_build_object('hdfc_order_id', 'nope', 'expected_status', 'NEW', 'transaction_status', 'CHARGED'));
    raise exception 'no nf';
  exception when others then if sqlerrm <> 'hdfc_attempt_not_found' then raise; end if;
  end;

  -- 18. history append-only, even for the backend role
  begin
    update public.hdfc_status_history set new_status = 'CHARGED';
    raise exception 'history mutable';
  exception when others then if sqlerrm not like 'hdfc_status_history is append-only%' and sqlstate <> '42501' then raise; end if;
  end;

  -- 19. anon / authenticated cannot execute the functions or read tables
  reset role;
  set local role anon;
  begin
    perform public.hdfc_apply_status('{}'::jsonb);
    raise exception 'anon executed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.hdfc_orders limit 1;
    raise exception 'anon read';
  exception when insufficient_privilege then null;
  end;
  reset role;
  set local role authenticated;
  begin
    perform public.hdfc_begin_attempt('{}'::jsonb);
    raise exception 'authenticated executed';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise exception 'HDFC_SQL_TESTS_PASSED';
end;
$$;
