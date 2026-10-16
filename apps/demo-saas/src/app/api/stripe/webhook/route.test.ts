import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseDatabaseError } from "@paypath/supabase-adapter";

const webhookMocks = vi.hoisted(() => ({
  createStripeTestClient: vi.fn(),
  verifyStripeWebhook: vi.fn(),
  getDemoServices: vi.fn(),
}));

vi.mock("@paypath/stripe-adapter", () => ({
  createStripeTestClient: webhookMocks.createStripeTestClient,
  verifyStripeWebhook: webhookMocks.verifyStripeWebhook,
}));

vi.mock("../../../../lib/services.ts", () => ({
  getDemoServices: webhookMocks.getDemoServices,
}));

import { POST } from "./route.ts";

const verifiedEvent = {
  id: "evt_webhookdiagnostic",
  type: "customer.subscription.created",
  created: 1_900_000_000,
  livemode: false,
  data: {
    object: {
      id: "sub_webhookdiagnostic",
      metadata: { paypath_user_id: "paypath-test-webhook-diagnostic" },
      status: "active",
      items: { data: [{ current_period_end: 1_900_000_000 }] },
      cancel_at_period_end: false,
    },
  },
};

describe("Stripe webhook processing failures", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function postWebhookThatFails(error: unknown): Promise<Response> {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit_only");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_unit_only");
    webhookMocks.createStripeTestClient.mockReturnValue({});
    webhookMocks.verifyStripeWebhook.mockReturnValue(verifiedEvent);
    webhookMocks.getDemoServices.mockReturnValue({
      application: { processWebhook: vi.fn().mockRejectedValue(error) },
    });

    return POST(new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "unit-test-signature" },
      body: "{}",
    }));
  }

  it("logs safe RPC diagnostics and returns only the generic HTTP 500 response", async () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => {});
    const remoteDetail = "token=must-not-appear user=private-user";
    const error = new SupabaseDatabaseError({
      operation: "webhook transaction",
      rpcName: "process_demo_stripe_event",
      errorType: "PostgrestError",
      errorCode: "23503",
      httpStatus: 500,
      message: remoteDetail,
    });

    const response = await postWebhookThatFails(error);
    const responseBody = await response.text();

    expect(response.status).toBe(500);
    expect(responseBody).toBe(JSON.stringify({ error: "Verified webhook could not be processed." }));
    expect(write).toHaveBeenCalledOnce();
    const logged = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      operation: "process_demo_stripe_event",
      errorType: "PostgrestError",
      errorCode: "23503",
      httpStatus: 500,
    });
    expect(logged).not.toContain(remoteDetail);
    expect(logged).not.toContain("private-user");
  });

  it("logs a generic error category without exposing its message to logs or Stripe", async () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateDetail = "secret=must-not-appear; customer=private-customer";

    const response = await postWebhookThatFails(new Error(privateDetail));
    const responseBody = await response.text();

    expect(response.status).toBe(500);
    expect(responseBody).toBe(JSON.stringify({ error: "Verified webhook could not be processed." }));
    expect(write).toHaveBeenCalledOnce();
    const logged = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      operation: "stripe_webhook.process",
      errorType: "UnhandledError",
    });
    expect(logged).not.toContain(privateDetail);
    expect(logged).not.toContain("private-customer");
  });
});
