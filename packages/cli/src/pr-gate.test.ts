import { describe, expect, it } from "vitest";
import { SCENARIO_IDS, type ErrorCode, type ScenarioId, type TestReport, type TestStatus } from "@paypath/core";
import { evaluatePullRequestGate, type PullRequestGateExecution } from "./pr-gate.ts";

const BUG_CODES: Record<ScenarioId, ErrorCode> = {
  "successful-payment": "ENTITLEMENT_NOT_GRANTED",
  cancellation: "ENTITLEMENT_NOT_REVOKED",
  "duplicate-webhook": "DUPLICATE_WEBHOOK_EFFECT",
};

function reportFor(mode: "fixed" | "buggy"): TestReport {
  const results = SCENARIO_IDS.map((scenario) => {
    const status: TestStatus = mode === "fixed" ? "PASS" : "FAIL";
    const proAccess = scenario === "cancellation"
      ? mode === "buggy"
      : scenario === "successful-payment"
        ? mode === "fixed"
        : true;
    return {
      scenario,
      scenarioName: scenario,
      executionTimestamp: "2026-01-01T00:00:00.000Z",
      durationMs: 1,
      status,
      errorCode: mode === "fixed" ? null : BUG_CODES[scenario],
      expected: { proAccess: scenario !== "cancellation", maximumBusinessEffectsPerEvent: 1 },
      actual: {
        stripeStatus: "active",
        applicationSubscriptionId: "sub_fixture",
        paymentStatus: "paid" as const,
        billingEvaluationTime: "2026-01-01T00:00:00.000Z",
        evaluationTimeSource: "fixture" as const,
        persistedProAccess: proAccess,
        authorizedProAccess: proAccess,
        repeatedEventIds: [],
        businessEffects: [],
      },
      evidence: ["Local deterministic fixture; no external service was called."],
      reproductionSteps: [],
      source: "local-fixture" as const,
    };
  });
  return {
    schemaVersion: 1,
    runId: `test-${mode}`,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source: "local-fixture",
    results,
    summary: {
      passed: mode === "fixed" ? 3 : 0,
      failed: mode === "buggy" ? 3 : 0,
      errors: 0,
      inconclusive: 0,
    },
  };
}

function executions(
  fixedReport: unknown = reportFor("fixed"),
  buggyReport: unknown = reportFor("buggy"),
  fixedExitCode = 0,
  buggyExitCode = 1,
): PullRequestGateExecution[] {
  return [
    { mode: "fixed", exitCode: fixedExitCode, report: fixedReport },
    { mode: "buggy", exitCode: buggyExitCode, report: buggyReport },
  ];
}

describe("PayPath local PR gate contract", () => {
  it("accepts all Fixed passes and all three expected Buggy detections", () => {
    const result = evaluatePullRequestGate(executions(), "2026-01-01T00:00:00.000Z");

    expect(result).toMatchObject({ status: "PASS", exitCode: 0, summary: { verifiedModes: 2, verifiedScenarios: 6, issues: 0 } });
  });

  it("returns a non-zero gate exit code if a Fixed scenario regresses", () => {
    const regressed = reportFor("fixed");
    regressed.results[0]!.status = "FAIL";
    regressed.results[0]!.errorCode = "ENTITLEMENT_NOT_GRANTED";
    regressed.results[0]!.actual.persistedProAccess = false;
    regressed.results[0]!.actual.authorizedProAccess = false;
    regressed.summary = { passed: 2, failed: 1, errors: 0, inconclusive: 0 };

    const result = evaluatePullRequestGate(executions(regressed));

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.checks[0]?.issues).toContain(
      "fixed/successful-payment: expected PASS, received FAIL (ENTITLEMENT_NOT_GRANTED).",
    );
  });

  it("requires the Buggy CLI itself to return non-zero for detected billing failures", () => {
    const result = evaluatePullRequestGate(executions(reportFor("fixed"), reportFor("buggy"), 0, 0));

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.checks[1]?.issues).toContain("buggy CLI exit code was 0; expected 1.");
  });

  it.each(["ERROR", "INCONCLUSIVE"] as const)("rejects %s as a valid Buggy detection", (status) => {
    const unexpected = reportFor("buggy");
    unexpected.results[0]!.status = status;
    unexpected.results[0]!.errorCode = status === "ERROR" ? "ADAPTER_ERROR" : "EVIDENCE_INCOMPLETE";
    unexpected.summary = { passed: 0, failed: 2, errors: status === "ERROR" ? 1 : 0, inconclusive: status === "INCONCLUSIVE" ? 1 : 0 };

    const result = evaluatePullRequestGate(executions(reportFor("fixed"), unexpected));

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
  });

  it("rejects reports that are not explicitly labeled as local fixtures", () => {
    const external = { ...reportFor("fixed"), source: "stripe-supabase-integration" };
    const result = evaluatePullRequestGate(executions(external));

    expect(result.status).toBe("FAIL");
    expect(result.exitCode).toBe(1);
    expect(result.checks[0]?.issues).toContain(
      "fixed report source must be local-fixture; external integration evidence is not used by this gate.",
    );
  });
});
