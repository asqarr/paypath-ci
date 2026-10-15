-- Run only against a disposable Supabase test project after schema.sql.
-- The transaction is rolled back so no fixture rows remain after a successful run.
begin;

do $test$
declare
  v_user text := 'paypath-test-schema-regression';
  v_other_user text := 'paypath-test-schema-other';
  v_sub text := 'sub_schemaregression';
  v_other_sub text := 'sub_schemaother';
  v_first jsonb;
  v_duplicate jsonb;
  v_stale jsonb;
  v_conflict jsonb;
  v_cleanup jsonb;
  v_effect_count bigint;
begin
  if pg_catalog.has_function_privilege('anon', 'public.process_demo_stripe_event(text,text,text,text,text,timestamptz,boolean,bigint,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.process_demo_stripe_event(text,text,text,text,text,timestamptz,boolean,bigint,boolean,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.cleanup_demo_test_user(text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.cleanup_demo_test_user(text,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.process_demo_stripe_event(text,text,text,text,text,timestamptz,boolean,bigint,boolean,boolean)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.cleanup_demo_test_user(text,text)', 'EXECUTE') then
    raise exception 'an untrusted Supabase role can execute a PayPath RPC';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.demo_subscriptions', 'SELECT')
     or pg_catalog.has_table_privilege('authenticated', 'public.demo_subscriptions', 'SELECT')
     or not pg_catalog.has_table_privilege('service_role', 'public.demo_subscriptions', 'SELECT') then
    raise exception 'table privileges do not match the PayPath service-role policy';
  end if;
  if pg_catalog.to_regprocedure('public.process_demo_stripe_event(text,text,text,text,text,timestamptz,boolean,boolean,boolean)') is not null then
    raise exception 'the obsolete ordering-unaware RPC overload is still installed';
  end if;

  v_first := public.process_demo_stripe_event(
    'evt_schemafirst', 'customer.subscription.updated', v_user, v_sub,
    'active', pg_catalog.clock_timestamp() + interval '2 days', false,
    2000000000, false, false
  );
  if v_first->>'processed' <> 'true' or v_first->>'processed_count' <> '1' then
    raise exception 'first delivery was not processed exactly once: %', v_first;
  end if;

  v_duplicate := public.process_demo_stripe_event(
    'evt_schemafirst', 'customer.subscription.updated', v_user, v_sub,
    'active', pg_catalog.clock_timestamp() + interval '1 day', false,
    2000000000, false, false
  );
  -- Event identity includes period end; use the stored value for exact replay.
  if v_duplicate->>'conflict' <> 'true' then
    raise exception 'payload mismatch on reused event ID was not rejected';
  end if;

  v_duplicate := public.process_demo_stripe_event(
    'evt_schemafirst', 'customer.subscription.updated', v_user, v_sub,
    'active', (select current_period_end from public.demo_webhook_events where event_id = 'evt_schemafirst'), false,
    2000000000, false, false
  );
  if v_duplicate->>'duplicate' <> 'true' or v_duplicate->>'processed' <> 'false'
     or v_duplicate->>'processed_count' <> '1' then
    raise exception 'identical duplicate was not idempotent: %', v_duplicate;
  end if;
  select count(*) into v_effect_count
    from public.demo_business_effects where event_id = 'evt_schemafirst';
  if v_effect_count <> 1 then
    raise exception 'an identical duplicate created another business effect';
  end if;

  perform public.process_demo_stripe_event(
    'evt_schemanewer', 'customer.subscription.updated', v_user, v_sub,
    'canceled', pg_catalog.clock_timestamp(), false, 2000000001, false, false
  );
  v_stale := public.process_demo_stripe_event(
    'evt_schemaolder', 'customer.subscription.updated', v_user, v_sub,
    'active', pg_catalog.clock_timestamp() + interval '1 day', false, 2000000000, false, false
  );
  if v_stale->>'stale' <> 'true' or v_stale->>'processed' <> 'false'
     or (select status from public.demo_subscriptions where user_id = v_user) <> 'canceled' then
    raise exception 'old event overwrote newer subscription state: %', v_stale;
  end if;

  v_conflict := public.process_demo_stripe_event(
    'evt_schemafirst', 'customer.subscription.updated', v_user, v_sub,
    'canceled', pg_catalog.clock_timestamp(), false, 2000000000, false, false
  );
  if v_conflict->>'conflict' <> 'true' or v_conflict->>'processed' <> 'false' then
    raise exception 'event ID payload collision was not rejected';
  end if;

  perform public.process_demo_stripe_event(
    'evt_schemaother', 'customer.subscription.created', v_other_user, v_other_sub,
    'active', pg_catalog.clock_timestamp() + interval '1 day', false, 2000000002, false, false
  );
  v_cleanup := public.cleanup_demo_test_user(v_user, v_sub);
  if exists (select 1 from public.demo_subscriptions where user_id = v_user)
     or exists (select 1 from public.demo_webhook_events where user_id = v_user)
     or exists (select 1 from public.demo_entitlements where user_id = v_user)
     or not exists (select 1 from public.demo_subscriptions where user_id = v_other_user)
     or not exists (select 1 from public.demo_webhook_events where user_id = v_other_user) then
    raise exception 'cleanup escaped its exact test-user scope';
  end if;
  select count(*) into v_effect_count from public.demo_business_effects where user_id = v_other_user;
  if v_effect_count <> 1 or (v_cleanup->>'events_deleted')::integer < 3 then
    raise exception 'cleanup relationships or unrelated effect preservation failed: %', v_cleanup;
  end if;

  begin
    perform public.process_demo_stripe_event(
      'evt_baduser', 'customer.subscription.created', 'real-user-id', 'sub_baduser',
      'active', null, false, 2000000000, false, false
    );
    raise exception 'invalid test user ID was accepted';
  exception when others then
    if sqlerrm <> 'invalid PayPath test user ID' then raise; end if;
  end;
end;
$test$;

rollback;
