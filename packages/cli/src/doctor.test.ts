import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import { createDoctorReport } from "./doctor.ts";

const templateEnvironment: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_REPLACE_WITH_TEST_MODE_KEY",
  PAYPATH_STRIPE_SUBSCRIPTION_ID: "sub_REPLACEWITHTESTSUBSCRIPTION",
  SUPABASE_URL: "https://replace-with-project-ref.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "REPLACE_WITH_TEST_PROJECT_SERVICE_ROLE_KEY",
  PAYPATH_TEST_SUPABASE_REF: "replace-with-project-ref",
  PAYPATH_SUPABASE_TEST_PROJECT_ACK: "disposable-test-project",
  PAYPATH_TEST_USER_ID: "paypath-test-pilot-001",
};

const completeSyntheticEnvironment: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_synthetic_key_for_unit_tests_only",
  PAYPATH_STRIPE_SUBSCRIPTION_ID: "sub_synthetic123",
  SUPABASE_URL: "https://pilot-synthetic.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic_service_role_value_for_unit_tests_only",
  PAYPATH_TEST_SUPABASE_REF: "pilot-synthetic",
  PAYPATH_SUPABASE_TEST_PROJECT_ACK: "disposable-test-project",
  PAYPATH_TEST_USER_ID: "paypath-test-synthetic-user",
};

describe("paypath doctor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports template placeholders as incomplete without printing their values", () => {
    const report = createDoctorReport(templateEnvironment, "24.22.0");
    const output = report.lines.join("\n");

    expect(output).toContain("INCOMPLETE");
    expect(output).toContain("STRIPE_SECRET_KEY");
    expect(output).toContain("PAYPATH_TEST_USER_ID");
    expect(output).toContain("Connection: NOT TESTED");
    expect(output).not.toContain(templateEnvironment["STRIPE_SECRET_KEY"]);
    expect(output).not.toContain(templateEnvironment["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(report.exitCode).toBe(0);
  });

  it("reports complete synthetic values as locally format-valid, never as connected", () => {
    const report = createDoctorReport(completeSyntheticEnvironment, "24.22.0");
    const output = report.lines.join("\n");

    expect(output).toContain("FORMAT VALID (local validation only");
    expect(output).toContain("credentials have not been authenticated");
    expect(output).toContain("Connection: NOT TESTED");
    expect(output).not.toMatch(/connected|verified|authenticated successfully/i);
    expect(output).not.toContain(completeSyntheticEnvironment["STRIPE_SECRET_KEY"]);
    expect(output).not.toContain(completeSyntheticEnvironment["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(report.exitCode).toBe(0);
  });

  it("ignores placeholder-looking values in unrelated environment variables", () => {
    const report = createDoctorReport({
      ...completeSyntheticEnvironment,
      UNRELATED_NOTE: "replace this local note",
    }, "24.22.0");

    expect(report.lines.join("\n")).toContain("FORMAT VALID");
  });

  it("does not make HTTP requests while checking configuration", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const httpSpy = vi.spyOn(http, "request");
    const httpsSpy = vi.spyOn(https, "request");

    createDoctorReport(completeSyntheticEnvironment, "24.22.0");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  it("keeps the existing informational exit-code contract for incomplete config and fails only for unsupported Node", () => {
    expect(createDoctorReport({}, "24.22.0").exitCode).toBe(0);
    expect(createDoctorReport(templateEnvironment, "24.22.0").exitCode).toBe(0);
    expect(createDoctorReport(completeSyntheticEnvironment, "24.22.0").exitCode).toBe(0);
    expect(createDoctorReport({}, "20.20.2").exitCode).toBe(1);
  });
});
