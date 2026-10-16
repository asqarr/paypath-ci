import { SCENARIOS, isActiveSubscription } from "./scenarios.ts";
import type {
  ActualState,
  EntitlementEvidence,
  ErrorCode,
  ExpectedState,
  ScenarioExecutor,
  ScenarioId,
  ScenarioObservations,
  TestResult,
} from "./types.ts";

function parsePeriodEnd(value: string | null): { timestamp: number | null; valid: boolean } {
  if (value === null) return { timestamp: null, valid: true };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { timestamp: parsed, valid: true } : { timestamp: null, valid: false };
}

function deriveExpected(
  scenario: ScenarioId,
  observations: ScenarioObservations,
): { expected: ExpectedState; preconditionMet: boolean } {
  const billing = observations.billing;
  if (billing === null) {
    return {
      expected: { proAccess: scenario !== "cancellation", maximumBusinessEffectsPerEvent: 1 },
      preconditionMet: false,
    };
  }

  const periodEnd = parsePeriodEnd(billing.currentPeriodEnd);
  const evaluationTime = billing.evaluationTime === null ? Number.NaN : Date.parse(billing.evaluationTime);
  const timeAvailable = Number.isFinite(evaluationTime) && periodEnd.valid;
  const active = timeAvailable && isActiveSubscription(billing.status) &&
    (periodEnd.timestamp === null || periodEnd.timestamp > evaluationTime);
  const ended = timeAvailable && billing.status === "canceled" && periodEnd.timestamp !== null &&
    periodEnd.timestamp <= evaluationTime;
  const immediateCancellation = timeAvailable && billing.status === "canceled" &&
    !billing.cancelAtPeriodEnd && periodEnd.timestamp !== null && periodEnd.timestamp > evaluationTime;
  const precondition = SCENARIOS[scenario].billingPrecondition;
  const preconditionMet = precondition === "payment-confirmed"
    ? timeAvailable && billing.status === "active" && billing.paymentStatus === "paid" &&
      periodEnd.timestamp !== null && periodEnd.timestamp > evaluationTime
    : ended || immediateCancellation;

  return {
    expected: {
      proAccess: active,
      maximumBusinessEffectsPerEvent: 1,
    },
    preconditionMet,
  };
}

function actualState(observations: ScenarioObservations): ActualState {
  const repeatedEventIds = observations.webhookDeliveries
    .filter((delivery) => delivery.deliveryCount > 1)
    .map((delivery) => delivery.eventId);

  return {
    stripeStatus: observations.billing?.status ?? null,
    applicationSubscriptionId: observations.applicationSubscriptionId,
    paymentStatus: observations.billing?.paymentStatus ?? null,
    billingEvaluationTime: observations.billing?.evaluationTime ?? null,
    evaluationTimeSource: observations.billing?.evaluationTimeSource ?? null,
    persistedProAccess: persistedEntitlementAccess(observations.entitlement),
    authorizedProAccess: observations.authorization?.proAccess ?? null,
    repeatedEventIds,
    businessEffects: observations.businessEffects,
  };
}

function persistedEntitlementAccess(evidence: EntitlementEvidence): boolean | null {
  switch (evidence.status) {
    case "present":
      return evidence.snapshot.proAccess;
    case "absent":
      return false;
    case "unavailable":
      return null;
  }
}

function entitlementUserId(evidence: EntitlementEvidence): string | null {
  switch (evidence.status) {
    case "present":
      return evidence.snapshot.userId;
    case "absent":
      return evidence.userId;
    case "unavailable":
      return null;
  }
}

function entitlementDescription(evidence: EntitlementEvidence, access: boolean): string {
  return evidence.status === "absent"
    ? `Persisted Pro entitlement is false (no row found for ${evidence.userId} after a successful lookup).`
    : `Persisted Pro entitlement is ${String(access)}.`;
}

