import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "@paypath/core";
import { IntegrationScenarioExecutor } from "./integration-executor.ts";

const mocks = vi.hoisted(() => ({
  readStripeSubscription: vi.fn(),
  getSubscription: vi.fn(),
  getEntitlement: vi.fn(),
}));

vi.mock("@paypath/stripe-adapter", () => ({
  createStripeTestClient: vi.fn(() => ({})),
  parseStripeTestConfiguration: vi.fn(() => ({ secretKey: "sk_test_fixture", subscriptionId: "sub_fixture" })),
  readStripeSubscription: mocks.readStripeSubscription,
}));

vi.mock("@paypath/supabase-adapter", () => ({
  createSupabaseTestClient: vi.fn(() => ({})),
  parseSupabaseIntegrationConfiguration: vi.fn(() => ({ projectRef: "test-project", userId: "user_red" })),
  SupabaseDemoRepository: class {
    getSubscription(...args: unknown[]) {
      return mocks.getSubscription(...args);
    }

    getEntitlement(...args: unknown[]) {
      return mocks.getEntitlement(...args);
    }
  },
}));

const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_fixture",
  PAYPATH_STRIPE_SUBSCRIPTION_ID: "sub_fixture",
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service_role_fixture",
  PAYPATH_TEST_SUPABASE_REF: "test-project",
  PAYPATH_SUPABASE_TEST_PROJECT_ACK: "disposable-test-project",
  PAYPATH_TEST_USER_ID: "user_red",
  PAYPATH_DEMO_BASE_URL: "http://127.0.0.1:3000",
};

describe("IntegrationScenarioExecutor entitlement evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const now = new Date();
    mocks.readStripeSubscription.mockResolvedValue({
      source: "stripe",
      subscriptionId: "sub_fixture",
      status: "active",
      paymentStatus: "paid",
      currentPeriodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
      evaluationTime: now.toISOString(),
      evaluationTimeSource: "system_clock",
      cancelAtPeriodEnd: false,
      checkedAt: now.toISOString(),
    });
    mocks.getSubscription.mockResolvedValue({ subscriptionId: "sub_fixture", status: "active" });
    mocks.getEntitlement.mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      userId: "user_red",
      proAccess: false,
      checkedAt: new Date().toISOString(),
    }), { status: 403, headers: { "content-type": "application/json" } })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scores a successful absent-row lookup as no persisted access", async () => {
    const executor = new IntegrationScenarioExecutor(environment);
    const observations = await executor.execute("successful-payment");
    const result = await runScenario({ execute: async () => observations }, "successful-payment", "stripe-supabase-integration");

    expect(observations.entitlement).toEqual({ status: "absent", source: "supabase", userId: "user_red" });
    expect(result.status).toBe("FAIL");
    expect(result.errorCode).toBe("ENTITLEMENT_NOT_GRANTED");
    expect(result.actual.persistedProAccess).toBe(false);
  });

  it("keeps a Supabase entitlement query error unavailable and inconclusive", async () => {
    mocks.getEntitlement.mockRejectedValue(new Error("database error details must not be surfaced"));
    const executor = new IntegrationScenarioExecutor(environment);
    const observations = await executor.execute("successful-payment");
    const result = await runScenario({ execute: async () => observations }, "successful-payment", "stripe-supabase-integration");

    expect(observations.entitlement).toEqual({ status: "unavailable" });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.errorCode).toBe("EVIDENCE_INCOMPLETE");
    expect(result.errorCode).not.toBe("ENTITLEMENT_NOT_GRANTED");
  });
});
