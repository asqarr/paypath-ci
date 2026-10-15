import type { ScenarioExecutor, ScenarioId, TestReport, TestResult } from "./types.ts";
import { runScenario } from "./engine.ts";

export async function runScenarios(
  executor: ScenarioExecutor,
  scenarios: ScenarioId[],
  source: TestResult["source"] = "local-fixture",
): Promise<TestReport> {
  const results: TestResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(executor, scenario, source));
  }
  return {
    schemaVersion: 1,
    runId: `paypath-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    generatedAt: new Date().toISOString(),
    source,
    results,
    summary: {
      passed: results.filter((result) => result.status === "PASS").length,
      failed: results.filter((result) => result.status === "FAIL").length,
      errors: results.filter((result) => result.status === "ERROR").length,
      inconclusive: results.filter((result) => result.status === "INCONCLUSIVE").length,
    },
  };
}