function incompleteEvidence(observations: ScenarioObservations, scenario: ScenarioId): string[] {
  const missing: string[] = [];
  if (observations.billing === null) missing.push("Stripe billing state is unavailable.");
  else if (observations.billing.evaluationTime === null) {
    missing.push("Billing evaluation time is unavailable (the Stripe Test Clock may still be advancing).");
  }
  if (observations.applicationSubscriptionId === null) {
    missing.push("Application's persisted subscription record is unavailable.");
  } else if (
    observations.billing !== null &&
    observations.applicationSubscriptionId !== observations.billing.subscriptionId
  ) {
    missing.push("Persisted application subscription does not match the Stripe subscription under test.");
  }
  if (observations.entitlement.status === "unavailable") {
    missing.push("Persisted entitlement state is unavailable.");
  } else if (observations.entitlement.status === "present" && observations.entitlement.snapshot.proAccess === null) {
    missing.push("Persisted entitlement state is unavailable.");
  }
  if (
    observations.authorization === null ||
    observations.authorization.proAccess === null ||
    observations.authorization.httpStatus === null
  ) {
    missing.push("Application authorization result is unavailable.");
  }
  if (
    observations.authorization !== null &&
    entitlementUserId(observations.entitlement) !== null &&
    entitlementUserId(observations.entitlement) !== observations.authorization.userId
  ) {
    missing.push("Persisted entitlement and authorization evidence belong to different users.");
  }
  if (scenario === "duplicate-webhook" && observations.webhookDeliveries.length === 0) {
    missing.push("Webhook delivery evidence is unavailable.");
  }
  if (scenario === "duplicate-webhook" && observations.businessEffects.length === 0) {
    missing.push("Business-effect evidence is unavailable.");
  }
  return missing;
}

