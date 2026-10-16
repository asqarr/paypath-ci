import { describe, expect, it, vi } from "vitest";
import { SupabaseDatabaseError } from "@paypath/supabase-adapter";
import { logWebhookProcessingFailure } from "./diagnostics.ts";

describe("Stripe webhook failure diagnostics", () => {
  it("logs allowlisted RPC diagnostics without remote error text", () => {
    const write = vi.fn();
    const error = new SupabaseDatabaseError({
      operation: "webhook transaction",
      rpcName: "process_demo_stripe_event",
      errorType: "PostgrestError",
      errorCode: "23503",
      httpStatus: 500,
      message: "foreign key failed; token=never-log-this; user=private-user",
    });

    logWebhookProcessingFailure(error, write);

    expect(write).toHaveBeenCalledExactlyOnceWith({
      operation: "process_demo_stripe_event",
      errorType: "PostgrestError",
      errorCode: "23503",
      httpStatus: 500,
    });
    const logged = JSON.stringify(write.mock.calls[0]?.[0]);
    expect(logged).not.toContain("never-log-this");
    expect(logged).not.toContain("private-user");
    expect(Object.keys(write.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      "errorCode", "errorType", "httpStatus", "operation",
    ]);
  });

  it("logs a generic error category without its message, name, or cause", () => {
    const write = vi.fn();
    const error = Object.assign(new Error("secret=must-not-appear"), {
      name: "sensitive-user-data",
      cause: "private-token",
    });

    logWebhookProcessingFailure(error, write);

    expect(write).toHaveBeenCalledExactlyOnceWith({
      operation: "stripe_webhook.process",
      errorType: "UnhandledError",
    });
    const logged = JSON.stringify(write.mock.calls[0]?.[0]);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("sensitive-user-data");
    expect(logged).not.toContain("private-token");
  });
});
