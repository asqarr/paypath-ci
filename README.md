# PayPath CI

**Catch revenue-breaking bugs before deployment.**

PayPath CI is a TypeScript proof of value for revenue and entitlement regression testing. It checks payment state in Stripe, persisted entitlement state, and the Demo SaaS authorization outcome. It also compares webhook deliveries with business effects so a repeated delivery log alone does not count as a duplicate-operation bug.

## Phase 1 scope

- `packages/core`: scenario policy, evidence evaluation, four-state results, and JSON report types.
- `packages/demo-engine`: a small billing application with isolated Buggy/Fixed fault injection and deterministic in-memory storage.
- `packages/stripe-adapter`: read-only Stripe Test Mode subscription and invoice reads plus signed webhook verification.
- `packages/supabase-adapter`: Supabase storage adapter and a transaction-safe SQL schema for event/effect evidence.
- `packages/cli`: `paypath doctor` and local or read-only integration test execution.
- `apps/demo-saas`: Next.js App Router demo with a Checkout button, entitlement API, and signed Stripe webhook handler.

The initial scenarios are successful payment without access, access left on after an ended subscription, and duplicate business effects from a repeated event. Local scenario fixture details are in [`fixtures/billing-scenarios/README.md`](fixtures/billing-scenarios/README.md).

## Requirements

- Node.js 24 or later. PayPath targets Node.js 24 for local development and CI.
- npm 10 or later is recommended for npm workspaces.
- Stripe CLI is optional for local webhook forwarding and event replay.
- A dedicated Stripe sandbox/test account and a disposable Supabase test project are optional for real integration checks.

Use the version in `.nvmrc` (24) and check the runtime with `node --version` and `npm run paypath -- doctor`. See the [official Node.js release schedule](https://nodejs.org/en/about/previous-releases).

## Install and run the local proof

```bash
npm install
npm run paypath -- doctor
npm test
npm run typecheck
```

Run the seeded bugs and inspect the generated JSON report:

```bash
npm run paypath -- test --mode buggy
```

Expected: all three scenarios report `FAIL`; the CLI returns exit code `1`.

Run the same scenarios with the fixes enabled:

```bash
npm run paypath -- test --mode fixed
```

Expected: all three report `PASS`; the CLI returns exit code `0`. The default mode is `fixed`. `paypath-report.json` is written in the current directory and is ignored by Git. Choose another path with `--report path/to/report.json`.

Run one scenario at a time:

```bash
npm run paypath -- test --scenario successful-payment --mode buggy
npm run paypath -- test --scenario cancellation --mode buggy
npm run paypath -- test --scenario duplicate-webhook --mode buggy
```

Result meanings and exit codes:

- `PASS`: required billing, database, and authorization evidence agrees with the Demo policy; exit `0` when all tests pass.
- `FAIL`: evidence confirms an entitlement or duplicate-effect violation; exit `1`.
- `ERROR`: an adapter or service failed during execution; exit `1`.
- `INCONCLUSIVE`: required evidence or a scenario precondition is missing; exit `1` so CI cannot mistake it for a pass.

Local mode uses runtime-generated deterministic Stripe-state fixtures and an in-memory application store. It does not call Stripe or Supabase and is labelled `local-fixture` in every report.

## GitHub Actions PR Gate (simulated)

The [`PayPath CI PR Gate`](docs/github-actions-pr-gate.md) workflow runs the unit tests, strict TypeScript check, Demo build, and the local PR-gate runner on pull requests. Fixed scenarios must all pass. The runner also invokes Buggy mode and accepts its non-zero CLI exit only when all three intentional bugs are detected with their exact error codes. Any unexpected outcome makes the overall PR gate fail.

The workflow uses no Stripe or Supabase credentials, grants only `contents: read`, and publishes JSON reports plus a readable job summary. These results are deterministic local fixture evidence; they do not claim a real Stripe End-to-End integration. See the linked guide for local commands, report locations, security details, and how to test a real PR after this project is pushed to GitHub.

## Run the Demo SaaS

```bash
npm run dev
```

Open `http://localhost:3000`. Without external configuration, the page uses an in-memory store; its state resets when the Next.js process restarts. Bug injection is off by default. For a local demonstration, set `PAYPATH_DEMO_MODE=buggy` and `PAYPATH_DEMO_SCENARIO` to one of the three scenario IDs in `.env.local`. Bug injection is rejected when `NODE_ENV=production`.

To create a real test subscription, configure `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PRICE_ID=price_…`, and `PAYPATH_TEST_USER_ID=paypath-test-demo-user`. Demo writes and integration checks accept only user IDs beginning with `paypath-test-`. The server creates a Stripe Checkout Session in subscription mode. No live key is accepted.

The webhook route accepts only subscription lifecycle events, verifies the signature against the raw request body, and uses the subscription's `paypath_user_id` metadata. `/api/pro/feature` returns HTTP 200 when the guarded Pro feature is allowed and HTTP 403 when denied; the integration adapter checks that response, not just the entitlement row. To forward local test events, run the Stripe CLI in another terminal:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the `whsec_…` signing secret printed by that local listener into `STRIPE_WEBHOOK_SECRET`. Do not use a production endpoint secret. The event handler uses `constructEvent` on the unmodified request body, as Stripe requires for signature verification. See [Stripe's webhook verification guidance](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors).