export async function runScenario(
  executor: ScenarioExecutor,
  scenario: ScenarioId,
  source: TestResult["source"] = "local-fixture",
): Promise<TestResult> {
  const started = Date.now();
  const executionTimestamp = new Date(started).toISOString();
  const definition = SCENARIOS[scenario];
  const baseline: TestResult = {
    scenario,
    scenarioName: definition.name,
    executionTimestamp,
    durationMs: 0,
    status: "INCONCLUSIVE",
    errorCode: "EVIDENCE_INCOMPLETE",
    expected: { proAccess: scenario !== "cancellation", maximumBusinessEffectsPerEvent: 1 },
    actual: {
      stripeStatus: null,
      applicationSubscriptionId: null,
      paymentStatus: null,
      billingEvaluationTime: null,
      evaluationTimeSource: null,
      persistedProAccess: null,
      authorizedProAccess: null,
      repeatedEventIds: [],
      businessEffects: [],
    },
    evidence: [],
    reproductionSteps: definition.reproductionSteps,
    source,
  };

  try {
    const observations = await executor.execute(scenario);
    const { expected, preconditionMet } = deriveExpected(scenario, observations);
    const actual = actualState(observations);
    const missing = incompleteEvidence(observations, scenario);
    const evidence = [...observations.notes];
    const result: TestResult = {
      ...baseline,
      expected,
      actual,
      evidence,
      durationMs: Date.now() - started,
    };

    if (missing.length > 0) {
      return {
        ...result,
        status: "INCONCLUSIVE",
        errorCode: "EVIDENCE_INCOMPLETE",
        evidence: [...evidence, ...missing],
      };
    }

    if (!preconditionMet) {
      return {
        ...result,
        status: "INCONCLUSIVE",
        errorCode: "BILLING_PRECONDITION_NOT_MET",
        evidence: [
          ...evidence,
          `Billing precondition for ${scenario} was not established; application state was not scored.`,
        ],
      };
    }

    const billing = observations.billing;
    const entitlement = observations.entitlement;
    const authorization = observations.authorization;
    if (billing === null || entitlement.status === "unavailable" || authorization === null) {
      return { ...result, status: "INCONCLUSIVE", errorCode: "EVIDENCE_INCOMPLETE" };
    }
    if (authorization.httpStatus !== 200 && authorization.httpStatus !== 403) {
      return {
        ...result,
        status: "ERROR",
        errorCode: "ADAPTER_ERROR",
        evidence: [...evidence, `Authorization API returned unexpected HTTP ${authorization.httpStatus}.`],
      };
    }

    if (scenario === "duplicate-webhook") {
      const persisted = persistedEntitlementAccess(entitlement);
      if (persisted === null) {
        return { ...result, status: "INCONCLUSIVE", errorCode: "EVIDENCE_INCOMPLETE" };
      }
      const repeated = observations.webhookDeliveries.filter((delivery) => delivery.deliveryCount > 1);
      if (repeated.length === 0) {
        return {
          ...result,
          status: "INCONCLUSIVE",
          errorCode: "EVIDENCE_INCOMPLETE",
          evidence: [...evidence, "No repeated event ID was observed; duplicate handling was not exercised."],
        };
      }
      const repeatedIds = new Set(repeated.map((delivery) => delivery.eventId));
      const effectsForRepeated = observations.businessEffects.filter((effect) => repeatedIds.has(effect.eventId));
      if (effectsForRepeated.length === 0) {
        return {
          ...result,
          status: "INCONCLUSIVE",
          errorCode: "EVIDENCE_INCOMPLETE",
          evidence: [...evidence, "Repeated delivery was observed, but no business effect was linked to that event ID."],
        };
      }
      const duplicateEvents = [...repeatedIds].flatMap((eventId) => {
        const eventEffects = effectsForRepeated.filter((effect) => effect.eventId === eventId);
        const total = eventEffects.reduce((sum, effect) => sum + effect.count, 0);
        return total > 1 ? [{ eventId, effects: eventEffects, total }] : [];
      });
      if (duplicateEvents.length > 0) {
        return {
          ...result,
          status: "FAIL",
          errorCode: "DUPLICATE_WEBHOOK_EFFECT",
          evidence: [
            ...evidence,
            ...repeated.map((delivery) =>
              `Event ${delivery.eventId} had ${delivery.deliveryCount} deliveries and ${delivery.processedCount} processing attempts.`,
            ),
            ...duplicateEvents.map((duplicate) =>
              `Event ${duplicate.eventId} created ${duplicate.total} business effects (${duplicate.effects.map((effect) => `${effect.count} ${effect.effectType}`).join(", ")}).`,
            ),
          ],
        };
      }
      const expectedAuthorizationStatus = expected.proAccess ? 200 : 403;
      if (
        persisted !== expected.proAccess ||
        authorization.proAccess !== expected.proAccess ||
        authorization.httpStatus !== expectedAuthorizationStatus
      ) {
        return {
          ...result,
          status: "FAIL",
          errorCode: "ENTITLEMENT_NOT_GRANTED",
          evidence: [
            ...evidence,
            `${entitlementDescription(entitlement, persisted)} Expected ${String(expected.proAccess)}.`,
            `Application authorization returned Pro access ${String(authorization.proAccess)}; expected ${String(expected.proAccess)}.`,
            "No duplicate business effect was observed, but the entitlement outcome is incorrect.",
          ],
        };
      }
      return {
        ...result,
        status: "PASS",
        errorCode: null,
        evidence: [
          ...evidence,
          ...repeated.map((delivery) =>
            `Event ${delivery.eventId} had ${delivery.deliveryCount} deliveries with ${delivery.processedCount} processing attempt(s).`,
          ),
          "No repeated business effect was found for the repeated event ID.",
        ],
      };
    }

    const persisted = persistedEntitlementAccess(entitlement);
    if (persisted === null) {
      return { ...result, status: "INCONCLUSIVE", errorCode: "EVIDENCE_INCOMPLETE" };
    }
    const authorized = authorization.proAccess;
    const expectedAuthorizationStatus = expected.proAccess ? 200 : 403;
    const mismatch =
      persisted !== expected.proAccess ||
      authorized !== expected.proAccess ||
      authorization.httpStatus !== expectedAuthorizationStatus;
    if (!mismatch) {
      return {
        ...result,
        status: "PASS",
        errorCode: null,
        evidence: [
          ...evidence,
          `Stripe subscription status is ${billing.status}.`,
          `Stripe latest invoice payment status is ${billing.paymentStatus}.`,
          entitlementDescription(entitlement, persisted),
          `Application authorization returned Pro access ${String(authorized)} (HTTP ${authorization.httpStatus}).`,
        ],
      };
    }

    const errorCode: ErrorCode = expected.proAccess ? "ENTITLEMENT_NOT_GRANTED" : "ENTITLEMENT_NOT_REVOKED";
    return {
      ...result,
      status: "FAIL",
      errorCode,
      evidence: [
        ...evidence,
        `Stripe subscription status is ${billing.status}.`,
        `Stripe latest invoice payment status is ${billing.paymentStatus}.`,
        `${entitlementDescription(entitlement, persisted)} Expected ${String(expected.proAccess)}.`,
        `Application authorization returned Pro access ${String(authorized)} (HTTP ${authorization.httpStatus}); expected ${String(expected.proAccess)}.`,
      ],
    };
  } catch (error) {
    const safeMessage = error instanceof Error ? error.name : "Unknown adapter failure.";
    return {
      ...baseline,
      status: "ERROR",
      errorCode: "ADAPTER_ERROR",
      durationMs: Date.now() - started,
      evidence: [`Scenario executor failed: ${safeMessage}`],
    };
  }
}
