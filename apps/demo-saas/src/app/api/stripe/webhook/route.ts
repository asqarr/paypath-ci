import { createStripeTestClient, verifyStripeWebhook } from "@paypath/stripe-adapter";
import { z } from "zod";
import { getDemoServices } from "../../../../lib/services.ts";

export const runtime = "nodejs";

const SubscriptionObjectSchema = z.object({
  id: z.string().min(1),
  metadata: z.record(z.string(), z.string()),
  status: z.enum([
    "active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused",
  ]),
  items: z.object({ data: z.array(z.object({ current_period_end: z.number().int() })) }),
  cancel_at_period_end: z.boolean(),
});

export async function POST(request: Request): Promise<Response> {
  const key = process.env["STRIPE_SECRET_KEY"];
  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
  const signature = request.headers.get("stripe-signature");
  if (key === undefined || !key.startsWith("sk_test_") || webhookSecret === undefined || signature === null) {
    return Response.json({ error: "Stripe Test Mode webhook is not configured." }, { status: 503 });
  }

  let event: ReturnType<typeof verifyStripeWebhook>;
  try {
    const stripe = createStripeTestClient(key);
    event = verifyStripeWebhook(stripe, await request.text(), signature, webhookSecret);
  } catch {
    return Response.json({ error: "Webhook signature verification failed." }, { status: 400 });
  }

  if (event.livemode) {
    return Response.json({ error: "Live Mode events are not accepted by the PayPath Demo." }, { status: 400 });
  }

  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated" &&
    event.type !== "customer.subscription.deleted"
  ) {
    return Response.json({ received: true, ignored: true });
  }

  try {
    const parsedSubscription = SubscriptionObjectSchema.safeParse(event.data.object);
    if (!parsedSubscription.success) {
      return Response.json({ error: "Stripe subscription payload is invalid for this Demo." }, { status: 422 });
    }
    const subscription = parsedSubscription.data;
    const userId = subscription.metadata["paypath_user_id"];
    const parsedUserId = z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/).safeParse(userId);
    if (!parsedUserId.success) return Response.json({ error: "Subscription has invalid PayPath test user metadata." }, { status: 422 });
    const { application } = getDemoServices();
    const processing = await application.processWebhook({
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: event.created,
      userId: parsedUserId.data,
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd:
        subscription.items.data.length === 1 && subscription.items.data[0] !== undefined
          ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
          : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
    if (processing.conflict) {
      return Response.json({ received: true, conflict: true });
    }
    return Response.json({
      received: true,
      duplicate: processing.duplicate,
      stale: processing.stale,
      orderingAmbiguous: processing.orderingAmbiguous,
    });
  } catch {
    return Response.json({ error: "Verified webhook could not be processed." }, { status: 500 });
  }
}
