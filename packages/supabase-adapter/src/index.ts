import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { EntitlementSnapshot } from "@paypath/core";
import { DemoWebhookEventSchema } from "@paypath/demo-engine";
import type {
  DemoDelivery,
  DemoEffect,
  DemoRepository,
  DemoSubscription,
  DemoWebhookEvent,
} from "@paypath/demo-engine";

const SupabaseConnectionEnvironmentSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PAYPATH_TEST_SUPABASE_REF: z.string().min(1),
  PAYPATH_SUPABASE_TEST_PROJECT_ACK: z.literal("disposable-test-project"),
});
const SupabaseIntegrationEnvironmentSchema = SupabaseConnectionEnvironmentSchema.extend({
  PAYPATH_TEST_USER_ID: z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/),
  PAYPATH_STRIPE_SUBSCRIPTION_ID: z.string().max(255).regex(/^sub_[A-Za-z0-9]+$/),
});

const EntitlementRowSchema = z.object({
  user_id: z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/),
  pro_access: z.boolean(),
  updated_at: z.string().datetime({ offset: true }),
});
const SubscriptionRowSchema = z.object({
  user_id: z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/),
  stripe_subscription_id: z.string().max(255).regex(/^sub_[A-Za-z0-9]+$/),
  status: z.enum([
    "active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused",
  ]),
  current_period_end: z.string().datetime({ offset: true }).nullable(),
  cancel_at_period_end: z.boolean(),
  last_event_created_at: z.number().int().positive(),
  last_event_id: z.string().regex(/^evt_[A-Za-z0-9]+$/).nullable(),
  updated_at: z.string().datetime({ offset: true }),
});
const DeliveryRowSchema = z.object({
  event_id: z.string().max(255).regex(/^evt_[A-Za-z0-9]+$/),
  event_type: z.enum([
    "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  ]),
  user_id: z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/),
  subscription_id: z.string().max(255).regex(/^sub_[A-Za-z0-9]+$/),
  event_created_at: z.number().int().positive(),
  delivery_count: z.number().int().positive(),
  processed_count: z.number().int().nonnegative(),
  stale: z.boolean(),
  ordering_ambiguous: z.boolean(),
});
const EffectRowSchema = z.object({
  event_id: z.string().max(255).regex(/^evt_[A-Za-z0-9]+$/),
  effect_type: z.enum(["entitlement_granted", "entitlement_revoked"]),
  user_id: z.string().regex(/^paypath-test-[A-Za-z0-9_-]{3,220}$/),
  created_at: z.string().datetime({ offset: true }),
});
const ProcessEventResultSchema = z.object({
  duplicate: z.boolean(),
  conflict: z.boolean(),
  stale: z.boolean(),
  ordering_ambiguous: z.boolean(),
  processed: z.boolean(),
  delivery_count: z.number().int().positive(),
  processed_count: z.number().int().nonnegative(),
  effect_type: z.enum(["entitlement_granted", "entitlement_revoked"]).nullable(),
});
const CleanupResultSchema = z.object({
  effects_deleted: z.number().int().nonnegative(),
  events_deleted: z.number().int().nonnegative(),
  subscriptions_deleted: z.number().int().nonnegative(),
  entitlements_deleted: z.number().int().nonnegative(),
});

export interface SupabaseTestConfiguration {
  url: string;
  serviceRoleKey: string;
  projectRef: string;
}

export interface SupabaseIntegrationConfiguration extends SupabaseTestConfiguration {
  userId: string;
  subscriptionId: string;
}

export interface SupabaseDatabaseDiagnostic {
  operation: string;
  rpcName?: string;
  errorType: string;
  errorCode?: string;
  httpStatus?: number;
  message: string;
}

export class SupabaseDatabaseError extends Error {
  constructor(readonly diagnostic: SupabaseDatabaseDiagnostic) {
    super(diagnostic.message);
    this.name = "SupabaseDatabaseError";
  }
}

function validateSupabaseProject(
  parsed: z.infer<typeof SupabaseConnectionEnvironmentSchema>,
): SupabaseTestConfiguration {
  const url = new URL(parsed.SUPABASE_URL);
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localHost) {
    throw new Error("Supabase integration requires HTTPS, except for localhost development.");
  }
  if (localHost) {
    if (parsed.PAYPATH_TEST_SUPABASE_REF !== "local") {
      throw new Error('Set PAYPATH_TEST_SUPABASE_REF=local when using a local Supabase instance.');
    }
  } else {
    const projectRef = url.hostname.split(".")[0];
    if (!url.hostname.endsWith(".supabase.co") || projectRef !== parsed.PAYPATH_TEST_SUPABASE_REF) {
      throw new Error("Supabase URL does not match PAYPATH_TEST_SUPABASE_REF; refusing an unverified project.");
    }
  }
  return {
    url: parsed.SUPABASE_URL,
    serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    projectRef: parsed.PAYPATH_TEST_SUPABASE_REF,
  };
}

