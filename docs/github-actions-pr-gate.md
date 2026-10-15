# GitHub Actions PR Gate

## What it verifies

`.github/workflows/paypath-pr-gate.yml` runs when a pull request is opened, updated, reopened, or marked ready for review. It uses Node.js 24 and runs:

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run build:demo`
5. `npm run test:pr-gate`

The PR gate runs local deterministic fixtures only. It does not invoke the Stripe or Supabase integration commands and does not need account credentials.

The local gate invokes the existing PayPath CLI as a child process in both modes. All three scenarios must be `PASS` in Fixed mode. In Buggy mode, the CLI must exit non-zero and report these exact findings:

| Scenario | Required Buggy result |
| --- | --- |
| `successful-payment` | `FAIL / ENTITLEMENT_NOT_GRANTED` |
| `cancellation` | `FAIL / ENTITLEMENT_NOT_REVOKED` |
| `duplicate-webhook` | `FAIL / DUPLICATE_WEBHOOK_EFFECT` |

Those Buggy failures are expected evidence that detection works. They do not fail the overall job when the outcome and CLI exit code match the contract. Any unexpected status, error code, report source, summary count, or exit code makes the gate exit with code `1`. A separate Vitest contract test covers that non-zero behavior, while the gate runs the actual CLI and validates its real exit codes.

## Reports

The gate writes these local files under the ignored `artifacts/` directory:

- `paypath-fixed.json`: original PayPath CLI report for the fixed scenarios.
- `paypath-buggy.json`: original PayPath CLI report for expected detections.
- `paypath-pr-gate.json`: combined gate result and validation details.
- `paypath-pr-gate-summary.md`: readable summary used in the GitHub Actions job summary.

The workflow publishes the files as an artifact even when a later step fails, and appends the Markdown summary to the run. Reports identify the source as `local-fixture`; they are not Stripe or Supabase integration evidence.

## Security model

- The workflow uses `pull_request`, not `pull_request_target`.
- Workflow token permissions are limited to `contents: read`.
- Checkout does not persist its token in Git configuration.
- No repository secrets are referenced or passed to test steps.
- The workflow does not run deployment, publish, issue-comment, or GitHub API write actions.
- Action dependencies are pinned to full commit SHAs.
- Pull request code still runs on an ephemeral GitHub-hosted runner to execute tests, so required checks should remain read-only and must not be changed to expose secrets to PR jobs.

## Verify locally

Use Node.js 24, then run:

```sh
npm ci
npm test
npm run typecheck
npm run build:demo
npm run test:pr-gate
```

`npm run test:pr-gate` verifies both the CLI's Fixed success exit and its non-zero Buggy exit. Its overall exit code is `0` only when all six mode/scenario expectations are met.

## Verify with a real pull request

1. Push this workflow and the gate implementation to a GitHub branch.
2. Open a pull request against the repository's default branch, or push another commit to an open PR.
3. Confirm that the **Local PayPath PR Gate** check runs and succeeds.
4. Open the Actions run and inspect the job summary. Download the `paypath-pr-gate-<number>` artifact and review the JSON reports.
5. In repository branch protection or rulesets, require the **Local PayPath PR Gate** status check before merging.

An initial workflow smoke test can use a documentation-only pull request; the workflow still exercises the simulated billing scenarios.

This verifies the local simulated gate in GitHub Actions. It does not validate a real Stripe account, Stripe Test Mode payment, webhook delivery, or Supabase network integration. Do not add Stripe or Supabase secrets to this workflow.
