# Local billing scenario fixtures

The local deterministic fixtures are created by `LocalScenarioExecutor` in
`packages/demo-engine/src/local-executor.ts`. Each invocation gets a fresh
in-memory repository, unique scenario-specific IDs, and timestamps relative to
the current run.

| Scenario | Stripe fixture | Webhook deliveries | Fixed result |
| --- | --- | ---: | --- |
| `successful-payment` | active, latest invoice paid, period in the future | 1 | persisted and authorized Pro access is granted |
| `cancellation` | canceled, period ended before evaluation time | 1 | persisted and authorized Pro access is revoked |
| `duplicate-webhook` | active, latest invoice paid | same event ID twice | two deliveries, one entitlement effect |

The engine receives only the observed snapshots. The Buggy/Fixed selection is
used inside the Demo application when the executor processes each event; it is
never passed to the assertion engine.