## Optional Supabase test database

Use a separate, disposable Supabase project. Do not point this Demo SaaS or CLI at a production database.

1. Create a dedicated disposable Supabase project; do not reuse a production project. Copy its project URL and ref.
2. Apply [`packages/supabase-adapter/schema.sql`](packages/supabase-adapter/schema.sql) in that project's Supabase SQL Editor. The schema is repeatable for setup, enables RLS, grants no table access to `anon` or `authenticated`, and gives the server-side service role access for the Demo RPC/read adapter.
3. Create an untracked `.env.integration.local` containing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYPATH_TEST_SUPABASE_REF`, `PAYPATH_SUPABASE_TEST_PROJECT_ACK=disposable-test-project`, and `PAYPATH_RUN_SUPABASE_INTEGRATION=1`. The project ref must match the URL hostname; local Supabase requires `PAYPATH_TEST_SUPABASE_REF=local`. The Demo app also refuses Supabase access unless this acknowledgment is present.
4. Keep the service role key server-side. Never use it in browser code or commit it. `.env.integration.local` is ignored by Git.
5. For the Next.js Demo, put the same test-only Supabase URL, service role key, project ref, and acknowledgment in its untracked `apps/demo-saas/.env.local`. Add the Stripe test key, test Price ID, test user ID, and webhook signing secret there when running checkout scenarios. Restart the Demo after changing environment settings. The CLI accepts the Stripe and Supabase integration values from `.env.integration.local` or `.env`.

Run the real isolated write/read/cleanup probe with:

```bash
npm run test:supabase-integration
```

This command will not connect unless the explicit opt-in and disposable-project acknowledgment are present. It creates one uniquely named `paypath-test-*` user, writes a synthetic subscription event through the real Supabase RPC, reads back the subscription, entitlement, delivery, and business effect, then invokes the narrowly scoped cleanup RPC. The synthetic `sub_*` value is database test data only; this probe does not contact Stripe. Missing or invalid local configuration reports `INCONCLUSIVE`; service, schema, or cleanup failures report `ERROR`. A pass is reported only after read-after-write checks and cleanup succeed.

The webhook RPC records each delivery and makes the event/effect mutation atomic. A fixed replay increments `delivery_count` while leaving `processed_count` and business effects unchanged. The Buggy duplicate scenario deliberately re-applies the business effect.

The local deterministic runner starts with a fresh in-memory store and discards it when the case ends. Integration checks are read-only and do not create test data. For records created by manually using the Demo with Supabase, the CLI has a separately guarded cleanup command:

```bash
npm run paypath -- cleanup --test-user paypath-test-your-run --subscription-id sub_your_test_subscription --project-ref your-test-project-ref
```

Cleanup is available only outside production, accepts only `paypath-test-*` users and `sub_*` subscription IDs, verifies the Supabase project ref, and asks you to type the exact project/user/subscription tuple before it sends a request. Its SQL function deletes matching Demo effects, events, subscription, and entitlement in one transaction; Stripe objects and events are untouched. Use unique test IDs so cleanup cannot remove records shared with another test.

## Stripe and Supabase read-only integration checks

The scenario integration CLI reads existing test data. It never creates/cancels subscriptions, advances clocks, replays events, or writes test data. If setup is missing, it emits `INCONCLUSIVE`; a service or connection error emits `ERROR`. Integration reports use `stripe-supabase-integration`, never `local-fixture`. The CLI loads `.env.integration.local` first and `.env` second. The actual Supabase write/read check is a separate, explicitly opted-in command described above.

Required environment values:

```dotenv
STRIPE_SECRET_KEY=sk_test_...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<test-project-service-role-key>
PAYPATH_TEST_SUPABASE_REF=<project-ref>
PAYPATH_SUPABASE_TEST_PROJECT_ACK=disposable-test-project
PAYPATH_DEMO_BASE_URL=http://localhost:3000
```

For one selected scenario, also set `PAYPATH_STRIPE_SUBSCRIPTION_ID` and `PAYPATH_TEST_USER_ID`, then run:

```bash
npm run paypath -- test --integration --scenario successful-payment
npm run paypath -- test --integration --scenario cancellation
npm run paypath -- test --integration --scenario duplicate-webhook
```

The scenarios require different Stripe states, so set scenario-specific IDs when running the full suite:

```dotenv
PAYPATH_STRIPE_SUBSCRIPTION_ID_SUCCESSFUL_PAYMENT=sub_active_paid
PAYPATH_STRIPE_SUBSCRIPTION_ID_CANCELLATION=sub_canceled_after_period_end
PAYPATH_STRIPE_SUBSCRIPTION_ID_DUPLICATE_WEBHOOK=sub_active_for_replay
PAYPATH_TEST_USER_ID_SUCCESSFUL_PAYMENT=paypath-test-payment
PAYPATH_TEST_USER_ID_CANCELLATION=paypath-test-cancellation
PAYPATH_TEST_USER_ID_DUPLICATE_WEBHOOK=paypath-test-replay
PAYPATH_WEBHOOK_EVENT_ID_DUPLICATE_WEBHOOK=evt_event_replayed_twice
```

The payment scenarios require an active subscription whose latest invoice is paid, with Stripe subscription metadata `paypath_user_id` matching the configured test user. Cancellation accepts either a canceled subscription after its period end or an immediate cancellation before that period end; an active subscription with `cancel_at_period_end=true` remains entitled through the paid period. For a Test Clock subscription, the adapter reads the Stripe clock's `frozen_time` only when the clock is `ready`; it does not assume the application machine's clock advanced with Stripe. Stripe Test Clocks control Stripe billing objects and emit events; application state still needs the event delivered and processed. See [Stripe Test Clocks](https://docs.stripe.com/billing/testing/test-clocks).

For the duplicate scenario, replay one signed event with the same Stripe event ID through the local webhook endpoint, then set its ID in `PAYPATH_WEBHOOK_EVENT_ID_DUPLICATE_WEBHOOK`. Stripe CLI supports `stripe events resend <event-id>`; see [the Stripe CLI resend command](https://docs.stripe.com/cli/events/resend). PayPath checks the matching event, user, and subscription row in Supabase, not Stripe's delivery log alone.

### End-to-end scenario prerequisites

All scenarios need a dedicated Stripe test account, a test-mode recurring Price, a disposable Supabase project with the schema above, and the Demo running locally with `STRIPE_SECRET_KEY=sk_test_...`, the test Price ID, the test webhook secret, Supabase test settings plus the acknowledgment, and a `paypath-test-*` user ID. Start `stripe listen --forward-to localhost:3000/api/stripe/webhook`, configure its printed `whsec_...` value in the Demo's `.env.local`, and restart the app after changing Buggy/Fixed mode. Complete Checkout in Stripe Test Mode; the created Subscription must retain the Demo's `paypath_user_id` metadata. Use unique test users and subscriptions for each run.

| Scenario | Stripe and webhook preconditions | Expected Demo evidence |
| --- | --- | --- |
| Successful payment, entitlement missing | Subscription is `active`, its latest invoice is `paid`, and its created/updated event has been processed by the Demo. | Stripe subscription ID matches the stored Demo subscription; Supabase entitlement and `/api/pro/feature` agree with the selected Buggy/Fixed behavior. |
| Period ended, access remains | Either a scheduled cancellation has reached `canceled` after the paid period, or the subscription was canceled immediately; deliver/process the resulting signed event. A Test Clock must be `ready` before its frozen time can be used. | Stripe period/status plus matching stored subscription, entitlement row, and authorization API response establish that the paid period truly ended. |
| Duplicate event effect | Capture one signed subscription event, deliver the same event ID at least twice, and set `PAYPATH_WEBHOOK_EVENT_ID_DUPLICATE_WEBHOOK` to that ID. | Supabase delivery count shows replay; business-effect rows for that event ID determine whether an unauthorized repeat occurred. |

To compare Buggy and Fixed behavior against the same Stripe event, first collect the Buggy report, then stop the Demo, set `PAYPATH_DEMO_MODE=fixed`, and restart it. Before replaying the same event, run the guarded cleanup for that exact test user/subscription so the old event/effect rows do not make the fixed replay look like a duplicate. Then resend the same Stripe event and run the read-only scenario CLI again. Cleanup only removes matching Demo rows; it does not alter Stripe objects. For the duplicate scenario, send the same event twice after cleanup in each mode. Never use live keys, live webhook secrets, or production databases.

## Architecture and trust boundaries

The core accepts typed observations from a `ScenarioExecutor`; it never receives the Buggy/Fixed mode. Local mode drives the Demo domain with a fresh repository for each case. Integration mode reads Stripe's subscription and latest invoice, Supabase's persisted entitlement and webhook effects, and the running Demo app's authorization endpoint. Missing evidence cannot pass. JSON reports contain scenario, expected and actual values, evidence, reproduction steps, source label, timestamp, and duration; credentials are excluded.

The Demo's entitlement policy is intentionally small and local to this fixture: active/trialing access remains available through a scheduled cancellation period; effective immediate cancellation or a canceled subscription after period end revokes access. These are Demo rules, not defaults imposed on future PayPath customers.

## Current limitations

- Local mode models Stripe billing state as fixtures; it is deterministic business-logic validation, not a live Stripe integration test.
- The Supabase write/read probe is real only when explicitly opted into with a separate disposable project. Without its credentials it reports `INCONCLUSIVE`, not a local pass.
- Stripe Test Mode reads and signed webhook verification are implemented, but no Stripe request is made by `test:supabase-integration`; scenario integration requires a test account, matching test objects, webhook delivery, and a running Demo API.
- The integration executor is read-only. You must create subscriptions, deliver their events, advance any Test Clock, and replay duplicate events yourself in a test environment.
- Integration verifies the latest Stripe invoice, one Supabase entitlement record, a Demo API authorization response, and optionally a preselected webhook event. It does not yet discover an application schema or derive customer-specific entitlement policy.
- The in-memory Demo store is process-local. Use the dedicated Supabase schema for durable webhook handling.
- Supabase data created by manually running Demo billing remains in the disposable test project until you run the explicit, scope-checked `cleanup` command.
- Supabase credentials are supplied only through environment variables. No actual Stripe or Supabase credentials were provided or used in this phase.
- There is no authentication, production deployment setup, customer-facing GitHub App, billing dashboard, AI diagnosis, or generalized customer adapter yet. The PR workflow only checks deterministic local fixtures; it does not validate real Stripe or Supabase integrations.

## Phase 2 direction

Harden the adapter contract, support explicit customer policy configuration, add more Stripe/Supabase fixture coverage, and build a secure CI invocation/report contract. Keep scenario setup and destructive operations behind explicit test-environment controls.
