-- PayPath Demo schema hardening migration.
-- Apply only to a dedicated disposable Supabase test project, as postgres.
-- This migration is intentionally not executed by the application or test suite.

begin;

-- Fail before any DDL if this is not the expected SQL Editor/admin context.
do $preflight$
begin
  if current_user <> 'postgres' then
    raise exception 'apply this schema as the Supabase postgres role';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_roles
     where rolname = current_user and rolcreaterole
  ) then
    raise exception 'the postgres role needs CREATEROLE to prepare the PayPath RPC owner';
  end if;
end;
$preflight$;

-- Use a non-login, least-privilege owner for SECURITY DEFINER RPCs. The role gets
-- explicit access only to the four PayPath demo tables and is subject to their
-- RLS policies. It has no login, superuser, or RLS-bypass capability.
do $role$
declare
  v_existing_role pg_catalog.pg_roles%rowtype;
begin
  select * into v_existing_role
    from pg_catalog.pg_roles
   where rolname = 'paypath_rpc_owner';

  if not found then
    create role paypath_rpc_owner
      nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  else
    -- CREATEROLE on Supabase is not superuser. Refuse an unsafe pre-existing
    -- role rather than attempting protected SUPERUSER/REPLICATION/BYPASSRLS
    -- changes that hosted Postgres may reject.
    if v_existing_role.rolsuper
       or v_existing_role.rolcreatedb
       or v_existing_role.rolcreaterole
       or v_existing_role.rolreplication
       or v_existing_role.rolbypassrls then
      raise exception 'existing paypath_rpc_owner has elevated attributes; review it manually before applying this schema';
    end if;
    alter role paypath_rpc_owner nologin noinherit;
  end if;
end;
$role$;

revoke paypath_rpc_owner from anon, authenticated, service_role;
-- Do not silently revoke memberships granted to unrelated roles. On a fresh
-- project this role has no members; if a pre-existing role has unexpected
-- members, stop and require an explicit review instead of changing them.
do $membership_guard$
declare
  v_unexpected_member text;
begin
  select member_role.rolname
    into v_unexpected_member
      from pg_catalog.pg_auth_members as m
      join pg_catalog.pg_roles as owner_role on owner_role.oid = m.roleid
      join pg_catalog.pg_roles as member_role on member_role.oid = m.member
     where owner_role.rolname = 'paypath_rpc_owner'
       and member_role.rolname <> 'postgres'
     limit 1;
  if v_unexpected_member is not null then
    raise exception 'paypath_rpc_owner has unexpected member %; review role membership before applying this schema',
      v_unexpected_member;
  end if;
end;
$membership_guard$;

