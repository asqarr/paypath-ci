#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
import { SCENARIO_IDS, runScenarios, type ScenarioId } from "@paypath/core";
import { LocalScenarioExecutor } from "@paypath/demo-engine";
import { parseStripeTestConfiguration } from "@paypath/stripe-adapter";
import {
  cleanupDemoTestData,
  createSupabaseTestClient,
  parseSupabaseIntegrationConfiguration,
  validateDemoCleanupTarget,
} from "@paypath/supabase-adapter";
import { z } from "zod";
import { IntegrationScenarioExecutor } from "./integration-executor.ts";

dotenv.config({ path: [".env.integration.local", ".env"] });

interface CliOptions {
  command: "doctor" | "test" | "cleanup";
  mode: "buggy" | "fixed";
  integration: boolean;
  scenarios: ScenarioId[];
  reportPath: string;
  cleanupTarget: { userId: string | null; subscriptionId: string | null; projectRef: string | null };
}

function usage(): string {
  return [
    "Usage:",
    "  paypath doctor",
    "  paypath test [--mode buggy|fixed] [--scenario <id>] [--report <path>]",
    "  paypath test --integration [--scenario <id>] [--report <path>]",
    "  paypath cleanup [--test-user <id>] [--subscription-id <id>] [--project-ref <ref>]",
    "",
    `Scenarios: ${SCENARIO_IDS.join(", ")}`,
  ].join("\n");
}

function parseArguments(args: string[]): CliOptions {
  const command = args[0];
  if (command !== "doctor" && command !== "test" && command !== "cleanup") throw new Error(usage());
  let mode: "buggy" | "fixed" = "fixed";
  let integration = false;
  let selectedScenario: ScenarioId | null = null;
  let reportPath = "paypath-report.json";
  const cleanupTarget: CliOptions["cleanupTarget"] = { userId: null, subscriptionId: null, projectRef: null };

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--mode") {
      const parsed = z.enum(["buggy", "fixed"]).safeParse(args[index + 1]);
      if (!parsed.success) throw new Error("--mode must be buggy or fixed.");
      mode = parsed.data;
      index += 1;
    } else if (argument === "--scenario") {
      const parsed = z.enum(SCENARIO_IDS).safeParse(args[index + 1]);
      if (!parsed.success) throw new Error(`Unknown scenario. ${usage()}`);
      selectedScenario = parsed.data;
      index += 1;
    } else if (argument === "--report") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("--report requires a file path.");
      reportPath = next;
      index += 1;
    } else if (argument === "--integration") {
      integration = true;
    } else if (argument === "--test-user") {
      cleanupTarget.userId = args[index + 1] ?? null;
      if (cleanupTarget.userId === null) throw new Error("--test-user requires an ID.");
      index += 1;
    } else if (argument === "--subscription-id") {
      cleanupTarget.subscriptionId = args[index + 1] ?? null;
      if (cleanupTarget.subscriptionId === null) throw new Error("--subscription-id requires an ID.");
      index += 1;
    } else if (argument === "--project-ref") {
      cleanupTarget.projectRef = args[index + 1] ?? null;
      if (cleanupTarget.projectRef === null) throw new Error("--project-ref requires a project ref.");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`Unknown argument.\n${usage()}`);
    }
  }

  if (integration && args.includes("--mode")) {
    throw new Error("--mode applies only to deterministic local testing; Integration reads the configured system state.");
  }
  const hasCleanupTarget = Object.values(cleanupTarget).some((value) => value !== null);
  if (command !== "cleanup" && hasCleanupTarget) throw new Error("Cleanup target flags are only valid with cleanup.");
  if (command === "cleanup" && (integration || selectedScenario !== null || args.includes("--mode") || args.includes("--report"))) {
    throw new Error("cleanup accepts only --test-user, --subscription-id, and --project-ref.");
  }
  if (command === "doctor" && (integration || selectedScenario !== null || args.includes("--mode"))) {
    throw new Error("doctor does not accept test execution options.");
  }
  return {
    command,
    mode,
    integration,
    scenarios: selectedScenario === null ? [...SCENARIO_IDS] : [selectedScenario],
    reportPath,
    cleanupTarget,
  };
}

