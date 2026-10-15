import type { ScenarioId } from "./types.ts";

export interface ScenarioDefinition {
  id: ScenarioId;
  name: string;
  reproductionSteps: string[];
  billingPrecondition: "payment-confirmed" | "cancellation-effective";
}

export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = {
  "successful-payment": {
    id: "successful-payment",
    name: "Successful payment grants Pro access",
    billingPrecondition: "payment-confirmed",
    reproductionSteps: [
      "Start with a test subscription whose Stripe status is active.",
      "Deliver its subscription-created or subscription-updated event once.",
      "Compare the persisted entitlement and authorization response with the billing policy.",
    ],
  },
  cancellation: {
    id: "cancellation",
    name: "Ended subscription revokes Pro access",
    billingPrecondition: "cancellation-effective",
    reproductionSteps: [
      "Start with a test subscription whose paid period has ended and Stripe status is canceled.",
      "Deliver the subscription-deleted event.",
      "Compare the persisted entitlement and authorization response with the billing policy.",
    ],
  },
  "duplicate-webhook": {
    id: "duplicate-webhook",
    name: "Repeated webhook has one business effect",
    billingPrecondition: "payment-confirmed",
    reproductionSteps: [
      "Start with an active test subscription.",
      "Deliver the exact same signed webhook event ID twice.",
      "Verify deliveries are recorded while business effects for that event remain idempotent.",
    ],
  },
};

export function isActiveSubscription(status: string): boolean {
  return status === "active" || status === "trialing";
}
