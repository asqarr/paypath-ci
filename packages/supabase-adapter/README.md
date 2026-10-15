# Supabase test adapter

`schema.sql` is a transactional setup and hardening migration for a dedicated, disposable Supabase project. It is not run by the CLI or application. Apply it only after explicitly selecting that test project in the Supabase SQL Editor and confirming the SQL Editor session runs as `postgres`.

The migration creates a non-login `paypath_rpc_owner` role, tightens default function execution grants in `public`, enables RLS, grants the RPC owner access only to the PayPath demo tables, and grants RPC execution to `service_role`. `service_role` receives read access to the demo evidence tables and write access only to the test entitlement seed operation. It replaces the earlier `process_demo_stripe_event` signature so there is no ordering-unaware overload left exposed. On an existing Phase 1 database, legacy webhook receive times are used as a conservative event-order baseline; clear and reseed only the disposable test data before relying on Stripe event ordering.

After applying `schema.sql`, run `schema-regression.sql` in the same disposable project. The checks cover function permissions, idempotency, payload conflicts, stale events, cleanup scope, and cascading effect cleanup. They run in a transaction and roll back their fixture data. Do not run either file against a production project.

The live adapter integration check is separately opt-in. It requires a matching Supabase project ref, `PAYPATH_SUPABASE_TEST_PROJECT_ACK=disposable-test-project`, `PAYPATH_RUN_SUPABASE_INTEGRATION=1`, and service-role credentials supplied through the local environment. It creates a uniquely named `paypath-test-*` user and synthetic `sub_*` identifier, verifies read-after-write results, then calls the scoped cleanup RPC. It does not use Stripe.

Stripe webhook ordering uses the signed Stripe Event `created` timestamp (Unix seconds). Distinct events with the same timestamp cannot be ordered safely, so the database marks them stale and `ordering_ambiguous` rather than choosing one. Exact duplicate deliveries increment the delivery count without repeating the business effect in Fixed mode.
