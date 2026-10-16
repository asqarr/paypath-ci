export const SCENARIO_IDS = [
  "successful-payment",
  "cancellation",
  "duplicate-webhook",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type TestStatus = "PASS" | "FAIL" | "ERROR" | "INCONCLUSIVE";

export type ErrorCode =
  | "ENTITLEMENT_NOT_GRANTED"
  | "ENTITLEMENT_NOT_REVOKED"
  | "DUPLICATE_WEBHOOK_EFFECT"
  | "BILLING_PRECONDITION_NOT_MET"
  | "EVIDENCE_INCOMPLETE"
  | "ADAPTER_ERROR";

export interface BillingSnapshot {
  source: "stripe" | "fixture";
  subscriptionId: string;
  status: string;
  paymentStatus: "paid" | "not_paid" | "unknown";
  currentPeriodEnd: string | null;
  evaluationTime: string | null;
  evaluationTimeSource: "stripe_test_clock" | "system_clock" | "fixture";
  cancelAtPeriodEnd: boolean;
  checkedAt: string;
}

export interface EntitlementSnapshot {
  source: "supabase" | "demo-store";
  userId: string;
  proAccess: boolean | null;
  updatedAt: string | null;
}

/**
 * Distinguishes a successful lookup with no row from a lookup that could not
 * provide evidence. An absent row is a verified lack of persisted access.
 */
export type EntitlementEvidence =
  | { status: "present"; snapshot: EntitlementSnapshot }
  | { status: "absent"; source: EntitlementSnapshot["source"]; userId: string }
  | { status: "unavailable" };

export interface AuthorizationSnapshot {
  source: "demo-api" | "local-api";
  userId: string;
  httpStatus: number | null;
  proAccess: boolean | null;
  checkedAt: string;
}

export interface WebhookDeliveryEvidence {
  eventId: string;
  deliveryCount: number;
  processedCount: number;
}

export interface BusinessEffectEvidence {
  eventId: string;
  effectType: string;
  count: number;
}

export interface ScenarioObservations {
  billing: BillingSnapshot | null;
  applicationSubscriptionId: string | null;
  entitlement: EntitlementEvidence;
  authorization: AuthorizationSnapshot | null;
  webhookDeliveries: WebhookDeliveryEvidence[];
  businessEffects: BusinessEffectEvidence[];
  notes: string[];
}

export interface ExpectedState {
  proAccess: boolean;
  maximumBusinessEffectsPerEvent: number;
}

export interface ActualState {
  stripeStatus: string | null;
  applicationSubscriptionId: string | null;
  paymentStatus: BillingSnapshot["paymentStatus"] | null;
  billingEvaluationTime: string | null;
  evaluationTimeSource: BillingSnapshot["evaluationTimeSource"] | null;
  persistedProAccess: boolean | null;
  authorizedProAccess: boolean | null;
  repeatedEventIds: string[];
  businessEffects: BusinessEffectEvidence[];
}

export interface TestResult {
  scenario: ScenarioId;
  scenarioName: string;
  executionTimestamp: string;
  durationMs: number;
  status: TestStatus;
  errorCode: ErrorCode | null;
  expected: ExpectedState;
  actual: ActualState;
  evidence: string[];
  reproductionSteps: string[];
  source: "local-fixture" | "stripe-supabase-integration";
}

export interface TestReport {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  source: "local-fixture" | "stripe-supabase-integration";
  results: TestResult[];
  summary: {
    passed: number;
    failed: number;
    errors: number;
    inconclusive: number;
  };
}

export interface ScenarioExecutor {
  execute(scenario: ScenarioId): Promise<ScenarioObservations>;
}
