import { describe, expect, it } from "vitest";
import {
  assertStripeTestSubscriptionContext,
  createStripeTestClient,
  parseStripeTestConfiguration,
  verifyStripeWebhook,
} from "./index.ts";

describe("Stripe Test Mode adapter guardrails", () => {
  it("rejects a live-mode key before making any request", () => {
    expect(() => createStripeTestClient("sk_live_do_not_use")).toThrow(/Test Mode/);
    expect(() => parseStripeTestConfiguration({
      STRIPE_SECRET_KEY: "sk_live_do_not_use",
      PAYPATH_STRIPE_SUBSCRIPTION_ID: "sub_example",
    })).toThrow();
  });

  it("requires Stripe subscription metadata to bind the billing record to the test user", () => {
    expect(() => assertStripeTestSubscriptionContext({
      id: "sub_test",
      livemode: false,
      metadata: { paypath_user_id: "paypath-test-user" },
    }, "paypath-test-user")).not.toThrow();
    expect(() => assertStripeTestSubscriptionContext({
      id: "sub_test",
      livemode: false,
      metadata: { paypath_user_id: "paypath-test-other" },
    }, "paypath-test-user")).toThrow(/does not match/);
    expect(() => assertStripeTestSubscriptionContext({
      id: "sub_test",
      livemode: true,
      metadata: { paypath_user_id: "paypath-test-user" },
    }, "paypath-test-user")).toThrow(/live-mode/);
  });

  it("verifies Webhook signatures against the unmodified payload", () => {
    const stripe = createStripeTestClient("sk_test_unit_only");
    const webhookSecret = "whsec_unit_test_secret";
    const payload = JSON.stringify({
      id: "evt_paypath_signature_test",
      object: "event",
      api_version: "2025-03-31.basil",
      created: 1_740_000_000,
      data: { object: { id: "sub_test", object: "subscription" } },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "customer.subscription.updated",
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });

    expect(verifyStripeWebhook(stripe, payload, signature, webhookSecret).livemode).toBe(false);
    expect(() => verifyStripeWebhook(stripe, `${payload} `, signature, webhookSecret)).toThrow();
  });
});
