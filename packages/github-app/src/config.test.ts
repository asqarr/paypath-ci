import { describe, expect, it } from "vitest";
import { InvalidGitHubAppConfiguration, parseGitHubAppConfig } from "./config.js";

const syntheticPemBegin = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const syntheticPemEnd = ["-----END", "RSA PRIVATE KEY-----"].join(" ");

const syntheticEnvironment = {
  PAYPATH_GITHUB_APP_ID: "12345",
  PAYPATH_GITHUB_PRIVATE_KEY: `${syntheticPemBegin}\n${"synthetic-private-key-material-".repeat(4)}\n${syntheticPemEnd}`,
  PAYPATH_GITHUB_WEBHOOK_SECRET: "synthetic-webhook-secret-for-tests-only",
};

describe("GitHub App configuration", () => {
  it("validates synthetic configuration without connecting to GitHub", () => {
    const config = parseGitHubAppConfig(syntheticEnvironment);
    expect(config).toMatchObject({ appId: 12345, host: "127.0.0.1", port: 8787 });
    expect(config.privateKey).toContain("\n");
  });

  it("preserves webhook secret bytes instead of trimming a valid secret", () => {
    const secret = "  synthetic-webhook-secret-with-significant-spaces  ";
    const config = parseGitHubAppConfig({
      ...syntheticEnvironment,
      PAYPATH_GITHUB_WEBHOOK_SECRET: secret,
    });
    expect(config.webhookSecret).toBe(secret);
  });

  it("reports missing and placeholder variable names without their values", () => {
    expect(() => parseGitHubAppConfig({
      PAYPATH_GITHUB_APP_ID: "replace_with_github_app_id",
      PAYPATH_GITHUB_PRIVATE_KEY: "replace_with_github_app_private_key_pem",
      PAYPATH_GITHUB_WEBHOOK_SECRET: "replace_with_github_app_webhook_secret",
    })).toThrow(InvalidGitHubAppConfiguration);

    try {
      parseGitHubAppConfig({
        PAYPATH_GITHUB_APP_ID: "replace_with_github_app_id",
        PAYPATH_GITHUB_PRIVATE_KEY: "replace_with_github_app_private_key_pem",
        PAYPATH_GITHUB_WEBHOOK_SECRET: "replace_with_github_app_webhook_secret",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidGitHubAppConfiguration);
      expect((error as Error).message).not.toContain("replace_with");
      expect((error as InvalidGitHubAppConfiguration).variables).toContain("PAYPATH_GITHUB_APP_ID");
    }
  });
});
