import type { EntitlementSnapshot } from "@paypath/core";
import type {
  DemoDelivery,
  DemoEffect,
  DemoEventProcessingResult,
  DemoRepository,
  DemoSubscription,
  DemoWebhookEvent,
} from "./types.ts";

export class InMemoryDemoRepository implements DemoRepository {
  private readonly entitlements = new Map<string, EntitlementSnapshot>();
  private readonly subscriptions = new Map<string, DemoSubscription>();
  private readonly deliveries = new Map<string, DemoDelivery>();
  private readonly eventPayloads = new Map<string, string>();
  private readonly effects: DemoEffect[] = [];

  async seedEntitlement(userId: string, proAccess: boolean): Promise<void> {
    this.entitlements.set(userId, {
      source: "demo-store",
      userId,
      proAccess,
      updatedAt: new Date().toISOString(),
    });
  }

  async applyEvent(
    event: DemoWebhookEvent,
    allowRepeatedEffects: boolean,
    suppressEntitlementEffect: boolean,
  ): Promise<DemoEventProcessingResult> {
    const previousDelivery = this.deliveries.get(event.eventId);
    const deliveryCount = (previousDelivery?.deliveryCount ?? 0) + 1;
    const duplicate = deliveryCount > 1;
    const payload = JSON.stringify([
      event.eventType,
      event.userId,
      event.subscriptionId,
      event.eventCreatedAt,
      event.status,
      event.currentPeriodEnd,
      event.cancelAtPeriodEnd,
    ]);
    const conflict = previousDelivery !== undefined && this.eventPayloads.get(event.eventId) !== payload;
    const priorProcessedCount = previousDelivery?.processedCount ?? 0;
    this.deliveries.set(event.eventId, {
      eventId: event.eventId,
      eventType: previousDelivery?.eventType ?? event.eventType,
      eventCreatedAt: previousDelivery?.eventCreatedAt ?? event.eventCreatedAt,
      userId: previousDelivery?.userId ?? event.userId,
      subscriptionId: previousDelivery?.subscriptionId ?? event.subscriptionId,
      deliveryCount,
      processedCount: priorProcessedCount,
      stale: previousDelivery?.stale ?? false,
      orderingAmbiguous: previousDelivery?.orderingAmbiguous ?? false,
    });
    this.eventPayloads.set(event.eventId, this.eventPayloads.get(event.eventId) ?? payload);

    if (conflict) {
      return this.result(
        duplicate,
        true,
        previousDelivery?.stale ?? false,
        previousDelivery?.orderingAmbiguous ?? false,
        false,
        deliveryCount,
        priorProcessedCount,
        null,
      );
    }
    if (duplicate && !allowRepeatedEffects) {
      return this.result(
        true,
        false,
        previousDelivery?.stale ?? false,
        previousDelivery?.orderingAmbiguous ?? false,
        false,
        deliveryCount,
        priorProcessedCount,
        null,
      );
    }

    const currentSubscription = this.subscriptions.get(event.userId);
    if (currentSubscription !== undefined) {
      if (event.eventCreatedAt < currentSubscription.lastEventCreatedAt) {
        this.markDeliveryStale(event.eventId, false);
        return this.result(duplicate, false, true, false, false, deliveryCount, priorProcessedCount, null);
      }
      if (event.eventCreatedAt === currentSubscription.lastEventCreatedAt && currentSubscription.lastEventId !== event.eventId) {
        this.markDeliveryStale(event.eventId, true);
        return this.result(duplicate, false, true, true, false, deliveryCount, priorProcessedCount, null);
      }
    }

    const updatedAt = new Date().toISOString();
    const subscription: DemoSubscription = {
      userId: event.userId,
      subscriptionId: event.subscriptionId,
      status: event.status,
      currentPeriodEnd: event.currentPeriodEnd,
      cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      lastEventCreatedAt: event.eventCreatedAt,
      lastEventId: event.eventId,
      updatedAt,
    };
    this.subscriptions.set(event.userId, subscription);

    let effectType: string | null = null;
    if (event.status === "active" || event.status === "trialing") {
      if (!suppressEntitlementEffect && event.eventId !== "evt_fixturesuccessfulpayment") {
        effectType = "entitlement_granted";
        this.entitlements.set(event.userId, {
          source: "demo-store",
          userId: event.userId,
          proAccess: true,
          updatedAt,
        });
      }
    } else if (event.status === "canceled") {
      if (!suppressEntitlementEffect) {
        effectType = "entitlement_revoked";
        this.entitlements.set(event.userId, {
          source: "demo-store",
          userId: event.userId,
          proAccess: false,
          updatedAt,
        });
      }
    }

    if (effectType !== null) {
      this.effects.push({
        eventId: event.eventId,
        effectType,
        count: 1,
        userId: event.userId,
        createdAt: updatedAt,
      });
    }
    const processedCount = priorProcessedCount + 1;
    this.deliveries.set(event.eventId, {
      ...this.deliveries.get(event.eventId)!,
      processedCount,
      stale: false,
      orderingAmbiguous: false,
    });
    return this.result(duplicate, false, false, false, true, deliveryCount, processedCount, effectType);
  }

  private markDeliveryStale(eventId: string, orderingAmbiguous: boolean): void {
    const delivery = this.deliveries.get(eventId);
    if (delivery !== undefined) {
      this.deliveries.set(eventId, { ...delivery, stale: true, orderingAmbiguous });
    }
  }

  private result(
    duplicate: boolean,
    conflict: boolean,
    stale: boolean,
    orderingAmbiguous: boolean,
    processed: boolean,
    deliveryCount: number,
    processedCount: number,
    effectType: string | null,
  ): DemoEventProcessingResult {
    return { duplicate, conflict, stale, orderingAmbiguous, processed, deliveryCount, processedCount, effectType };
  }

  async getEntitlement(userId: string): Promise<EntitlementSnapshot | null> {
    return (
      this.entitlements.get(userId) ?? {
        source: "demo-store",
        userId,
        proAccess: false,
        updatedAt: null,
      }
    );
  }

  async getSubscription(userId: string): Promise<DemoSubscription | null> {
    return this.subscriptions.get(userId) ?? null;
  }

  async getDelivery(eventId: string): Promise<DemoDelivery | null> {
    return this.deliveries.get(eventId) ?? null;
  }

  async getEffects(eventId: string): Promise<DemoEffect[]> {
    const grouped = new Map<string, DemoEffect>();
    for (const effect of this.effects.filter((candidate) => candidate.eventId === eventId)) {
      const key = effect.effectType;
      const previous = grouped.get(key);
      grouped.set(key, {
        ...effect,
        count: (previous?.count ?? 0) + 1,
      });
    }
    return [...grouped.values()];
  }
}
