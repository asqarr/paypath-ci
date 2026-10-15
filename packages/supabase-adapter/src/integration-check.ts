import { randomUUID } from "node:crypto";
import {
  cleanupDemoTestData,
  createSupabaseTestClient,
  parseSupabaseTestConfiguration,
  SupabaseDatabaseError,
  SupabaseDemoRepository,
} from "./index.ts";
import type { DemoWebhookEvent } from "@paypath/demo-engine";

type CheckStatus = "PASS" | "FAIL" | "ERROR" | "INCONCLUSIVE";

interface IntegrationDiagnostic {
  stage: string;
  errorType: string;
  rpcName?: string;
  errorCode?: string;
  httpStatus?: number;
  message: string;
}

interface CheckResult {
  integration: "supabase-isolated-read-write";
  status: CheckStatus;
  checkedAt: string;
  projectRef?: string;
  evidence: string[];
  diagnostics?: IntegrationDiagnostic[];
}

function finish(result: CheckResult): void {
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
}

function errorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "UnknownError";
}

function safeDiagnostic(error: unknown, stage: string): IntegrationDiagnostic {
  if (error instanceof SupabaseDatabaseError) {
    const { operation, rpcName, errorType: remoteErrorType, errorCode, httpStatus, message } = error.diagnostic;
    return {
      stage: `${stage}:${operation}`,
      errorType: remoteErrorType,
      ...(rpcName ? { rpcName } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(httpStatus ? { httpStatus } : {}),
      message,
    };
  }
  return {
    stage,
    errorType: errorType(error),
    message: "Unexpected runtime or response-validation error; raw details were omitted.",
  };
}

async function main(): Promise<void> {
  if (process.env["PAYPATH_RUN_SUPABASE_INTEGRATION"] !== "1") {
    finish({
      integration: "supabase-isolated-read-write",
      status: "INCONCLUSIVE",
      checkedAt: new Date().toISOString(),
      evidence: ["No connection attempted. Set PAYPATH_RUN_SUPABASE_INTEGRATION=1 to explicitly opt in."],
    });
    return;
  }

  if (process.env["NODE_ENV"] === "production") {
    finish({
      integration: "supabase-isolated-read-write",
      status: "INCONCLUSIVE",
      checkedAt: new Date().toISOString(),
      evidence: ["No connection attempted. Integration writes are disabled in NODE_ENV=production."],
    });
    return;
  }

  if (process.env["PAYPATH_SUPABASE_TEST_PROJECT_ACK"] !== "disposable-test-project") {
    finish({
      integration: "supabase-isolated-read-write",
      status: "INCONCLUSIVE",
      checkedAt: new Date().toISOString(),
      evidence: ["No connection attempted. Explicit disposable-test-project acknowledgment is missing."],
    });
    return;
  }

  let configuration;
  try {
    configuration = parseSupabaseTestConfiguration(process.env);
  } catch {
    finish({
      integration: "supabase-isolated-read-write",
      status: "INCONCLUSIVE",
      checkedAt: new Date().toISOString(),
      evidence: ["No connection attempted. Supabase URL, service role key, or matching test project ref is missing or invalid."],
    });
    return;
  }

  const client = createSupabaseTestClient(configuration);
  const repository = new SupabaseDemoRepository(client);
  const nonce = randomUUID().replaceAll("-", "");
  const userId = `paypath-test-integration-${nonce}`;
  const subscriptionId = `sub_${nonce}`;
  const eventId = `evt_paypath${nonce}`;
  const event: DemoWebhookEvent = {
    eventId,
    eventType: "customer.subscription.created",
    eventCreatedAt: Math.floor(Date.now() / 1000),
    userId,
    subscriptionId,
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    cancelAtPeriodEnd: false,
  };

  let status: CheckStatus = "PASS";
  const evidence = ["A unique paypath-test-* user and synthetic sub_* ID were generated for this run."];
  const diagnostics: IntegrationDiagnostic[] = [];
  let writeAttempted = false;
  let stage = "webhook-rpc";

  try {
    writeAttempted = true;
    await repository.applyEvent(event, false, false);
    stage = "read-after-write";
    const [subscription, entitlement, delivery, effects] = await Promise.all([
      repository.getSubscription(userId),
      repository.getEntitlement(userId),
      repository.getDelivery(eventId),
      repository.getEffects(eventId),
    ]);

    const valid =
      subscription?.subscriptionId === subscriptionId &&
      subscription.status === "active" &&
      entitlement?.userId === userId &&
      entitlement.proAccess === true &&
      delivery?.eventId === eventId &&
      delivery.userId === userId &&
      delivery.deliveryCount === 1 &&
      delivery.processedCount === 1 &&
      effects.length === 1 &&
      effects[0]?.eventId === eventId &&
      effects[0].effectType === "entitlement_granted" &&
      effects[0].count === 1;

    if (!valid) {
      status = "FAIL";
      evidence.push("Read-after-write evidence did not match the expected subscription, entitlement, event, and single business effect.");
    } else {
      evidence.push("Supabase RPC write and independent table reads confirmed the expected rows and one business effect.");
    }
  } catch (error) {
    status = "ERROR";
    diagnostics.push(safeDiagnostic(error, stage));
    evidence.push("Supabase write or read failed; see the sanitized diagnostic for stage and remote error metadata.");
  } finally {
    if (writeAttempted) {
      try {
        stage = "cleanup-verification";
        const storedSubscription = await repository.getSubscription(userId);
        if (storedSubscription?.subscriptionId === subscriptionId) {
          stage = "cleanup-rpc";
          const removed = await cleanupDemoTestData(client, userId, subscriptionId);
          evidence.push(
            `Scoped cleanup removed ${removed.effects_deleted} effect(s), ${removed.events_deleted} event(s), ${removed.subscriptions_deleted} subscription row(s), and ${removed.entitlements_deleted} entitlement row(s).`,
          );
        } else if (storedSubscription === null) {
          evidence.push("Cleanup check found no persisted subscription row for this unique test user.");
        } else {
          status = "ERROR";
          evidence.push("Cleanup stopped because the stored subscription ID did not match this run's unique target.");
        }
      } catch (error) {
        status = "ERROR";
        diagnostics.push(safeDiagnostic(error, stage));
        evidence.push("Scoped cleanup could not be confirmed; see the sanitized diagnostic.");
      }
    }
  }

  finish({
    integration: "supabase-isolated-read-write",
    status,
    checkedAt: new Date().toISOString(),
    projectRef: configuration.projectRef,
    evidence,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  });
}

void main().catch((error: unknown) => {
  finish({
    integration: "supabase-isolated-read-write",
    status: "ERROR",
    checkedAt: new Date().toISOString(),
    evidence: [`Unexpected test runner failure (${errorType(error)}); no error message or credential was logged.`],
  });
});
