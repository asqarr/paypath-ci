import Stripe from "stripe";
import { z } from "zod";
import type { BillingSnapshot } from "@paypath/core";

export const StripeTestConfigurationSchema = z.object({
  STRIPE_SECRET_KEY: z.string().regex(/^sk_test_\S+$/),
  PAYPATH_STRIPE_SUBSCRIPTION_ID: z.string().regex(/^sub_[A-Za-z0-9]+$/),
});

const StripeInvoiceEvidenceSchema = z.object({ status: z.string().nullable() }).passthrough();
const StripeTestClockEvidenceSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  frozen_time: z.number().int().nonnegative(),
}).passthrough();
const StripeSubscriptionEvidenceSchema = z.object({
  id: z.string().startsWith("sub_"),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()),
  status: z.string().min(1),
  cancel_at_period_end: z.boolean(),
  latest_invoice: z.union([z.string().startsWith("in_"), StripeInvoiceEvidenceSchema, z.null()]),
  test_clock: z.union([z.string().startsWith("clock_"), StripeTestClockEvidenceSchema, z.null()]),
  items: z.object({
    data: z.array(z.object({ current_period_end: z.number().int().nonnegative() }).passthrough()),
  }).passthrough(),
}).passthrough();

export interface StripeTestConfiguration {
  secretKey: string;
  subscriptionId: string;
}

export function parseStripeTestConfiguration(environment: Record<string, string | undefined>): StripeTestConfiguration {
  const parsed = StripeTestConfigurationSchema.parse(environment);
  return {
    secretKey: parsed.STRIPE_SECRET_KEY,
    subscriptionId: parsed.PAYPATH_STRIPE_SUBSCRIPTION_ID,
  };
}

export function createStripeTestClient(secretKey: string): Stripe {
  if (!/^sk_test_\S+$/.test(secretKey)) {
    throw new Error("Stripe integration is read-only and accepts Test Mode secret keys (sk_test_) only.");
  }
  return new Stripe(secretKey);
}

export function assertStripeTestSubscriptionContext(
  subscription: Pick<Stripe.Subscription, "id" | "livemode" | "metadata">,
  expectedUserId?: string,
): void {
  if (subscription.livemode) {
    throw new Error("Stripe returned a live-mode subscription for a Test Mode integration request.");
  }
  if (
    expectedUserId !== undefined &&
    subscription.metadata["paypath_user_id"] !== expectedUserId
  ) {
    throw new Error("Stripe subscription metadata does not match the configured test user.");
  }
}

export async function readStripeSubscription(
  client: Stripe,
  subscriptionId: string,
  expectedUserId?: string,
): Promise<BillingSnapshot> {
  const subscription = await client.subscriptions.retrieve(subscriptionId, {
    expand: ["latest_invoice", "test_clock"],
  });
  const parsedSubscription = StripeSubscriptionEvidenceSchema.safeParse(subscription);
  if (!parsedSubscription.success) throw new Error("Stripe returned malformed subscription evidence.");
  const evidence = parsedSubscription.data;
  if (evidence.id !== subscriptionId) throw new Error("Stripe returned a different subscription than requested.");
  assertStripeTestSubscriptionContext(evidence, expectedUserId);
  const latestInvoice = evidence.latest_invoice;
  const invoice =
    typeof latestInvoice === "string"
      ? await client.invoices.retrieve(latestInvoice)
      : latestInvoice;
  const parsedInvoice = invoice === null ? null : StripeInvoiceEvidenceSchema.safeParse(invoice);
  if (parsedInvoice !== null && !parsedInvoice.success) {
    throw new Error("Stripe returned malformed invoice evidence.");
  }
  const paymentStatus = parsedInvoice === null
    ? "unknown"
    : parsedInvoice.data.status === "paid"
      ? "paid"
      : "not_paid";
  const testClockReference = evidence.test_clock;
  let evaluationTime: string | null;
  let evaluationTimeSource: BillingSnapshot["evaluationTimeSource"];
  if (testClockReference === null) {
    evaluationTime = new Date().toISOString();
    evaluationTimeSource = "system_clock";
  } else {
    evaluationTimeSource = "stripe_test_clock";
    const testClock =
      typeof testClockReference === "string"
        ? await client.testHelpers.testClocks.retrieve(testClockReference)
        : testClockReference;
    evaluationTime = testClock.status === "ready"
      ? new Date(testClock.frozen_time * 1000).toISOString()
      : null;
  }
  return {
    source: "stripe",
    subscriptionId: subscription.id,
    status: evidence.status,
    paymentStatus,
    currentPeriodEnd:
      evidence.items.data.length === 1 && evidence.items.data[0] !== undefined
        ? new Date(evidence.items.data[0].current_period_end * 1000).toISOString()
        : null,
    evaluationTime,
    evaluationTimeSource,
    cancelAtPeriodEnd: evidence.cancel_at_period_end,
    checkedAt: new Date().toISOString(),
  };
}

export function verifyStripeWebhook(
  client: Stripe,
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
): Stripe.Event {
  if (!webhookSecret.startsWith("whsec_")) {
    throw new Error("A Stripe webhook signing secret is required.");
  }
  return client.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
