import { describe, expect, it } from "vitest";
import { runScenario } from "./engine.ts";
import { runScenarios } from "./report.ts";
import type { ScenarioExecutor, ScenarioObservations } from "./types.ts";
import { LocalScenarioExecutor } from "@paypath/demo-engine";

describe("PayPath entitlement truth engine", () => {
  it("passes all three fixed scenarios", async () => {
    const report = await runScenarios(new LocalScenarioExecutor("fixed"), [
      "successful-payment",
      "cancellation",
      "duplicate-webhook",
    ]);

    expect(report.results.map((result) => result.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(report.summary).toEqual({ passed: 3, failed: 0, errors: 0, inconclusive: 0 });
  });

  it("detects each intentional defect from application evidence", async () => {
    const report = await runScenarios(new LocalScenarioExecutor("buggy"), [
      "successful-payment",
      "cancellation",
      "duplicate-webhook",
    ]);

    expect(report.results.map((result) => [result.status, result.errorCode])).toEqual([
      ["FAIL", "ENTITLEMENT_NOT_GRANTED"],
      ["FAIL", "ENTITLEMENT_NOT_REVOKED"],
      ["FAIL", "DUPLICATE_WEBHOOK_EFFECT"],
    ]);
  });

  it("does not treat repeated delivery logs as duplicate business effects", async () => {
    const observations: ScenarioObservations = {
      billing: {
        source: "fixture",
        subscriptionId: "sub_safe",
        status: "active",
        paymentStatus: "paid",
        currentPeriodEnd: new Date(Date.now() + 60_000).toISOString(),
        evaluationTime: new Date().toISOString(),
        evaluationTimeSource: "fixture",
        cancelAtPeriodEnd: false,
        checkedAt: new Date().toISOString(),
      },
      applicationSubscriptionId: "sub_safe",
      entitlement: {
        status: "present",
        snapshot: { source: "demo-store", userId: "user_safe", proAccess: true, updatedAt: new Date().toISOString() },
      },
      authorization: {
        source: "local-api",
        userId: "user_safe",
        httpStatus: 200,
        proAccess: true,
        checkedAt: new Date().toISOString(),
      },
      webhookDeliveries: [{ eventId: "evt_same", deliveryCount: 2, processedCount: 1 }],
      businessEffects: [{ eventId: "evt_same", effectType: "entitlement_granted", count: 1 }],
      notes: [],
    };
    const executor: ScenarioExecutor = { execute: async () => observations };

    const result = await runScenario(executor, "duplicate-webhook");

    expect(result.status).toBe("PASS");
    expect(result.errorCode).toBeNull();
  });

  it("does not compare billing with an unrelated persisted subscription", async () => {
    const observations = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    observations.applicationSubscriptionId = "sub_unrelated_test_record";
    const result = await runScenario({ execute: async () => observations }, "successful-payment");

    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.errorCode).toBe("EVIDENCE_INCOMPLETE");
    expect(result.evidence).toContain("Persisted application subscription does not match the Stripe subscription under test.");
  });

  it("counts all effects linked to one repeated event, including different effect types", async () => {
    const baseline = await new LocalScenarioExecutor("fixed").execute("duplicate-webhook");
    baseline.businessEffects = [
      { eventId: "evt_fixtureduplicatewebhook", effectType: "entitlement_granted", count: 1 },
      { eventId: "evt_fixtureduplicatewebhook", effectType: "notification_sent", count: 1 },
    ];
    const executor: ScenarioExecutor = { execute: async () => baseline };

    const result = await runScenario(executor, "duplicate-webhook");

    expect(result.status).toBe("FAIL");
    expect(result.errorCode).toBe("DUPLICATE_WEBHOOK_EFFECT");
  });

  it("returns ERROR when an adapter is unavailable", async () => {
    const executor: ScenarioExecutor = {
      execute: async () => {
        throw new Error("database connection refused");
      },
    };

    const result = await runScenario(executor, "successful-payment");

    expect(result.status).toBe("ERROR");
    expect(result.errorCode).toBe("ADAPTER_ERROR");
  });

  it("returns INCONCLUSIVE when evidence or billing preconditions are missing", async () => {
    const missingEvidence: ScenarioExecutor = {
      execute: async () => ({
        billing: null,
        applicationSubscriptionId: null,
        entitlement: { status: "unavailable" },
        authorization: null,
        webhookDeliveries: [],
        businessEffects: [],
        notes: ["Integration is not configured."],
      }),
    };
    const missingPaymentProof: ScenarioExecutor = {
      execute: async () => ({
        billing: {
          source: "fixture",
          subscriptionId: "sub_pending",
          status: "active",
          paymentStatus: "unknown",
          currentPeriodEnd: new Date(Date.now() + 60_000).toISOString(),
          evaluationTime: new Date().toISOString(),
          evaluationTimeSource: "fixture",
          cancelAtPeriodEnd: false,
          checkedAt: new Date().toISOString(),
        },
        applicationSubscriptionId: "sub_pending",
        entitlement: {
          status: "present",
          snapshot: { source: "demo-store", userId: "user_pending", proAccess: true, updatedAt: null },
        },
        authorization: {
          source: "local-api",
          userId: "user_pending",
          httpStatus: 200,
          proAccess: true,
          checkedAt: new Date().toISOString(),
        },
        webhookDeliveries: [],
        businessEffects: [],
        notes: [],
      }),
    };

    const noEvidenceResult = await runScenario(missingEvidence, "successful-payment");
    const noPaymentProofResult = await runScenario(missingPaymentProof, "successful-payment");

    expect(noEvidenceResult.status).toBe("INCONCLUSIVE");
    expect(noPaymentProofResult.status).toBe("INCONCLUSIVE");
    expect(noPaymentProofResult.errorCode).toBe("BILLING_PRECONDITION_NOT_MET");
  });

  it("fails successful payment when a completed entitlement lookup confirms there is no row", async () => {
    const observations = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    const userId = observations.authorization!.userId;
    observations.entitlement = { status: "absent", source: "supabase", userId };
    observations.authorization = { ...observations.authorization!, httpStatus: 403, proAccess: false };

    const result = await runScenario({ execute: async () => observations }, "successful-payment");

    expect(result.status).toBe("FAIL");
    expect(result.errorCode).toBe("ENTITLEMENT_NOT_GRANTED");
    expect(result.actual.persistedProAccess).toBe(false);
    expect(result.evidence).toContain(
      `Persisted Pro entitlement is false (no row found for ${userId} after a successful lookup). Expected true.`,
    );
  });

  it("fails successful payment when the persisted entitlement is explicitly inactive", async () => {
    const observations = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    if (observations.entitlement.status !== "present") throw new Error("Expected a persisted entitlement fixture.");
    observations.entitlement.snapshot.proAccess = false;
    observations.authorization = { ...observations.authorization!, httpStatus: 403, proAccess: false };

    const result = await runScenario({ execute: async () => observations }, "successful-payment");

    expect(result.status).toBe("FAIL");
    expect(result.errorCode).toBe("ENTITLEMENT_NOT_GRANTED");
  });

  it("passes successful payment when persisted entitlement and authorization both grant access", async () => {
    const observations = await new LocalScenarioExecutor("fixed").execute("successful-payment");

    const result = await runScenario({ execute: async () => observations }, "successful-payment");

    expect(result.status).toBe("PASS");
    expect(result.errorCode).toBeNull();
  });

  it("keeps a failed Supabase entitlement read inconclusive", async () => {
    const observations = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    observations.entitlement = { status: "unavailable" };

    const result = await runScenario({ execute: async () => observations }, "successful-payment");

    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.errorCode).toBe("EVIDENCE_INCOMPLETE");
    expect(result.errorCode).not.toBe("ENTITLEMENT_NOT_GRANTED");
  });

  it("keeps invalid entitlement values inconclusive", async () => {
    const observations = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    if (observations.entitlement.status !== "present") throw new Error("Expected a persisted entitlement fixture.");
    observations.entitlement.snapshot.proAccess = null;

    const result = await runScenario({ execute: async () => observations }, "successful-payment");

    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.errorCode).toBe("EVIDENCE_INCOMPLETE");
  });

  it("does not report entitlement-not-granted before payment and active-subscription preconditions hold", async () => {
    const unpaid = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    unpaid.billing!.paymentStatus = "not_paid";
    unpaid.entitlement = { status: "absent", source: "supabase", userId: unpaid.authorization!.userId };
    unpaid.authorization = { ...unpaid.authorization!, httpStatus: 403, proAccess: false };

    const inactive = await new LocalScenarioExecutor("fixed").execute("successful-payment");
    inactive.billing!.status = "canceled";
    inactive.entitlement = { status: "absent", source: "supabase", userId: inactive.authorization!.userId };
    inactive.authorization = { ...inactive.authorization!, httpStatus: 403, proAccess: false };

    const unpaidResult = await runScenario({ execute: async () => unpaid }, "successful-payment");
    const inactiveResult = await runScenario({ execute: async () => inactive }, "successful-payment");

    expect(unpaidResult.status).toBe("INCONCLUSIVE");
    expect(unpaidResult.errorCode).toBe("BILLING_PRECONDITION_NOT_MET");
    expect(inactiveResult.status).toBe("INCONCLUSIVE");
    expect(inactiveResult.errorCode).toBe("BILLING_PRECONDITION_NOT_MET");
  });

  it("keeps access during a scheduled cancellation period and revokes after an immediate cancellation", async () => {
    const now = new Date().toISOString();
    const activeDuringScheduledCancel: ScenarioExecutor = {
      execute: async () => ({
        billing: {
          source: "fixture",
          subscriptionId: "sub_cancel_at_period_end",
          status: "active",
          paymentStatus: "paid",
          currentPeriodEnd: new Date(Date.now() + 60_000).toISOString(),
          evaluationTime: now,
          evaluationTimeSource: "fixture",
          cancelAtPeriodEnd: true,
          checkedAt: now,
        },
        applicationSubscriptionId: "sub_cancel_at_period_end",
        entitlement: {
          status: "present",
          snapshot: { source: "demo-store", userId: "user_scheduled", proAccess: true, updatedAt: now },
        },
        authorization: {
          source: "local-api",
          userId: "user_scheduled",
          httpStatus: 200,
          proAccess: true,
          checkedAt: now,
        },
        webhookDeliveries: [],
        businessEffects: [],
        notes: [],
      }),
    };
    const immediatelyCanceled: ScenarioExecutor = {
      execute: async () => ({
        billing: {
          source: "fixture",
          subscriptionId: "sub_canceled_now",
          status: "canceled",
          paymentStatus: "paid",
          currentPeriodEnd: new Date(Date.now() + 60_000).toISOString(),
          evaluationTime: now,
          evaluationTimeSource: "fixture",
          cancelAtPeriodEnd: false,
          checkedAt: now,
        },
        applicationSubscriptionId: "sub_canceled_now",
        entitlement: {
          status: "present",
          snapshot: { source: "demo-store", userId: "user_immediate", proAccess: false, updatedAt: now },
        },
        authorization: {
          source: "local-api",
          userId: "user_immediate",
          httpStatus: 403,
          proAccess: false,
          checkedAt: now,
        },
        webhookDeliveries: [],
        businessEffects: [],
        notes: [],
      }),
    };

    const scheduledResult = await runScenario(activeDuringScheduledCancel, "successful-payment");
    const immediateResult = await runScenario(immediatelyCanceled, "cancellation");

    expect(scheduledResult.status).toBe("PASS");
    expect(immediateResult.status).toBe("PASS");
  });

  it("produces the same outcomes regardless of scenario order", async () => {
    const scenarios = ["successful-payment", "cancellation", "duplicate-webhook"] as const;
    const forwards = await runScenarios(new LocalScenarioExecutor("fixed"), [...scenarios]);
    const backwards = await runScenarios(new LocalScenarioExecutor("fixed"), [...scenarios].reverse());
    const forwardOutcomes = new Map(forwards.results.map(({ scenario, status }) => [scenario, status]));
    const backwardOutcomes = new Map(backwards.results.map(({ scenario, status }) => [scenario, status]));

    expect(backwardOutcomes).toEqual(forwardOutcomes);
  });
});