export function parseSupabaseTestConfiguration(
  environment: Record<string, string | undefined>,
): SupabaseTestConfiguration {
  return validateSupabaseProject(SupabaseConnectionEnvironmentSchema.parse(environment));
}

export function parseSupabaseIntegrationConfiguration(
  environment: Record<string, string | undefined>,
): SupabaseIntegrationConfiguration {
  const parsed = SupabaseIntegrationEnvironmentSchema.parse(environment);
  const connection = validateSupabaseProject(parsed);
  return {
    ...connection,
    userId: parsed.PAYPATH_TEST_USER_ID,
    subscriptionId: parsed.PAYPATH_STRIPE_SUBSCRIPTION_ID,
  };
}

export function createSupabaseTestClient(configuration: SupabaseTestConfiguration): SupabaseClient {
  return createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      headers: { "x-application-name": "paypath-ci-test-adapter" },
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(8_000),
      }),
    },
  });
}

export function validateDemoCleanupTarget(userId: string, subscriptionId: string): void {
  if (!/^paypath-test-[A-Za-z0-9_-]{3,220}$/.test(userId)) {
    throw new Error("Cleanup is restricted to paypath-test-* user IDs.");
  }
  if (subscriptionId.length > 255 || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) {
    throw new Error("Cleanup requires a Stripe subscription ID in sub_* format.");
  }
}

export async function cleanupDemoTestData(
  client: SupabaseClient,
  userId: string,
  subscriptionId: string,
): Promise<z.infer<typeof CleanupResultSchema>> {
  validateDemoCleanupTarget(userId, subscriptionId);
  const { data, error, status } = await client.rpc("cleanup_demo_test_user", {
    p_user_id: userId,
    p_subscription_id: subscriptionId,
  });
  if (error) throwDatabaseError("test data cleanup", error, status, "cleanup_demo_test_user");
  const parsed = CleanupResultSchema.safeParse(data);
  if (!parsed.success) throw new Error("Supabase cleanup returned an invalid result.");
  return parsed.data;
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : undefined;
}

function remoteErrorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

function safeErrorType(error: unknown, httpStatus: number | undefined): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = error.name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) return name;
  }
  const message = remoteErrorMessage(error);
  if (message && /^(?:TypeError:\s*)?fetch failed(?:$|\W)/i.test(message)) return "FetchError";
  if (safeErrorCode(error)) return "PostgrestError";
  if (message) return "SupabaseError";
  return httpStatus === 0 ? "FetchError" : "UnknownError";
}

function safeDatabaseMessage(code: string | undefined, error: unknown, httpStatus: number | undefined): string {
  if (code === "PGRST202") {
    return "PostgREST could not resolve the RPC using the exposed schema cache and supplied argument names.";
  }
  if (code === "42501") return "PostgreSQL denied the requested operation.";
  if (code === "PGRST301" || code === "PGRST302") {
    return "Supabase rejected API authorization for the request.";
  }
  if (!code && (httpStatus === undefined || httpStatus === 0) &&
      /^(?:TypeError:\s*)?fetch failed(?:$|\W)/i.test(remoteErrorMessage(error) ?? "")) {
    return "Node.js could not establish the Supabase HTTP request; no HTTP response was received and raw transport details were omitted.";
  }
  if (code?.startsWith("PGRST")) return "PostgREST rejected the request; remote details were omitted.";
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    return "PostgreSQL rejected the request; remote details were omitted.";
  }
  return "The Supabase request failed; remote details were omitted.";
}

function throwDatabaseError(
  operation: string,
  error: unknown,
  httpStatus: number | undefined,
  rpcName?: string,
): never {
  const errorCode = safeErrorCode(error);
  const diagnostic: SupabaseDatabaseDiagnostic = {
    operation,
    errorType: safeErrorType(error, httpStatus),
    message: safeDatabaseMessage(errorCode, error, httpStatus),
  };
  if (rpcName) diagnostic.rpcName = rpcName;
  if (errorCode) diagnostic.errorCode = errorCode;
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) {
    diagnostic.httpStatus = httpStatus;
  }
  throw new SupabaseDatabaseError(diagnostic);
}

export class SupabaseDemoRepository implements DemoRepository {
  constructor(private readonly client: SupabaseClient) {}

