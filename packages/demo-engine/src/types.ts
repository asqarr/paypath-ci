import type { BusinessEffectEvidence, EntitlementSnapshot, ScenarioId, WebhookDeliveryEvidence } from "@paypath/core";

export type DemoMode = "buggy" | "fixed";

export interface DemoWebhookEvent {
  eventId: string;
  eventType: string;
  eventCreatedAt: number;
  userId: string;
  subscriptionId: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface DemoSubscription {
  userId: string;
  subscriptionId: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  lastEventCreatedAt: number;
  lastEventId: string | null;
  updatedAt: string;
}

export interface DemoDelivery extends WebhookDeliveryEvidence {
  eventType: string;
  eventCreatedAt: number;
  userId: string;
  subscriptionId: string;
  stale: boolean;
  orderingAmbiguous: boolean;
}

export interface DemoEventProcessingResult {
  duplicate: boolean;
  conflict: boolean;
  stale: boolean;
  orderingAmbiguous: boolean;
  processed: boolean;
  deliveryCount: number;
  processedCount: number;
  effectType: string | null;
}

export interface DemoEffect extends BusinessEffectEvidence {
  userId: string;
  createdAt: string;
}

export interface DemoRepository {
  seedEntitlement(userId: string, proAccess: boolean): Promise<void>;
  applyEvent(
    event: DemoWebhookEvent,
    allowRepeatedEffects: boolean,
    suppressEntitlementEffect: boolean,
  ): Promise<DemoEventProcessingResult>;
  getEntitlement(userId: string): Promise<EntitlementSnapshot | null>;
  getSubscription(userId: string): Promise<DemoSubscription | null>;
  getDelivery(eventId: string): Promise<DemoDelivery | null>;
  getEffects(eventId: string): Promise<DemoEffect[]>;
}

export interface DemoFaults {
  mode: DemoMode;
  scenario: ScenarioId | null;
}
