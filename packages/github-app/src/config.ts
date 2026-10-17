import { z } from "zod";

const PLACEHOLDER_PATTERN = /(?:replace[-_ ]?with|placeholder|your[-_ ](?:app|key|secret)|<[^>]+>)/i;

function nonPlaceholderString(minimumLength: number) {
  return z.string()
    .min(minimumLength)
    .refine((value) => value.trim().length >= minimumLength && !PLACEHOLDER_PATTERN.test(value));
}

const PrivateKeySchema = nonPlaceholderString(80)
  .transform((value) => value.replace(/\\n/g, "\n"))
  .refine((value) =>
    /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(value),
  );

const GitHubAppConfigSchema = z.object({
  PAYPATH_GITHUB_APP_ID: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()),
  PAYPATH_GITHUB_PRIVATE_KEY: PrivateKeySchema,
  PAYPATH_GITHUB_WEBHOOK_SECRET: nonPlaceholderString(20),
  PAYPATH_GITHUB_PORT: z.string().regex(/^\d+$/).optional().transform((value) => value === undefined ? 8787 : Number(value))
    .pipe(z.number().int().min(1).max(65535)),
  PAYPATH_GITHUB_HOST: z.string().min(1).optional().default("127.0.0.1"),
});

export type GitHubAppConfig = {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  port: number;
  host: string;
};

export class InvalidGitHubAppConfiguration extends Error {
  constructor(readonly variables: string[]) {
    super("GitHub App configuration is incomplete or invalid");
    this.name = "InvalidGitHubAppConfiguration";
  }
}

/** Parses configuration without including credential values in any error. */
export function parseGitHubAppConfig(
  environment: Record<string, string | undefined>,
): GitHubAppConfig {
  const result = GitHubAppConfigSchema.safeParse(environment);
  if (!result.success) {
    const variables = [...new Set(result.error.issues
      .map((issue) => issue.path[0])
      .filter((name): name is string | number => typeof name === "string")
      .map(String))].sort();
    throw new InvalidGitHubAppConfiguration(variables);
  }

  return {
    appId: result.data.PAYPATH_GITHUB_APP_ID,
    privateKey: result.data.PAYPATH_GITHUB_PRIVATE_KEY,
    webhookSecret: result.data.PAYPATH_GITHUB_WEBHOOK_SECRET,
    port: result.data.PAYPATH_GITHUB_PORT,
    host: result.data.PAYPATH_GITHUB_HOST,
  };
}
