import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/i;

/** Verifies the exact raw request body using GitHub's HMAC-SHA256 signature. */
export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !SIGNATURE_PATTERN.test(signatureHeader) || secret.length === 0) {
    return false;
  }

  const suppliedDigest = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expectedDigest = createHmac("sha256", secret).update(rawBody).digest();

  return suppliedDigest.length === expectedDigest.length &&
    timingSafeEqual(suppliedDigest, expectedDigest);
}

export function createGitHubWebhookSignature(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
