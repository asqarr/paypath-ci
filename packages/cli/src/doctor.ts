import { parseStripeTestConfiguration } from "@paypath/stripe-adapter";
import { parseSupabaseIntegrationConfiguration } from "@paypath/supabase-adapter";

export interface DoctorReport {
  lines: string[];
  exitCode: 0 | 1;
}

const TEMPLATE_MARKERS = [/replace/i, /^paypath-test-pilot-001$/i] as const;
const INTEGRATION_CONFIGURATION_KEYS = new Set([
  "STRIPE_SECRET_KEY",
  "PAYPATH_STRIPE_SUBSCRIPTION_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYPATH_TEST_SUPABASE_REF",
  "PAYPATH_SUPABASE_TEST_PROJECT_ACK",
  "PAYPATH_TEST_USER_ID",
  "PAYPATH_WEBHOOK_EVENT_ID",
]);

function isIntegrationConfigurationKey(name: string): boolean {
  return INTEGRATION_CONFIGURATION_KEYS.has(name) ||
    /^PAYPATH_(?:STRIPE_SUBSCRIPTION_ID|TEST_USER_ID|WEBHOOK_EVENT_ID)_[A-Z0-9_]+$/.test(name);
}

function placeholderVariables(environment: Record<string, string | undefined>): string[] {
  return Object.entries(environment)
    .filter(([name, value]) =>
      isIntegrationConfigurationKey(name) &&
      value !== undefined &&
      TEMPLATE_MARKERS.some((marker) => marker.test(value)),
    )
    .map(([name]) => name)
    .sort();
}

/**
 * Validate local configuration only. This function intentionally creates no
 * Stripe, Supabase, or Demo API clients and makes no network requests.
 */
export function createDoctorReport(
  environment: Record<string, string | undefined>,
  nodeVersion: string,
): DoctorReport {
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const supportedNode = Number.isFinite(nodeMajor) && nodeMajor >= 24;
  const lines = [
    `Node.js: ${nodeVersion} ${supportedNode ? "OK" : "TOO OLD (need Node.js 24+)"}`,
    "Local deterministic engine: available (no external credentials required)",
  ];

  const hasIntegrationConfiguration =
    environment["STRIPE_SECRET_KEY"] !== undefined || environment["SUPABASE_URL"] !== undefined;
  const placeholders = placeholderVariables(environment);

  if (!hasIntegrationConfiguration) {
    lines.push("Stripe/Supabase configuration: INCOMPLETE (not configured).");
  } else if (placeholders.length > 0) {
    lines.push(`Stripe/Supabase configuration: INCOMPLETE (template placeholders remain in: ${placeholders.join(", ")}).`);
  } else {
    try {
      parseStripeTestConfiguration(environment);
      parseSupabaseIntegrationConfiguration(environment);
      lines.push("Stripe/Supabase configuration: FORMAT VALID (local validation only; credentials have not been authenticated).");
    } catch {
      lines.push("Stripe/Supabase configuration: INCOMPLETE or INVALID (local format validation failed; values omitted).");
    }
  }

  lines.push("Connection: NOT TESTED; doctor makes no network requests to Stripe, Supabase, or the Demo API.");

  return { lines, exitCode: supportedNode ? 0 : 1 };
}