  async seedEntitlement(userId: string, proAccess: boolean): Promise<void> {
    validateDemoUserId(userId);
    const { error, status } = await this.client.from("demo_entitlements").upsert(
      { user_id: userId, pro_access: proAccess, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throwDatabaseError("entitlement seed", error, status);
  }

  async applyEvent(event: DemoWebhookEvent, allowRepeatedEffects: boolean, suppressEntitlementEffect: boolean) {
    event = DemoWebhookEventSchema.parse(event);
    const { data, error, status } = await this.client.rpc("process_demo_stripe_event", {
      p_event_id: event.eventId,
      p_event_type: event.eventType,
      p_user_id: event.userId,
      p_subscription_id: event.subscriptionId,
      p_status: event.status,
      p_current_period_end: event.currentPeriodEnd,
      p_cancel_at_period_end: event.cancelAtPeriodEnd,
      p_event_created_at: event.eventCreatedAt,
      p_allow_repeated_effects: allowRepeatedEffects,
      p_suppress_entitlement_effect: suppressEntitlementEffect,
    });
    if (error) throwDatabaseError("webhook transaction", error, status, "process_demo_stripe_event");
    const parsed = ProcessEventResultSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Supabase webhook transaction returned an invalid result.");
    }
    return {
      duplicate: parsed.data.duplicate,
      conflict: parsed.data.conflict,
      stale: parsed.data.stale,
      orderingAmbiguous: parsed.data.ordering_ambiguous,
      processed: parsed.data.processed,
      deliveryCount: parsed.data.delivery_count,
      processedCount: parsed.data.processed_count,
      effectType: parsed.data.effect_type,
    };
  }

  async getEntitlement(userId: string): Promise<EntitlementSnapshot | null> {
    validateDemoUserId(userId);
    const { data, error, status } = await this.client
      .from("demo_entitlements")
      .select("user_id, pro_access, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDatabaseError("entitlement read", error, status);
    if (data === null) return null;
    const row = EntitlementRowSchema.safeParse(data);
    if (!row.success) throw new Error("Supabase entitlement row has an invalid shape.");
    return {
      source: "supabase",
      userId: row.data.user_id,
      proAccess: row.data.pro_access,
      updatedAt: row.data.updated_at,
    };
  }

  async getSubscription(userId: string): Promise<DemoSubscription | null> {
    validateDemoUserId(userId);
    const { data, error, status } = await this.client
      .from("demo_subscriptions")
      .select("user_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, last_event_created_at, last_event_id, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDatabaseError("subscription read", error, status);
    if (data === null) return null;
    const row = SubscriptionRowSchema.safeParse(data);
    if (!row.success) throw new Error("Supabase subscription row has an invalid shape.");
    return {
      userId: row.data.user_id,
      subscriptionId: row.data.stripe_subscription_id,
      status: row.data.status,
      currentPeriodEnd: row.data.current_period_end,
      cancelAtPeriodEnd: row.data.cancel_at_period_end,
      lastEventCreatedAt: row.data.last_event_created_at,
      lastEventId: row.data.last_event_id,
      updatedAt: row.data.updated_at,
    };
  }

  async getDelivery(eventId: string): Promise<DemoDelivery | null> {
    if (eventId.length > 255 || !/^evt_[A-Za-z0-9]+$/.test(eventId)) throw new Error("Webhook evidence requires an evt_* ID.");
    const { data, error, status } = await this.client
      .from("demo_webhook_events")
      .select("event_id, event_type, user_id, subscription_id, event_created_at, delivery_count, processed_count, stale, ordering_ambiguous")
      .eq("event_id", eventId)
      .maybeSingle();
    if (error) throwDatabaseError("webhook evidence read", error, status);
    if (data === null) return null;
    const row = DeliveryRowSchema.safeParse(data);
    if (!row.success) throw new Error("Supabase webhook evidence row has an invalid shape.");
    return {
      eventId: row.data.event_id,
      eventType: row.data.event_type,
      userId: row.data.user_id,
      subscriptionId: row.data.subscription_id,
      eventCreatedAt: row.data.event_created_at,
      deliveryCount: row.data.delivery_count,
      processedCount: row.data.processed_count,
      stale: row.data.stale,
      orderingAmbiguous: row.data.ordering_ambiguous,
    };
  }

  async getEffects(eventId: string): Promise<DemoEffect[]> {
    if (eventId.length > 255 || !/^evt_[A-Za-z0-9]+$/.test(eventId)) throw new Error("Business-effect evidence requires an evt_* ID.");
    const { data, error, status } = await this.client
      .from("demo_business_effects")
      .select("event_id, effect_type, user_id, created_at")
      .eq("event_id", eventId);
    if (error) throwDatabaseError("business-effect read", error, status);
    const counts = new Map<string, DemoEffect>();
    for (const value of data ?? []) {
      const parsed = EffectRowSchema.safeParse(value);
      if (!parsed.success) throw new Error("Supabase business-effect row has an invalid shape.");
      const row = parsed.data;
      const previous = counts.get(row.effect_type);
      counts.set(row.effect_type, {
        eventId: row.event_id,
        effectType: row.effect_type,
        userId: row.user_id,
        createdAt: row.created_at,
        count: (previous?.count ?? 0) + 1,
      });
    }
    return [...counts.values()];
  }
}

function validateDemoUserId(userId: string): void {
  if (!/^paypath-test-[A-Za-z0-9_-]{3,220}$/.test(userId)) {
    throw new Error("Supabase Demo operations are restricted to valid paypath-test-* user IDs.");
  }
}

export function getSupabaseClientFromEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  client: SupabaseClient;
  configuration: SupabaseTestConfiguration;
} {
  const configuration = parseSupabaseTestConfiguration(environment);
  return { client: createSupabaseTestClient(configuration), configuration };
}
