import type {
  BillingSnapshot,
  ScenarioExecutor,
  ScenarioId,
  ScenarioObservations,
} from "@paypath/core";
import { DemoApplication } from "./application.ts";
import { InMemoryDemoRepository } from "./in-memory-repository.ts";
import type { DemoMode, DemoWebhookEvent } from "./types.ts";

function fixtureFor(scenario: ScenarioId): { event: DemoWebhookEvent; billing: BillingSnapshot; deliveries: number } {
  const now = Date.now();
  const activeEnd = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ended = new Date(now - 60 * 1000).toISOString();
  const userId = `paypath-test-${scenario}`;
  const fixtureId = scenario.replaceAll("-", "");
  const subscriptionId = `sub_fixture${fixtureId}`;
  const cancellation = scenario === "cancellation";
  const event: DemoWebhookEvent = {
    eventId: `evt_fixture${fixtureId}`,
    eventType: cancellation ? "customer.subscription.deleted" : "customer.subscription.updated",
    eventCreatedAt: Math.floor(now / 1000),
    userId,
    subscriptionId,
    status: cancellation ? "canceled" : "active",
    currentPeriodEnd: cancellation ? ended : activeEnd,
    cancelAtPeriodEnd: false,
  };
  return {
    event,
    deliveries: scenario === "duplicate-webhook" ? 2 : 1,
    billing: {
      source: "fixture",
      subscriptionId,
      status: event.status,
      paymentStatus: "paid",
      currentPeriodEnd: event.currentPeriodEnd,
      evaluationTime: new Date(now).toISOString(),
      evaluationTimeSource: "fixture",
      cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      checkedAt: new Date(now).toISOString(),
    },
  };
}

export class LocalScenarioExecutor implements ScenarioExecutor {
  constructor(private readonly mode: DemoMode) {}

  async execute(scenario: ScenarioId): Promise<ScenarioObservations> {
    const { event, billing, deliveries } = fixtureFor(scenario);
    const repository = new InMemoryDemoRepository();
    if (scenario === "cancellation") {
      await repository.seedEntitlement(event.userId, true);
    }
    const application = new DemoApplication(repository, {
      mode: this.mode,
      scenario: this.mode === "buggy" ? scenario : null,
    });

    for (let attempt = 0; attempt < deliveries; attempt += 1) {
      await application.processWebhook(event);
    }

    const [subscription, entitlement, authorization, delivery, effects] = await Promise.all([
      repository.getSubscription(event.userId),
      repository.getEntitlement(event.userId),
      application.authorize(event.userId),
      repository.getDelivery(event.eventId),
      repository.getEffects(event.eventId),
    ]);

    return {
      billing,
      applicationSubscriptionId: subscription?.subscriptionId ?? null,
      entitlement:
        entitlement === null
          ? { status: "absent", source: "demo-store", userId: event.userId }
          : { status: "present", snapshot: entitlement },
      authorization,
      webhookDeliveries:
        delivery === null
          ? []
          : [
              {
                eventId: delivery.eventId,
                deliveryCount: delivery.deliveryCount,
                processedCount: delivery.processedCount,
              },
            ],
      businessEffects: effects.map(({ eventId, effectType, count }) => ({ eventId, effectType, count })),
      notes: [
        "Local deterministic fixture; no Stripe or Supabase request was made.",
        `Demo application processed ${delivery?.deliveryCount ?? 0} webhook delivery/deliveries.`,
      ],
    };
  }
}
