import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SupabaseDatabaseError,
  SupabaseDemoRepository,
  parseSupabaseIntegrationConfiguration,
  parseSupabaseTestConfiguration,
  validateDemoCleanupTarget,
} from "./index.ts";

describe("Supabase test project guardrails", () => {
  const complete = {
    SUPABASE_URL: "https://paypath-demo-ref.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
    PAYPATH_TEST_USER_ID: "paypath-test-demo",
    PAYPATH_STRIPE_SUBSCRIPTION_ID: "sub_demo",
    PAYPATH_TEST_SUPABASE_REF: "paypath-demo-ref",
    PAYPATH_SUPABASE_TEST_PROJECT_ACK: "disposable-test-project",
  };

  it("accepts a URL only when its project ref matches the explicit test ref", () => {
    const connection = {
      SUPABASE_URL: complete.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: complete.SUPABASE_SERVICE_ROLE_KEY,
      PAYPATH_TEST_SUPABASE_REF: complete.PAYPATH_TEST_SUPABASE_REF,
      PAYPATH_SUPABASE_TEST_PROJECT_ACK: complete.PAYPATH_SUPABASE_TEST_PROJECT_ACK,
    };
    expect(parseSupabaseTestConfiguration(connection).projectRef).toBe("paypath-demo-ref");
    expect(() => parseSupabaseTestConfiguration({
      ...connection,
      PAYPATH_SUPABASE_TEST_PROJECT_ACK: undefined,
    })).toThrow();
    expect(parseSupabaseIntegrationConfiguration(complete).subscriptionId).toBe("sub_demo");
    expect(() => parseSupabaseIntegrationConfiguration({
      ...complete,
      PAYPATH_SUPABASE_TEST_PROJECT_ACK: undefined,
    })).toThrow();
    expect(() => parseSupabaseTestConfiguration({
      ...connection,
      SUPABASE_URL: "https://some-production-project.supabase.co",
    })).toThrow(/does not match/);
    expect(() => parseSupabaseIntegrationConfiguration({
      ...complete,
      PAYPATH_TEST_USER_ID: "customer-real-user",
    })).toThrow();
    expect(() => parseSupabaseIntegrationConfiguration({
      ...complete,
      PAYPATH_STRIPE_SUBSCRIPTION_ID: "cus_demo",
    })).toThrow();
  });

  it("allows local Supabase only with the explicit local ref", () => {
    expect(parseSupabaseTestConfiguration({
      ...complete,
      SUPABASE_URL: "http://127.0.0.1:54321",
      PAYPATH_TEST_SUPABASE_REF: "local",
    }).projectRef).toBe("local");
    expect(() => parseSupabaseTestConfiguration({
      ...complete,
      SUPABASE_URL: "http://127.0.0.1:54321",
    })).toThrow(/=local/);
  });

  it("restricts cleanup targets to test-prefixed users and Stripe subscription IDs", () => {
    expect(() => validateDemoCleanupTarget("paypath-test-run-42", "sub_abc123")).not.toThrow();
    expect(() => validateDemoCleanupTarget("paypath-demo-user", "sub_abc123")).toThrow(/paypath-test/);
    expect(() => validateDemoCleanupTarget("paypath-test-run-42", "cus_not_a_subscription")).toThrow(/sub_\*/);
  });

  it("preserves safe PostgREST diagnostics without exposing remote error text", async () => {
    const sensitiveRemoteMessage = "RPC failed; token=should-never-be-logged";
    const remoteError = Object.assign(new Error(sensitiveRemoteMessage), { code: "PGRST202" });
    const client = {
      rpc: async () => ({ data: null, error: remoteError, status: 404 }),
    } as unknown as SupabaseClient;
    const repository = new SupabaseDemoRepository(client);
    const event = {
      eventId: "evt_diagnostic1",
      eventType: "customer.subscription.created",
      eventCreatedAt: 1_700_000_000,
      userId: "paypath-test-diagnostic",
      subscriptionId: "sub_diagnostic1",
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    } as const;

    const result = await repository.applyEvent(event, false, false).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(SupabaseDatabaseError);
    const diagnosticError = result as SupabaseDatabaseError;
    expect(diagnosticError.diagnostic).toEqual({
      operation: "webhook transaction",
      rpcName: "process_demo_stripe_event",
      errorType: "Error",
      errorCode: "PGRST202",
      httpStatus: 404,
      message: "PostgREST could not resolve the RPC using the exposed schema cache and supplied argument names.",
    });
    expect(diagnosticError.message).not.toContain("token");
    expect(diagnosticError.message).not.toContain(sensitiveRemoteMessage);
  });

  it("classifies a missing HTTP response as a transport error without exposing its message", async () => {
    const remoteError = { message: "TypeError: fetch failed; host=private-host.invalid", code: "" };
    const client = {
      rpc: async () => ({ data: null, error: remoteError, status: 0 }),
    } as unknown as SupabaseClient;
    const repository = new SupabaseDemoRepository(client);
    const event = {
      eventId: "evt_transport1",
      eventType: "customer.subscription.created",
      eventCreatedAt: 1_700_000_000,
      userId: "paypath-test-transport",
      subscriptionId: "sub_transport1",
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    } as const;

    const result = await repository.applyEvent(event, false, false).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(SupabaseDatabaseError);
    const diagnosticError = result as SupabaseDatabaseError;
    expect(diagnosticError.diagnostic.errorType).toBe("FetchError");
    expect(diagnosticError.diagnostic.httpStatus).toBeUndefined();
    expect(diagnosticError.diagnostic.message).toContain("no HTTP response was received");
    expect(diagnosticError.message).not.toContain("private-host.invalid");
  });
});
