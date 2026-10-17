import { describe, expect, it } from "vitest";
import { createGitHubWebhookSignature, verifyGitHubWebhookSignature } from "./signature.js";

describe("GitHub webhook signature verification", () => {
  const body = Buffer.from('{"action":"opened"}', "utf8");
  const secret = "synthetic-webhook-secret-for-unit-tests";

  it("accepts a valid HMAC-SHA256 signature for the raw body", () => {
    const signature = createGitHubWebhookSignature(body, secret);
    expect(verifyGitHubWebhookSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a bad signature, missing header, malformed header, or changed body", () => {
    const signature = createGitHubWebhookSignature(body, secret);
    expect(verifyGitHubWebhookSignature(body, `sha256=${"0".repeat(64)}`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(body, "sha1=invalid", secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(Buffer.from("changed"), signature, secret)).toBe(false);
  });
});
