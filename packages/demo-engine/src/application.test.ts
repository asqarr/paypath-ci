import { describe, expect, it } from "vitest";
import { DemoApplication } from "./application.ts";
import { InMemoryDemoRepository } from "./in-memory-repository.ts";

const event = {
  eventId: "evt_valid",
  eventType: "customer.subscription.updated",
  eventCreatedAt: Math.floor(Date.now() / 1000),
  userId: "paypath-test-valid",
  subscriptionId: "sub_valid",
  status: "active",
  currentPeriodEnd: new Date(Date.now() + 60_000).toISOString(),
  cancelAtPeriodEnd: false,
};

describe("Demo webhook application", () => {
  it("records deliveries separately from idempotent business processing", async () => {
    const repository = new InMemoryDemoRepository();
    const app = new DemoApplication(repository, { mode: "fixed", scenario: null });

    await app.processWebhook(event);
    await app.processWebhook(event);

    expect(await repository.getDelivery(event.eventId)).toMatchObject({ deliveryCount: 2, processedCount: 1 });
    expect(await repository.getEffects(event.eventId)).toMatchObject([
      { effectType: "entitlement_granted", count: 1 },
    ]);
    expect(await app.authorize(event.userId)).toMatchObject({ httpStatus: 200, proAccess: true });
  });

  it("rejects malformed webhook payloads at the application boundary", async () => {
    const app = new DemoApplication(new InMemoryDemoRepository(), { mode: "fixed", scenario: null });
    await expect(app.processWebhook({ ...event, status: "not-a-stripe-status" })).rejects.toThrow();
  });

  it("serializes concurrent duplicate deliveries into one fixed-mode business effect", async () => {
    const repository = new InMemoryDemoRepository();
    const app = new DemoApplication(repository, { mode: "fixed", scenario: null });

    await Promise.all(Array.from({ length: 12 }, () => app.processWebhook(event)));

    expect(await repository.getDelivery(event.eventId)).toMatchObject({ deliveryCount: 12, processedCount: 1 });
    expect(await repository.getEffects(event.eventId)).toMatchObject([
      { effectType: "entitlement_granted", count: 1 },
    ]);
  });

  it("does not let an older subscription event replace a newer state", async () => {
    const repository = new InMemoryDemoRepository();
    const app = new DemoApplication(repository, { mode: "fixed", scenario: null });
    await app.processWebhook({ ...event, eventId: "evt_newer", eventCreatedAt: 2_000, status: "active" });

    const result = await app.processWebhook({
      ...event,
      eventId: "evt_older",
      eventCreatedAt: 1_999,
      status: "canceled",
      eventType: "customer.subscription.deleted",
    });

    expect(result).toMatchObject({ stale: true, orderingAmbiguous: false, processed: false });
    expect(await repository.getSubscription(event.userId)).toMatchObject({ status: "active", lastEventId: "evt_newer" });
    expect(await app.authorize(event.userId)).toMatchObject({ proAccess: true });
  });

  it("fails closed for distinct Stripe events created in the same second", async () => {
    const repository = new InMemoryDemoRepository();
    const app = new DemoApplication(repository, { mode: "fixed", scenario: null });
    await app.processWebhook({ ...event, eventId: "evt_first", eventCreatedAt: 2_100, status: "active" });

    const result = await app.processWebhook({
      ...event,
      eventId: "evt_second",
      eventCreatedAt: 2_100,
      status: "canceled",
      eventType: "customer.subscription.deleted",
    });

    expect(result).toMatchObject({ stale: true, orderingAmbiguous: true, processed: false });
    expect(await repository.getSubscription(event.userId)).toMatchObject({ status: "active", lastEventId: "evt_first" });
    expect(await repository.getDelivery("evt_second")).toMatchObject({ stale: true, orderingAmbiguous: true });
  });

  it("rejects reuse of an event ID with a different business payload", async () => {
    const repository = new InMemoryDemoRepository();
    const app = new DemoApplication(repository, { mode: "fixed", scenario: null });
    await app.processWebhook(event);

    const result = await app.processWebhook({ ...event, status: "canceled" });

    expect(result).toMatchObject({ duplicate: true, conflict: true, processed: false });
    expect(await repository.getSubscription(event.userId)).toMatchObject({ status: "active" });
    expect(await repository.getEffects(event.eventId)).toMatchObject([
      { effectType: "entitlement_granted", count: 1 },
    ]);
  });
});
