import { z } from "zod";
import { getDemoServices } from "../../../lib/services.ts";

const UserIdSchema = z.string().startsWith("paypath-test-").max(255);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? process.env["PAYPATH_TEST_USER_ID"] ?? "paypath-test-demo-user";
  const parsedUserId = UserIdSchema.safeParse(userId);
  if (!parsedUserId.success) return Response.json({ error: "A valid userId is required." }, { status: 400 });
  try {
    const { application, repository } = getDemoServices();
    const [authorization, subscription] = await Promise.all([
      application.authorize(parsedUserId.data),
      repository.getSubscription(parsedUserId.data),
    ]);
    return Response.json(
      {
        userId: parsedUserId.data,
        proAccess: authorization.proAccess,
        stripeStatus: subscription?.status ?? null,
        source: subscription === null ? "demo store (no subscription linked)" : "demo store",
        checkedAt: authorization.checkedAt,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Entitlement data is unavailable; no access result was inferred." }, { status: 503 });
  }
}