create table if not exists public.demo_subscriptions (
  user_id text primary key,
  stripe_subscription_id text not null unique,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_event_created_at bigint,
  last_event_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.demo_entitlements (
  user_id text primary key,
  pro_access boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.demo_webhook_events (
  event_id text primary key,
  event_type text not null,
  user_id text not null,
  subscription_id text not null,
  event_created_at bigint,
  event_status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  delivery_count integer not null default 1 check (delivery_count > 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  stale boolean not null default false,
  ordering_ambiguous boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.demo_business_effects (
  id bigint generated always as identity primary key,
  event_id text not null,
  user_id text not null,
  effect_type text not null check (effect_type in ('entitlement_granted', 'entitlement_revoked')),
  created_at timestamptz not null default now()
);

-- Additive migration for installations created by the earlier Phase 1 schema.
alter table public.demo_subscriptions
  add column if not exists last_event_created_at bigint,
  add column if not exists last_event_id text;
alter table public.demo_webhook_events
  add column if not exists event_created_at bigint,
  add column if not exists event_status text,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean,
  add column if not exists stale boolean not null default false,
  add column if not exists ordering_ambiguous boolean not null default false;
alter table public.demo_webhook_events alter column processed_count set default 0;

-- Existing rows predate Stripe event ordering metadata. Use their receive time as
-- a migration baseline; operators should clear/reseed the disposable test data.
update public.demo_webhook_events
   set event_created_at = floor(extract(epoch from received_at))::bigint
 where event_created_at is null;

with latest_events as (
  select distinct on (e.user_id)
         e.user_id, e.subscription_id, e.event_created_at, e.event_id
    from public.demo_webhook_events as e
   order by e.user_id, e.event_created_at desc, e.received_at desc, e.event_id desc
)
update public.demo_subscriptions as s
   set last_event_created_at = coalesce(
         (select e.event_created_at
            from latest_events as e
           where e.user_id = s.user_id
             and e.subscription_id = s.stripe_subscription_id),
         floor(extract(epoch from s.updated_at))::bigint
       ),
       last_event_id = (
         select e.event_id
           from latest_events as e
          where e.user_id = s.user_id
            and e.subscription_id = s.stripe_subscription_id
       )
 where s.last_event_created_at is null;

alter table public.demo_webhook_events alter column event_created_at set not null;
alter table public.demo_subscriptions alter column last_event_created_at set not null;

create index if not exists demo_business_effects_event_id_idx
  on public.demo_business_effects(event_id);
create index if not exists demo_webhook_events_user_subscription_idx
  on public.demo_webhook_events(user_id, subscription_id);

-- Constraints are added by name so this file can be reapplied after a partial run.
do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_subscriptions'::regclass and conname = 'demo_subscriptions_user_id_test_format') then
    alter table public.demo_subscriptions add constraint demo_subscriptions_user_id_test_format
      check (user_id ~ '^paypath-test-[A-Za-z0-9_-]{3,220}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_subscriptions'::regclass and conname = 'demo_subscriptions_id_test_format') then
    alter table public.demo_subscriptions add constraint demo_subscriptions_id_test_format
      check (length(stripe_subscription_id) <= 255 and stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_subscriptions'::regclass and conname = 'demo_subscriptions_status_supported') then
    alter table public.demo_subscriptions add constraint demo_subscriptions_status_supported
      check (status in ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_subscriptions'::regclass and conname = 'demo_subscriptions_last_event_positive') then
    alter table public.demo_subscriptions add constraint demo_subscriptions_last_event_positive
      check (last_event_created_at > 0 and last_event_created_at <= 9007199254740991);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_subscriptions'::regclass and conname = 'demo_subscriptions_last_event_id_format') then
    alter table public.demo_subscriptions add constraint demo_subscriptions_last_event_id_format
      check (last_event_id is null or (length(last_event_id) <= 255 and last_event_id ~ '^evt_[A-Za-z0-9]+$'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_entitlements'::regclass and conname = 'demo_entitlements_user_id_test_format') then
    alter table public.demo_entitlements add constraint demo_entitlements_user_id_test_format
      check (user_id ~ '^paypath-test-[A-Za-z0-9_-]{3,220}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_event_id_format') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_event_id_format
      check (length(event_id) <= 255 and event_id ~ '^evt_[A-Za-z0-9]+$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_event_type_supported') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_event_type_supported
      check (event_type in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_user_id_test_format') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_user_id_test_format
      check (user_id ~ '^paypath-test-[A-Za-z0-9_-]{3,220}$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_subscription_id_format') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_subscription_id_format
      check (length(subscription_id) <= 255 and subscription_id ~ '^sub_[A-Za-z0-9]+$');
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_created_positive') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_created_positive
      check (event_created_at > 0 and event_created_at <= 9007199254740991);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_status_supported') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_status_supported
      check (event_status is null or event_status in ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_webhook_events'::regclass and conname = 'demo_webhook_events_event_user_unique') then
    alter table public.demo_webhook_events add constraint demo_webhook_events_event_user_unique unique (event_id, user_id);
  end if;
end;
$constraints$;

-- Replace the old single-column FK with a composite cascading FK. This both
-- verifies the effect belongs to the same test user as its event and makes
-- scoped event cleanup relationally complete.
do $foreign_keys$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname
      from pg_catalog.pg_constraint as c
     where c.conrelid = 'public.demo_business_effects'::regclass
       and c.confrelid = 'public.demo_webhook_events'::regclass
       and c.contype = 'f'
  loop
    execute pg_catalog.format('alter table public.demo_business_effects drop constraint %I', v_constraint.conname);
  end loop;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.demo_business_effects'::regclass and conname = 'demo_business_effects_event_user_fk') then
    alter table public.demo_business_effects
      add constraint demo_business_effects_event_user_fk
      foreign key (event_id, user_id)
      references public.demo_webhook_events(event_id, user_id)
      on delete cascade;
  end if;
end;
$foreign_keys$;

alter table public.demo_subscriptions enable row level security;
alter table public.demo_entitlements enable row level security;
alter table public.demo_webhook_events enable row level security;
alter table public.demo_business_effects enable row level security;

drop policy if exists demo_subscriptions_paypath_rpc_owner on public.demo_subscriptions;
create policy demo_subscriptions_paypath_rpc_owner on public.demo_subscriptions
  for all to paypath_rpc_owner using (true) with check (true);
drop policy if exists demo_entitlements_paypath_rpc_owner on public.demo_entitlements;
create policy demo_entitlements_paypath_rpc_owner on public.demo_entitlements
  for all to paypath_rpc_owner using (true) with check (true);
drop policy if exists demo_webhook_events_paypath_rpc_owner on public.demo_webhook_events;
create policy demo_webhook_events_paypath_rpc_owner on public.demo_webhook_events
  for all to paypath_rpc_owner using (true) with check (true);
drop policy if exists demo_business_effects_paypath_rpc_owner on public.demo_business_effects;
create policy demo_business_effects_paypath_rpc_owner on public.demo_business_effects
  for all to paypath_rpc_owner using (true) with check (true);

revoke all on public.demo_subscriptions, public.demo_entitlements,
  public.demo_webhook_events, public.demo_business_effects from public, anon, authenticated;
revoke all on public.demo_subscriptions, public.demo_entitlements,
  public.demo_webhook_events, public.demo_business_effects from service_role;
grant select, insert, update, delete on public.demo_subscriptions, public.demo_entitlements,
  public.demo_webhook_events, public.demo_business_effects to paypath_rpc_owner;
grant select on public.demo_subscriptions, public.demo_entitlements,
  public.demo_webhook_events, public.demo_business_effects to service_role;
grant insert, update on public.demo_entitlements to service_role;
grant usage on schema public to paypath_rpc_owner, service_role;
revoke all on sequence public.demo_business_effects_id_seq from public, anon, authenticated, service_role;
grant usage, select on sequence public.demo_business_effects_id_seq to paypath_rpc_owner;

-- Remove the earlier nine-argument RPC so PostgREST cannot keep exposing an
-- overload without event ordering protection after this migration is applied.
-- Supabase's postgres role is not a database superuser. Temporarily grant it
-- SET ROLE capability and let the RPC owner create privilege needed for the
-- function creation below. The temporary CREATE grant and SET-capable role
-- membership are revoked before this transaction commits. PostgreSQL 16+ may
-- retain the creator's built-in ADMIN membership, but that grant has SET and
-- INHERIT disabled and does not expose the owner's object privileges.
grant create on schema public to paypath_rpc_owner;
do $owner_membership$
begin
  if pg_catalog.current_setting('server_version_num')::integer >= 160000 then
    -- PostgreSQL 16+ creates an ADMIN membership for the role creator with SET
    -- disabled. Add a transaction-scoped membership path with SET enabled.
    execute 'grant paypath_rpc_owner to postgres with set true, inherit false';
  else
    execute 'grant paypath_rpc_owner to postgres';
  end if;
end;
$owner_membership$;

drop function if exists public.process_demo_stripe_event(text, text, text, text, text, timestamptz, boolean, boolean, boolean);

-- Create or replace the RPCs while acting as their intended owner. This avoids
-- ALTER FUNCTION OWNER permission requirements on hosted Supabase and ensures
-- reruns can safely replace functions already owned by paypath_rpc_owner.
set role paypath_rpc_owner;

create or replace function public.process_demo_stripe_event(
  p_event_id text,
  p_event_type text,
  p_user_id text,
  p_subscription_id text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created_at bigint,
  p_allow_repeated_effects boolean default false,
  p_suppress_entitlement_effect boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_delivery_count integer;
  v_processed_count integer;
  v_stored_event_type text;
  v_stored_user_id text;
  v_stored_subscription_id text;
  v_stored_created_at bigint;
  v_stored_status text;
  v_stored_period_end timestamptz;
  v_stored_cancel_at_period_end boolean;
  v_stale boolean;
  v_stored_ordering_ambiguous boolean;
  v_duplicate boolean;
  v_conflict boolean;
  v_identity_matches boolean;
  v_subscription_applied boolean := false;
  v_rows integer;
  v_current_event_created_at bigint;
  v_current_event_id text;
  v_ordering_ambiguous boolean := false;
  v_effect_type text := null;
begin
  if p_event_id is null or pg_catalog.length(p_event_id) > 255 or p_event_id !~ '^evt_[A-Za-z0-9]+$' then
    raise exception 'invalid Stripe test event ID';
  end if;
  if p_user_id is null or p_user_id !~ '^paypath-test-[A-Za-z0-9_-]{3,220}$' then
    raise exception 'invalid PayPath test user ID';
  end if;
  if p_subscription_id is null or pg_catalog.length(p_subscription_id) > 255 or p_subscription_id !~ '^sub_[A-Za-z0-9]+$' then
    raise exception 'invalid Stripe test subscription ID';
  end if;
  if p_event_type is null or p_event_type not in (
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted'
  ) then
    raise exception 'unsupported demo subscription event';
  end if;
  if p_status is null or p_status not in (
    'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
  ) then
    raise exception 'unsupported Stripe subscription status';
  end if;
  if p_event_created_at is null or p_event_created_at <= 0 or p_event_created_at > 9007199254740991 then
    raise exception 'Stripe event creation time must be a safe positive Unix timestamp';
  end if;
  if p_current_period_end is not null and p_current_period_end < timestamptz '1970-01-01 00:00:00+00' then
    raise exception 'subscription period end must not precede the Unix epoch';
  end if;
  if p_cancel_at_period_end is null or p_allow_repeated_effects is null or p_suppress_entitlement_effect is null then
    raise exception 'boolean webhook parameters are required';
  end if;
  if p_event_type = 'customer.subscription.deleted' and p_status <> 'canceled' then
    raise exception 'deleted subscription events must carry canceled status';
  end if;

  -- Serialize events and cleanup per synthetic test user. Stripe event.created
  -- has one-second precision, so equal timestamps from distinct events are not
  -- ordered safely and will be marked ambiguous below.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id, 0));

  insert into public.demo_webhook_events (
    event_id, event_type, user_id, subscription_id, event_created_at,
    event_status, current_period_end, cancel_at_period_end,
    delivery_count, processed_count, stale, ordering_ambiguous,
    received_at, processed_at
  ) values (
    p_event_id, p_event_type, p_user_id, p_subscription_id, p_event_created_at,
    p_status, p_current_period_end, p_cancel_at_period_end,
    1, 0, false, false, pg_catalog.clock_timestamp(), null
  )
  on conflict (event_id) do update
    set delivery_count = public.demo_webhook_events.delivery_count + 1,
        received_at = pg_catalog.clock_timestamp()
  returning delivery_count, event_type, user_id, subscription_id, event_created_at,
            event_status, current_period_end, cancel_at_period_end, processed_count, stale, ordering_ambiguous
       into v_delivery_count, v_stored_event_type, v_stored_user_id,
            v_stored_subscription_id, v_stored_created_at, v_stored_status,
            v_stored_period_end, v_stored_cancel_at_period_end, v_processed_count, v_stale,
            v_stored_ordering_ambiguous;

  v_duplicate := v_delivery_count > 1;
  v_identity_matches := v_stored_event_type is not distinct from p_event_type
    and v_stored_user_id is not distinct from p_user_id
    and v_stored_subscription_id is not distinct from p_subscription_id
    and v_stored_created_at is not distinct from p_event_created_at
    and v_stored_status is not distinct from p_status
    and v_stored_period_end is not distinct from p_current_period_end
    and v_stored_cancel_at_period_end is not distinct from p_cancel_at_period_end;
  v_conflict := not v_identity_matches;

  if v_conflict then
    return pg_catalog.jsonb_build_object(
      'duplicate', v_duplicate, 'conflict', true, 'stale', v_stale,
      'ordering_ambiguous', v_stored_ordering_ambiguous, 'processed', false,
      'delivery_count', v_delivery_count, 'processed_count', v_processed_count,
      'effect_type', null
    );
  end if;

  -- Identical re-deliveries only affect the delivery counter in Fixed mode.
  if v_duplicate and not p_allow_repeated_effects then
    return pg_catalog.jsonb_build_object(
      'duplicate', true, 'conflict', false, 'stale', v_stale,
      'ordering_ambiguous', v_stored_ordering_ambiguous, 'processed', false,
      'delivery_count', v_delivery_count, 'processed_count', v_processed_count,
      'effect_type', null
    );
  end if;

  insert into public.demo_subscriptions as current_subscription (
    user_id, stripe_subscription_id, status, current_period_end,
    cancel_at_period_end, last_event_created_at, last_event_id, updated_at
  ) values (
    p_user_id, p_subscription_id, p_status, p_current_period_end,
    p_cancel_at_period_end, p_event_created_at, p_event_id, pg_catalog.clock_timestamp()
  )
  on conflict (user_id) do update set
    stripe_subscription_id = excluded.stripe_subscription_id,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    last_event_created_at = excluded.last_event_created_at,
    last_event_id = excluded.last_event_id,
    updated_at = pg_catalog.clock_timestamp()
  where excluded.last_event_created_at > current_subscription.last_event_created_at
     or (
       v_duplicate and p_allow_repeated_effects
       and excluded.last_event_created_at = current_subscription.last_event_created_at
       and current_subscription.last_event_id = p_event_id
     );
  get diagnostics v_rows = row_count;
  v_subscription_applied := v_rows = 1;

  if not v_subscription_applied then
    select s.last_event_created_at, s.last_event_id
      into v_current_event_created_at, v_current_event_id
      from public.demo_subscriptions as s
     where s.user_id = p_user_id;
    v_ordering_ambiguous := v_current_event_created_at = p_event_created_at
      and v_current_event_id is distinct from p_event_id;
    update public.demo_webhook_events
       set stale = true, ordering_ambiguous = v_ordering_ambiguous
     where event_id = p_event_id;
    return pg_catalog.jsonb_build_object(
      'duplicate', v_duplicate, 'conflict', false, 'stale', true,
      'ordering_ambiguous', v_ordering_ambiguous, 'processed', false,
      'delivery_count', v_delivery_count, 'processed_count', v_processed_count,
      'effect_type', null
    );
  end if;

  if p_status in ('active', 'trialing') then
    v_effect_type := 'entitlement_granted';
    if not p_suppress_entitlement_effect then
      insert into public.demo_entitlements(user_id, pro_access, updated_at)
      values (p_user_id, true, pg_catalog.clock_timestamp())
      on conflict (user_id) do update
        set pro_access = excluded.pro_access, updated_at = excluded.updated_at;
    else
      v_effect_type := null;
    end if;
  elsif p_status = 'canceled' then
    v_effect_type := 'entitlement_revoked';
    if not p_suppress_entitlement_effect then
      insert into public.demo_entitlements(user_id, pro_access, updated_at)
      values (p_user_id, false, pg_catalog.clock_timestamp())
      on conflict (user_id) do update
        set pro_access = excluded.pro_access, updated_at = excluded.updated_at;
    else
      v_effect_type := null;
    end if;
  end if;

  if v_effect_type is not null then
    insert into public.demo_business_effects(event_id, user_id, effect_type)
    values (p_event_id, p_user_id, v_effect_type);
  end if;

  update public.demo_webhook_events
     set processed_count = processed_count + 1,
         processed_at = pg_catalog.clock_timestamp(),
         stale = false,
         ordering_ambiguous = false
   where event_id = p_event_id
   returning processed_count into v_processed_count;

  return pg_catalog.jsonb_build_object(
    'duplicate', v_duplicate, 'conflict', false, 'stale', false,
    'ordering_ambiguous', false, 'processed', true,
    'delivery_count', v_delivery_count, 'processed_count', v_processed_count,
    'effect_type', v_effect_type
  );
end;
$$;

revoke all on function public.process_demo_stripe_event(text, text, text, text, text, timestamptz, boolean, bigint, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.process_demo_stripe_event(text, text, text, text, text, timestamptz, boolean, bigint, boolean, boolean)
  to service_role;

create or replace function public.cleanup_demo_test_user(
  p_user_id text,
  p_subscription_id text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_effects bigint;
  v_events bigint;
  v_subscriptions bigint;
  v_entitlements bigint := 0;
begin
  if p_user_id is null or p_user_id !~ '^paypath-test-[A-Za-z0-9_-]{3,220}$' then
    raise exception 'cleanup requires a valid PayPath test user ID';
  end if;
  if p_subscription_id is null or pg_catalog.length(p_subscription_id) > 255 or p_subscription_id !~ '^sub_[A-Za-z0-9]+$' then
    raise exception 'cleanup requires a Stripe test subscription ID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id, 0));

  if not exists (
    select 1 from public.demo_subscriptions as s
     where s.user_id = p_user_id and s.stripe_subscription_id = p_subscription_id
  ) and not exists (
    select 1 from public.demo_webhook_events as e
     where e.user_id = p_user_id and e.subscription_id = p_subscription_id
  ) then
    raise exception 'cleanup target does not match PayPath test data';
  end if;

  select count(*) into v_effects
    from public.demo_business_effects as e
    join public.demo_webhook_events as w
      on w.event_id = e.event_id and w.user_id = e.user_id
   where w.user_id = p_user_id and w.subscription_id = p_subscription_id;

  delete from public.demo_webhook_events as w
   where w.user_id = p_user_id and w.subscription_id = p_subscription_id;
  get diagnostics v_events = row_count;

  -- Effects are removed by the composite ON DELETE CASCADE FK above.
  delete from public.demo_subscriptions as s
   where s.user_id = p_user_id and s.stripe_subscription_id = p_subscription_id;
  get diagnostics v_subscriptions = row_count;

  -- Keep the entitlement if another current subscription or any other test
  -- subscription event remains for this exact test user.
  if not exists (select 1 from public.demo_subscriptions as s where s.user_id = p_user_id)
     and not exists (select 1 from public.demo_webhook_events as e where e.user_id = p_user_id) then
    delete from public.demo_entitlements as e where e.user_id = p_user_id;
    get diagnostics v_entitlements = row_count;
  end if;

  return pg_catalog.jsonb_build_object(
    'effects_deleted', v_effects,
    'events_deleted', v_events,
    'subscriptions_deleted', v_subscriptions,
    'entitlements_deleted', v_entitlements
  );
end;
$$;

revoke all on function public.cleanup_demo_test_user(text, text) from public, anon, authenticated;
grant execute on function public.cleanup_demo_test_user(text, text) to service_role;

reset role;
revoke paypath_rpc_owner from postgres;
revoke create on schema public from paypath_rpc_owner;

commit;
