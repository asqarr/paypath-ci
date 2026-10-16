import { describe, expect, it, vi } from "vitest";
import { SupabaseDatabaseError } from "@paypath/supabase-adapter";
import { logDemoAccessFailure, type DemoAccessFailureRecord } from "./access-diagnostics.ts";

describe("Demo access failure diagnostics", () => {
  it("records safe Supabase details without logging remote messages", () => {
    const write = vi.fn<(record: Readonly<DemoAccessFailureRecord>) => void>();
    const error = new SupabaseDatabaseError({
      operation: "entitlement read",
      errorType: "PostgrestError",
      errorCode: "42501",
      httpStatus: 403,
      message: "sensitive remote response must not be logged",
    });

    logDemoAccessFailure("/api/pro/feature", "authorization_read", 12.6, error, write);

    expect(write).toHaveBeenCalledWith({
      endpoint: "/api/pro/feature",
      httpStatus: 503,
      durationMs: 13,
      stage: "authorization_read",
      category: "supabase",
      errorType: "PostgrestError",
      errorCode: "42501",
      backendHttpStatus: 403,
    });
    expect(JSON.stringify(write.mock.calls)).not.toContain("sensitive remote response");
  });

  it("classifies a timeout without exposing its message", () => {
    const write = vi.fn<(record: Readonly<DemoAccessFailureRecord>) => void>();
    const error = Object.assign(new Error("contains confidential request data"), { name: "TimeoutError" });

    logDemoAccessFailure("/api/entitlement", "subscription_read", 8_000, error, write);

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "/api/entitlement",
      category: "timeout",
      errorType: "TimeoutError",
      durationMs: 8_000,
    }));
    expect(JSON.stringify(write.mock.calls)).not.toContain("confidential request data");
  });

  it("classifies a sanitized adapter transport error as network", () => {
    const write = vi.fn<(record: Readonly<DemoAccessFailureRecord>) => void>();
    const error = new SupabaseDatabaseError({
      operation: "entitlement read",
      errorType: "TypeError",
      message: "Node.js could not establish the Supabase HTTP request; no HTTP response was received and raw transport details were omitted.",
    });

    logDemoAccessFailure("/api/entitlement", "authorization_read", 21, error, write);

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ category: "network", errorType: "TypeError" }));
  });

  it("keeps generic failures fail-closed and logs no raw error content", () => {
    const write = vi.fn<(record: Readonly<DemoAccessFailureRecord>) => void>();
    const error = new Error("private payload or credential");

    logDemoAccessFailure("/api/pro/feature", "service_initialization", 2, error, write);

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      category: "internal",
      errorType: "Error",
    }));
    expect(JSON.stringify(write.mock.calls)).not.toContain("private payload or credential");
  });
});