async function runCleanup(target: CliOptions["cleanupTarget"]): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("Test database cleanup is disabled in production.");
  }
  const userId = target.userId ?? process.env["PAYPATH_TEST_USER_ID"] ?? "";
  const subscriptionId = target.subscriptionId ?? process.env["PAYPATH_STRIPE_SUBSCRIPTION_ID"] ?? "";
  const projectRef = target.projectRef ?? process.env["PAYPATH_TEST_SUPABASE_REF"] ?? "";
  validateDemoCleanupTarget(userId, subscriptionId);
  const cleanupEnvironment = {
    ...process.env,
    PAYPATH_TEST_USER_ID: userId,
    PAYPATH_STRIPE_SUBSCRIPTION_ID: subscriptionId,
    PAYPATH_TEST_SUPABASE_REF: projectRef,
  };
  parseStripeTestConfiguration(cleanupEnvironment);
  const configuration = parseSupabaseIntegrationConfiguration(cleanupEnvironment);
  const confirmation = `DELETE ${projectRef} ${userId} ${subscriptionId}`;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await prompt.question(
      `This deletes only PayPath Demo rows for this test user/subscription in Supabase project ${projectRef}. Stripe data is untouched.\nType exactly "${confirmation}" to continue: `,
    );
  } finally {
    prompt.close();
  }
  if (answer !== confirmation) {
    console.log("Cleanup cancelled; no Supabase request was made.");
    process.exitCode = 1;
    return;
  }
  const client = createSupabaseTestClient(configuration);
  const counts = await cleanupDemoTestData(client, userId, subscriptionId);
  console.log(`Deleted ${counts.effects_deleted} effects, ${counts.events_deleted} events, ${counts.subscriptions_deleted} subscriptions, and ${counts.entitlements_deleted} entitlements from the dedicated test database.`);
}

function printDoctor(): void {
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const supportedNode = nodeMajor >= 24;
  console.log(`Node.js: ${nodeVersion} ${supportedNode ? "OK" : "TOO OLD (need Node.js 24+)"}`);
  if (!supportedNode) process.exitCode = 1;
  console.log("Local deterministic engine: available (no external credentials required)");

  if (process.env["STRIPE_SECRET_KEY"] === undefined && process.env["SUPABASE_URL"] === undefined) {
    console.log("Stripe/Supabase integration: not configured (integration results will be INCONCLUSIVE)");
    return;
  }
  try {
    parseStripeTestConfiguration(process.env);
    parseSupabaseIntegrationConfiguration(process.env);
    console.log("Stripe/Supabase configuration: present and restricted to Stripe Test Mode plus the configured Supabase project ref");
  } catch (error) {
    console.log(`Stripe/Supabase configuration: incomplete or invalid (${error instanceof Error ? error.name : "invalid config"})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage());
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const metadata: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || typeof metadata.version !== "string") {
      throw new Error("CLI package version is unavailable.");
    }
    console.log(metadata.version);
    return;
  }
  const options = parseArguments(args);
  if (options.command === "doctor") {
    printDoctor();
    return;
  }
  if (options.command === "cleanup") {
    await runCleanup(options.cleanupTarget);
    return;
  }

  const executor = options.integration
    ? new IntegrationScenarioExecutor(process.env)
    : new LocalScenarioExecutor(options.mode);
  const report = await runScenarios(
    executor,
    options.scenarios,
    options.integration ? "stripe-supabase-integration" : "local-fixture",
  );
  const reportPath = path.resolve(process.cwd(), options.reportPath);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });

  for (const result of report.results) {
    const code = result.errorCode === null ? "" : ` (${result.errorCode})`;
    console.log(`${result.status.padEnd(12)} ${result.scenario}${code}`);
    for (const line of result.evidence) console.log(`  - ${line}`);
  }
  console.log(
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.errors} errors, ${report.summary.inconclusive} inconclusive.`,
  );
  console.log(`JSON report: ${reportPath}`);

  if (report.summary.failed > 0 || report.summary.errors > 0 || report.summary.inconclusive > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: command could not be completed.` : "PayPath command failed.");
  process.exitCode = 2;
});
