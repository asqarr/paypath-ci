import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8").toLowerCase();

describe("Supabase schema security and consistency contract", () => {
  it("uses a locked-down definer context and grants RPC execution only to service_role", () => {
    expect((schema.match(/^security definer$/gm) ?? [])).toHaveLength(2);
    expect((schema.match(/set search_path = pg_catalog, pg_temp/g) ?? [])).toHaveLength(2);
    expect(schema).not.toContain("alter default privileges");
    expect(schema).toContain("revoke all on function public.process_demo_stripe_event(");
    expect(schema).toContain("revoke all on function public.cleanup_demo_test_user(");
    expect(schema).toContain("grant execute on function public.process_demo_stripe_event(");
    expect(schema).toContain("grant execute on function public.cleanup_demo_test_user(");
    expect(schema.match(/to service_role;/g)?.length).toBeGreaterThanOrEqual(3);
    expect(schema).toContain("revoke paypath_rpc_owner from anon, authenticated, service_role");
    expect(schema).toContain("with set true, inherit false");
    expect(schema).toContain("set role paypath_rpc_owner;");
    expect(schema).toContain("reset role;");
    expect(schema).not.toContain("alter function public.");
  });

  it("validates test identifiers and restricts cleanup to the exact user and subscription", () => {
    expect(schema).toContain("p_user_id !~ '^paypath-test-[a-za-z0-9_-]{3,220}$'");
    expect(schema).toContain("p_subscription_id !~ '^sub_[a-za-z0-9]+$'");
    expect(schema).toContain("where w.user_id = p_user_id and w.subscription_id = p_subscription_id");
    expect(schema).toContain("where s.user_id = p_user_id and s.stripe_subscription_id = p_subscription_id");
    expect(schema).toContain("foreign key (event_id, user_id)");
    expect(schema).toContain("on delete cascade");
  });

  it("serializes duplicate deliveries, preserves payload identity, and rejects older state", () => {
    expect(schema).toContain("pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id, 0))");
    expect(schema).toContain("set delivery_count = public.demo_webhook_events.delivery_count + 1");
    expect(schema).not.toContain("subscription_id = excluded.subscription_id,");
    expect(schema).toContain("v_stored_status is not distinct from p_status");
    expect(schema).toContain("excluded.last_event_created_at > current_subscription.last_event_created_at");
    expect(schema).toContain("v_ordering_ambiguous := v_current_event_created_at = p_event_created_at");
  });

  it("keeps row-level security enabled and scopes table access to trusted roles", () => {
    for (const table of [
      "demo_subscriptions",
      "demo_entitlements",
      "demo_webhook_events",
      "demo_business_effects",
    ]) {
      expect(schema).toContain(`alter table public.${table} enable row level security`);
    }
    expect(schema).toContain("grant select, insert, update, delete on public.demo_subscriptions");
    expect(schema).toContain("to paypath_rpc_owner;");
    expect(schema).toContain("grant select on public.demo_subscriptions, public.demo_entitlements");
    expect(schema).toContain("grant insert, update on public.demo_entitlements to service_role");
  });
});
