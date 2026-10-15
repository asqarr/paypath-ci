import { createStripeTestClient } from "@paypath/stripe-adapter";
import { z } from "zod";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const key = process.env["STRIPE_SECRET_KEY"];
  const priceId = process.env["STRIPE_PRICE_ID"];
  const testUserId = process.env["PAYPATH_TEST_USER_ID"] ?? "paypath-test-demo-user";
  const parsedPrice = z.string().startsWith("price_").safeParse(priceId);
  if (key === undefined || !key.startsWith("sk_test_") || !parsedPrice.success) {
    return Response.json({ error: "Configure a Stripe Test Mode key and test Price ID first." }, { status: 503 });
  }
  const userId = z.string().startsWith("paypath-test-").max(255).safeParse(testUserId);
  if (!userId.success) return Response.json({ error: "Demo test user configuration is invalid." }, { status: 503 });

  try {
    const stripe = createStripeTestClient(key);
    const origin = new URL(request.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: parsedPrice.data, quantity: 1 }],
      client_reference_id: userId.data,
      metadata: { paypath_user_id: userId.data },
      subscription_data: { metadata: { paypath_user_id: userId.data } },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`,
    });
    if (session.url === null) return Response.json({ error: "Stripe did not return a Checkout URL." }, { status: 502 });
    const checkoutUrl = new URL(session.url);
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
      return Response.json({ error: "Stripe returned an unexpected Checkout host." }, { status: 502 });
    }
    return Response.json({ url: checkoutUrl.toString() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Stripe Test Mode checkout could not be created." }, { status: 502 });
  }
}
