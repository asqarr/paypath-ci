import { z } from "zod";
import type { AuthorizationSnapshot, ScenarioId } from "@paypath/core";
import type { DemoFaults, DemoRepository, DemoWebhookEvent } from "./types.ts";

export const DemoWebhookEventSchema = z.object({
  eventId: z.string().max(255).regex(/^evt_[A-Za-z0-9]+$/),
  eventType: z.enum([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ]),
  eventCreatedAt: z.number().int().positive().refine(Number.isSafeInteger),
  userId: z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/),
  subscriptionId: z.string().max(255).regex(/^sub_[A-Za-z0-9]+$/),
  status: z.enum([
    "active",
    "trialing",
    "past_due",
    "canceled",
    "unpaid",
    "incomplete",
    "incomplete_expired",
    "paused",
  ]),
  currentPeriodEnd: z.string().datetime({ offset: true }).nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export class DemoApplication {
  constructor(
    private readonly repository: DemoRepository,
    private readonly faults: DemoFaults,
  ) {
    if (faults.mode === "buggy" && process.env["NODE_ENV"] === "production") {
      throw new Error("Bug injection is forbidden when NODE_ENV=production.");
    }
  }

  async processWebhook(input: unknown) {
    const event = DemoWebhookEventSchema.parse(input);
    const suppressEntitlementEffect =
      this.faults.mode === "buggy" &&
      (this.faults.scenario === "successful-payment" || this.faults.scenario === "cancellation");
    const allowRepeatedEffects =
      this.faults.mode === "buggy" && this.faults.scenario === "duplicate-webhook";
    return this.repository.applyEvent(event as DemoWebhookEvent, allowRepeatedEffects, suppressEntitlementEffect);
  }

  async authorize(userId: string): Promise<AuthorizationSnapshot> {
    const entitlement = await this.repository.getEntitlement(userId);
    if (entitlement === null) throw new Error("Entitlement lookup returned no result.");
    return {
      source: "local-api",
      userId,
      httpStatus: entitlement.proAccess ? 200 : 403,
      proAccess: entitlement.proAccess,
      checkedAt: new Date().toISOString(),
    };
  }
}

export function parseDemoFaults(environment: Record<string, string | undefined>): DemoFaults {
  const mode = z.enum(["buggy", "fixed"]).default("fixed").parse(environment["PAYPATH_DEMO_MODE"]);
  const scenario = z
    .enum(["successful-payment", "cancellation", "duplicate-webhook"])
    .nullable()
    .default(null)
    .parse(environment["PAYPATH_DEMO_SCENARIO"] ?? null) as ScenarioId | null;
  if (mode === "buggy" && process.env["NODE_ENV"] === "production") {
    throw new Error("PAYPATH_DEMO_MODE=buggy is disabled in production.");
  }
  return { mode, scenario };
}
