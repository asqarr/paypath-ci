import { z } from "zod";
import { getDemoServices } from "../../../../lib/services.ts";
import { logDemoAccessFailure, type DemoAccessFailureStage } from "../../../../lib/access-diagnostics.ts";

const UserIdSchema = z.string().startsWith("paypath-test-").max(255);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsedUserId = UserIdSchema.safeParse(url.searchParams.get("userId"));
  if (!parsedUserId.success) return Response.json({ error: "A valid userId is required." }, { status: 400 });
  const startedAt = performance.now();
  let stage: DemoAccessFailureStage = "service_initialization";
  try {
    const { application } = getDemoServices();
    stage = "authorization_read";
    const authorization = await application.authorize(parsedUserId.data);
    if (!authorization.proAccess) {
      return Response.json(
        { userId: authorization.userId, proAccess: false, checkedAt: authorization.checkedAt },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        userId: authorization.userId,
        proAccess: true,
        feature: "usage-analytics",
        checkedAt: authorization.checkedAt,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    logDemoAccessFailure("/api/pro/feature", stage, performance.now() - startedAt, error);
    return Response.json({ error: "Authorization could not be checked." }, { status: 503 });
  }
}
