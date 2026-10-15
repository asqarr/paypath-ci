import { SCENARIO_IDS, type ScenarioId } from "@paypath/core";

export type PullRequestGateMode = "fixed" | "buggy";

export interface PullRequestGateExecution {
  mode: PullRequestGateMode;
  exitCode: number | null;
  report: unknown;
  processError?: string;
}

export interface PullRequestGateScenarioCheck {
  scenario: ScenarioId;
  expectedStatus: "PASS" | "FAIL";
  expectedErrorCode: string | null;
  actualStatus: string | null;
  actualErrorCode: string | null;
  verified: boolean;
}

export interface PullRequestGateModeCheck {
  mode: PullRequestGateMode;
  expectedCliExitCode: 0 | 1;
  actualCliExitCode: number | null;
  verified: boolean;
  issues: string[];
  scenarios: PullRequestGateScenarioCheck[];
}

export interface PullRequestGateReport {
  schemaVersion: 1;
  gate: "paypath-local-pr-gate";
  source: "local-fixture";
  generatedAt: string;
  status: "PASS" | "FAIL";
  exitCode: 0 | 1;
  checks: PullRequestGateModeCheck[];
  summary: {
    verifiedModes: number;
    verifiedScenarios: number;
    issues: number;
  };
}

const EXPECTED: Record<
  PullRequestGateMode,
  Record<ScenarioId, { status: "PASS" | "FAIL"; errorCode: string | null }>
> = {
  fixed: {
    "successful-payment": { status: "PASS", errorCode: null },
    cancellation: { status: "PASS", errorCode: null },
    "duplicate-webhook": { status: "PASS", errorCode: null },
  },
  buggy: {
    "successful-payment": { status: "FAIL", errorCode: "ENTITLEMENT_NOT_GRANTED" },
    cancellation: { status: "FAIL", errorCode: "ENTITLEMENT_NOT_REVOKED" },
    "duplicate-webhook": { status: "FAIL", errorCode: "DUPLICATE_WEBHOOK_EFFECT" },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actualResultsByScenario(report: unknown): Map<string, { status: string | null; errorCode: string | null }> | null {
  if (!isRecord(report) || !Array.isArray(report["results"])) return null;
  const results = new Map<string, { status: string | null; errorCode: string | null }>();
  for (const value of report["results"]) {
    if (!isRecord(value) || typeof value["scenario"] !== "string") return null;
    const scenario = value["scenario"];
    if (results.has(scenario)) return null;
    results.set(scenario, {
      status: typeof value["status"] === "string" ? value["status"] : null,
      errorCode: typeof value["errorCode"] === "string" ? value["errorCode"] : null,
    });
  }
  return results;
}

function summaryMatches(report: unknown, results: Map<string, { status: string | null; errorCode: string | null }>): boolean {
  if (!isRecord(report) || !isRecord(report["summary"])) return false;
  const summary = report["summary"];
  const counts = {
    passed: [...results.values()].filter((result) => result.status === "PASS").length,
    failed: [...results.values()].filter((result) => result.status === "FAIL").length,
    errors: [...results.values()].filter((result) => result.status === "ERROR").length,
    inconclusive: [...results.values()].filter((result) => result.status === "INCONCLUSIVE").length,
  };
  return Object.entries(counts).every(([key, count]) => summary[key] === count);
}

function verifyMode(execution: PullRequestGateExecution | undefined, mode: PullRequestGateMode): PullRequestGateModeCheck {
  const expectedCliExitCode = mode === "fixed" ? 0 : 1;
  const issues: string[] = [];
  if (execution === undefined) issues.push(`No CLI execution was recorded for ${mode} mode.`);
  if (execution?.processError !== undefined) issues.push(`${mode} CLI process failed to start: ${execution.processError}`);
  if (execution?.exitCode !== expectedCliExitCode) {
    issues.push(`${mode} CLI exit code was ${String(execution?.exitCode)}; expected ${expectedCliExitCode}.`);
  }

  const report = execution?.report;
  const results = actualResultsByScenario(report);
  if (!isRecord(report) || report["schemaVersion"] !== 1) {
    issues.push(`${mode} CLI did not produce a supported PayPath report.`);
  }
  if (!isRecord(report) || report["source"] !== "local-fixture") {
    issues.push(`${mode} report source must be local-fixture; external integration evidence is not used by this gate.`);
  }
  if (results === null) issues.push(`${mode} report results are missing, malformed, or contain duplicate scenario IDs.`);
  if (results !== null && results.size !== SCENARIO_IDS.length) {
    issues.push(`${mode} report contained ${results.size} scenarios; expected ${SCENARIO_IDS.length}.`);
  }
  if (results !== null && !summaryMatches(report, results)) {
    issues.push(`${mode} report summary counts do not match its scenario results.`);
  }

  const scenarios = SCENARIO_IDS.map((scenario): PullRequestGateScenarioCheck => {
    const expected = EXPECTED[mode][scenario];
    const actual = results?.get(scenario);
    const verified =
      actual !== undefined &&
      actual.status === expected.status &&
      actual.errorCode === expected.errorCode;
    if (!verified) {
      issues.push(
        `${mode}/${scenario}: expected ${expected.status}${expected.errorCode === null ? "" : ` (${expected.errorCode})`}, ` +
          `received ${actual?.status ?? "no result"}${actual?.errorCode === null || actual?.errorCode === undefined ? "" : ` (${actual.errorCode})`}.`,
      );
    }
    return {
      scenario,
      expectedStatus: expected.status,
      expectedErrorCode: expected.errorCode,
      actualStatus: actual?.status ?? null,
      actualErrorCode: actual?.errorCode ?? null,
      verified,
    };
  });

  return {
    mode,
    expectedCliExitCode,
    actualCliExitCode: execution?.exitCode ?? null,
    verified: issues.length === 0,
    issues,
    scenarios,
  };
}

export function evaluatePullRequestGate(
  executions: readonly PullRequestGateExecution[],
  generatedAt = new Date().toISOString(),
): PullRequestGateReport {
  const checks = (["fixed", "buggy"] as const).map((mode) =>
    verifyMode(executions.find((execution) => execution.mode === mode), mode),
  );
  const issues = checks.reduce((total, check) => total + check.issues.length, 0);
  const status = issues === 0 ? "PASS" : "FAIL";
  return {
    schemaVersion: 1,
    gate: "paypath-local-pr-gate",
    source: "local-fixture",
    generatedAt,
    status,
    exitCode: status === "PASS" ? 0 : 1,
    checks,
    summary: {
      verifiedModes: checks.filter((check) => check.verified).length,
      verifiedScenarios: checks.reduce(
        (total, check) => total + check.scenarios.filter((scenario) => scenario.verified).length,
        0,
      ),
      issues,
    },
  };
}
