import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluatePullRequestGate, type PullRequestGateExecution, type PullRequestGateReport } from "../packages/cli/src/pr-gate.ts";

const repositoryRoot = process.cwd();
const artifactDirectory = path.join(repositoryRoot, "artifacts");
const SAFE_STATUSES = new Set(["PASS", "FAIL", "ERROR", "INCONCLUSIVE"]);
const SAFE_ERROR_CODES = new Set([
  "ENTITLEMENT_NOT_GRANTED",
  "ENTITLEMENT_NOT_REVOKED",
  "DUPLICATE_WEBHOOK_EFFECT",
  "BILLING_PRECONDITION_NOT_MET",
  "EVIDENCE_INCOMPLETE",
  "ADAPTER_ERROR",
]);

function safeValue(value: string | null, allowed: Set<string>): string {
  if (value === null) return "—";
  return allowed.has(value) ? value : "INVALID";
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .slice(0, 500);
}

function credentialFreeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "PAYPATH_STRIPE_SUBSCRIPTION_ID",
    "PAYPATH_STRIPE_SUBSCRIPTION_ID_SUCCESSFUL_PAYMENT",
    "PAYPATH_STRIPE_SUBSCRIPTION_ID_CANCELLATION",
    "PAYPATH_STRIPE_SUBSCRIPTION_ID_DUPLICATE_WEBHOOK",
    "PAYPATH_WEBHOOK_EVENT_ID",
    "PAYPATH_WEBHOOK_EVENT_ID_DUPLICATE_WEBHOOK",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PAYPATH_TEST_SUPABASE_REF",
    "PAYPATH_SUPABASE_TEST_PROJECT_ACK",
    "PAYPATH_RUN_SUPABASE_INTEGRATION",
  ]) {
    environment[name] = "";
  }
  return environment;
}

async function readReport(reportPath: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    return parsed;
  } catch {
    return undefined;
  }
}

async function runCliMode(mode: "fixed" | "buggy"): Promise<PullRequestGateExecution> {
  const relativeReportPath = path.join("artifacts", `paypath-${mode}.json`);
  const reportPath = path.join(repositoryRoot, relativeReportPath);
  await rm(reportPath, { force: true });

  const npmCliPath = process.env["npm_execpath"];
  if (npmCliPath === undefined || npmCliPath.length === 0) {
    return { mode, exitCode: null, report: undefined, processError: "npm_execpath is unavailable; run this gate through npm." };
  }

  const child = spawnSync(
    process.execPath,
    [npmCliPath, "run", "paypath", "--", "test", "--mode", mode, "--report", relativeReportPath],
    {
      cwd: repositoryRoot,
      env: credentialFreeEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  if (child.error !== undefined) {
    return {
      mode,
      exitCode: child.status,
      report: await readReport(reportPath),
      processError: child.error.message,
    };
  }
  return { mode, exitCode: child.status, report: await readReport(reportPath) };
}

function renderSummary(report: PullRequestGateReport): string {
  const lines = [
    `# PayPath CI PR Gate: ${report.status}`,
    "",
    "This run uses local deterministic fixtures only. No Stripe or Supabase service is contacted, and no credentials are required.",
    "",
    "| Mode | CLI exit | Gate validation |",
    "| --- | ---: | --- |",
    ...report.checks.map((check) =>
      `| ${check.mode} | ${check.actualCliExitCode === null ? "not started" : check.actualCliExitCode} (expected ${check.expectedCliExitCode}) | ${check.verified ? "PASS" : "FAIL"} |`,
    ),
    "",
    "| Scenario | Fixed expected | Fixed actual | Buggy expected | Buggy actual |",
    "| --- | --- | --- | --- | --- |",
  ];

  const fixed = report.checks.find((check) => check.mode === "fixed");
  const buggy = report.checks.find((check) => check.mode === "buggy");
  for (const scenario of fixed?.scenarios ?? []) {
    const buggyScenario = buggy?.scenarios.find((entry) => entry.scenario === scenario.scenario);
    const buggyActual = buggyScenario === undefined
      ? "missing"
      : `${safeValue(buggyScenario.actualStatus, SAFE_STATUSES)}${buggyScenario.actualErrorCode === null ? "" : ` (${safeValue(buggyScenario.actualErrorCode, SAFE_ERROR_CODES)})`}`;
    const fixedActual = `${safeValue(scenario.actualStatus, SAFE_STATUSES)}${scenario.actualErrorCode === null ? "" : ` (${safeValue(scenario.actualErrorCode, SAFE_ERROR_CODES)})`}`;
    lines.push(
      `| ${scenario.scenario} | ${scenario.expectedStatus}${scenario.expectedErrorCode === null ? "" : ` (${scenario.expectedErrorCode})`} | ${fixedActual} | ${buggyScenario?.expectedStatus ?? "missing"}${buggyScenario?.expectedErrorCode === null || buggyScenario?.expectedErrorCode === undefined ? "" : ` (${buggyScenario.expectedErrorCode})`} | ${buggyActual} |`,
    );
  }

  if (report.checks.some((check) => check.issues.length > 0)) {
    lines.push("", "## Gate issues", "");
    for (const check of report.checks) {
      for (const issue of check.issues) lines.push(`- **${check.mode}:** ${escapeMarkdown(issue)}`);
    }
  }
  lines.push(
    "",
    `Verified modes: ${report.summary.verifiedModes}/2. Verified scenarios: ${report.summary.verifiedScenarios}/6. Gate issues: ${report.summary.issues}.`,
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const executions: PullRequestGateExecution[] = [];
  executions.push(await runCliMode("fixed"));
  executions.push(await runCliMode("buggy"));

  const report = evaluatePullRequestGate(executions);
  await writeFile(path.join(artifactDirectory, "paypath-pr-gate.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(artifactDirectory, "paypath-pr-gate-summary.md"), renderSummary(report), "utf8");

  console.log(`\nPayPath local PR Gate: ${report.status}`);
  console.log(`Verified modes: ${report.summary.verifiedModes}/2; scenarios: ${report.summary.verifiedScenarios}/6; issues: ${report.summary.issues}.`);
  console.log("Reports: artifacts/paypath-pr-gate.json and artifacts/paypath-pr-gate-summary.md");
  process.exitCode = report.exitCode;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `PayPath PR Gate could not complete (${error.name}).` : "PayPath PR Gate could not complete.");
  process.exitCode = 1;
});
