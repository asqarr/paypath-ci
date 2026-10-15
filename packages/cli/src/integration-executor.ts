import type { ScenarioExecutor, ScenarioId, ScenarioObservations } from "@paypath/core";
import { createStripeTestClient, parseStripeTestConfiguration, readStripeSubscription } from "@paypath/stripe-adapter";
import {
  createSupabaseTestClient,
  parseSupabaseIntegrationConfiguration,
  SupabaseDemoRepository,
} from "@paypath/supabase-adapter";
import { z } from "zod";

const DemoApiResponseSchema = z.object({
  userId: z.string(),
  proAccess: z.boolean(),
  checkedAt: z.string().datetime({ offset: true }),
});

function envSuffix(scenario: ScenarioId): string {
  return scenario.toUpperCase().replaceAll("-", "_");
}

function scenarioEnvironment(scenario: ScenarioId, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const suffix = envSuffix(scenario);
  const subscriptionId = environment[`PAYPATH_STRIPE_SUBSCRIPTION_ID_${suffix}`];
  const userId = environment[`PAYPATH_TEST_USER_ID_${suffix}`] ?? environment["PAYPATH_TEST_USER_ID"];
  return {
    ...environment,
    ...(subscriptionId === undefined ? {} : { PAYPATH_STRIPE_SUBSCRIPTION_ID: subscriptionId }),
    ...(userId === undefined ? {} : { PAYPATH_TEST_USER_ID: userId }),
  };
}

function unavailable(message: string): ScenarioObservations {
  return {
    billing: null,
    applicationSubscriptionId: null,
    entitlement: null,
    authorization: null,
    webhookDeliveries: [],
    businessEffects: [],
    notes: [message, "Integration was not reported as passed."],
  };
}

export class IntegrationScenarioExecutor implements ScenarioExecutor {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async execute(scenario: ScenarioId): Promise<ScenarioObservations> {
    const selected = scenarioEnvironment(scenario, this.environment);
    const required = [
      ["STRIPE_SECRET_KEY", selected["STRIPE_SECRET_KEY"]],
      ["PAYPATH_STRIPE_SUBSCRIPTION_ID", selected["PAYPATH_STRIPE_SUBSCRIPTION_ID"]],
      ["SUPABASE_URL", selected["SUPABASE_URL"]],
      ["SUPABASE_SERVICE_ROLE_KEY", selected["SUPABASE_SERVICE_ROLE_KEY"]],
      ["PAYPATH_TEST_USER_ID", selected["PAYPATH_TEST_USER_ID"]],
      ["PAYPATH_TEST_SUPABASE_REF", selected["PAYPATH_TEST_SUPABASE_REF"]],
      ["PAYPATH_SUPABASE_TEST_PROJECT_ACK", selected["PAYPATH_SUPABASE_TEST_PROJECT_ACK"]],
    ] as const;
    const missing = required.filter(([, value]) => value === undefined || value.length === 0).map(([name]) => name);
    if (missing.length > 0) {
      return unavailable(`Missing integration configuration: ${missing.join(", ")}.`);
    }

    const stripeConfig = parseStripeTestConfiguration(selected);
    const supabaseConfig = parseSupabaseIntegrationConfiguration(selected);
    const stripe = createStripeTestClient(stripeConfig.secretKey);
    const supabase = createSupabaseTestClient(supabaseConfig);
    const repository = new SupabaseDemoRepository(supabase);

    const [billing, applicationSubscription, entitlement, authorizationResponse] = await Promise.all([
      readStripeSubscription(stripe, stripeConfig.subscriptionId, supabaseConfig.userId),
      repository.getSubscription(supabaseConfig.userId),
      repository.getEntitlement(supabaseConfig.userId),
      this.readAuthorization(selected["PAYPATH_DEMO_BASE_URL"] ?? "http://localhost:3000", supabaseConfig.userId),
    ]);

    let deliveries: ScenarioObservations["webhookDeliveries"] = [];
    let businessEffects: ScenarioObservations["businessEffects"] = [];
    const notes = [
      `Stripe Test Mode subscription ${billing.subscriptionId} read successfully.`,
      `Latest invoice payment status: ${billing.paymentStatus}.`,
      `Billing evaluation time source: ${billing.evaluationTimeSource}${billing.evaluationTime === null ? " (clock not ready)" : ` (${billing.evaluationTime})`}.`,
      ...(billing.currentPeriodEnd === null ? ["Billing period end could not be verified; the scenario cannot pass."] : []),
      `Supabase test project ${supabaseConfig.projectRef} returned the persisted entitlement.`,
      ...(applicationSubscription === null
        ? ["No persisted application subscription was found for the configured test user."]
        : [`Application subscription record ${applicationSubscription.subscriptionId} was read.`]),
      "Application authorization was read over HTTP; this check did not mutate Stripe or Supabase.",
    ];

    if (scenario === "duplicate-webhook") {
      const eventId = selected["PAYPATH_WEBHOOK_EVENT_ID_DUPLICATE_WEBHOOK"] ?? selected["PAYPATH_WEBHOOK_EVENT_ID"];
      if (eventId === undefined || eventId.length === 0) {
        notes.push("Set PAYPATH_WEBHOOK_EVENT_ID_DUPLICATE_WEBHOOK to the signed test event ID replayed through the Demo webhook.");
      } else {
        const delivery = await repository.getDelivery(eventId);
        if (delivery !== null && delivery.userId === supabaseConfig.userId && delivery.subscriptionId === billing.subscriptionId) {
          deliveries = [{
            eventId: delivery.eventId,
            deliveryCount: delivery.deliveryCount,
            processedCount: delivery.processedCount,
          }];
          businessEffects = (await repository.getEffects(eventId)).map(({ eventId: id, effectType, count }) => ({
            eventId: id,
            effectType,
            count,
          }));
          notes.push(`Database evidence for ${eventId} belongs to the configured user and subscription.`);
        } else {
          notes.push("No matching webhook event was found for this user and subscription.");
        }
      }
    }

    return {
      billing,
      applicationSubscriptionId: applicationSubscription?.subscriptionId ?? null,
      entitlement,
      authorization: authorizationResponse,
      webhookDeliveries: deliveries,
      businessEffects,
      notes,
    };
  }

  private async readAuthorization(baseUrl: string, userId: string): Promise<ScenarioObservations["authorization"]> {
    const parsed = z.string().url().safeParse(baseUrl);
    if (!parsed.success) throw new Error("PAYPATH_DEMO_BASE_URL must be a valid URL.");
    const url = new URL(parsed.data);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("Demo authorization integration requires HTTPS, except for localhost.");
    }
    const endpoint = new URL("/api/pro/feature", url);
    endpoint.searchParams.set("userId", userId);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (response.status !== 200 && response.status !== 403) {
      throw new Error(`Demo authorization API returned HTTP ${response.status}.`);
    }
    const body: unknown = await response.json();
    const parsedBody = DemoApiResponseSchema.safeParse(body);
    if (!parsedBody.success || parsedBody.data.userId !== userId) {
      throw new Error("Demo authorization API returned an invalid or mismatched response.");
    }
    if (parsedBody.data.proAccess !== (response.status === 200)) {
      throw new Error("Demo authorization API status and Pro access result disagree.");
    }
    return {
      source: "demo-api",
      userId,
      httpStatus: response.status,
      proAccess: parsedBody.data.proAccess,
      checkedAt: parsedBody.data.checkedAt,
    };
  }
}
