import { z } from "zod";
import { getDemoServices } from "../../../lib/services.ts";
import { logDemoAccessFailure, type DemoAccessFailureStage } from "../../../lib/access-diagnostics.ts";

const UserIdSchema = z.string().startsWith("paypath-test-").max(255);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId") ?? process.env["PAYPATH_TEST_USER_ID"] ?? "paypath-test-demo-user";
  const parsedUserId = UserIdSchema.safeParse(userId);
  if (!parsedUserId.success) return Response.json({ error: "A valid userId is required." }, { status: 400 });
  const startedAt = performance.now();
  let stage: DemoAccessFailureStage = "service_initialization";
  let failedReadStage: DemoAccessFailureStage | undefined;
  try {
    const { application, repository } = getDemoServices();
    stage = "evidence_read";
    const trackRead = <T>(readStage: "authorization_read" | "subscription_read", read: () => Promise<T>): Promise<T> =>
      Promise.resolve().then(read).catch((error: unknown) => {
        failedReadStage ??= readStage;
        throw error;
      });
    const [authorization, subscription] = await Promise.all([
      trackRead("authorization_read", () => application.authorize(parsedUserId.data)),
      trackRead("subscription_read", () => repository.getSubscription(parsedUserId.data)),
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
  } catch (error) {
    logDemoAccessFailure("/api/entitlement", failedReadStage ?? stage, performance.now() - startedAt, error);
    return Response.json({ error: "Entitlement data is unavailable; no access result was inferred." }, { status: 503 });
  }
}
