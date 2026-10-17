import { parseGitHubAppConfig, InvalidGitHubAppConfiguration } from "./config.js";
import { BillingSafetyCheckExecutor } from "./check-executor.js";
import { createGitHubWebhookServer } from "./http-server.js";
import { OctokitGitHubApiFactory } from "./octokit-adapter.js";
import { InMemoryJobQueue } from "./queue.js";
import type { SafeLogRecord } from "./model.js";
import { GitHubWebhookService } from "./webhook.js";
import { QueueWorker } from "./worker.js";

const logger = {
  write(record: SafeLogRecord): void {
    const fields = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
    const stream = record.level === "error" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(fields)}\n`);
  },
};

function start(): void {
  let config;
  try {
    config = parseGitHubAppConfig(process.env);
  } catch (error) {
    const variables = error instanceof InvalidGitHubAppConfiguration
      ? error.variables
      : ["PAYPATH_GITHUB_APP_ID", "PAYPATH_GITHUB_PRIVATE_KEY", "PAYPATH_GITHUB_WEBHOOK_SECRET"];
    logger.write({
      level: "error",
      event: "invalid_github_app_configuration",
      errorType: "ConfigurationError",
    });
    process.stderr.write(`Required configuration is incomplete or invalid: ${variables.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  const queue = new InMemoryJobQueue();
  const executor = new BillingSafetyCheckExecutor(new OctokitGitHubApiFactory(config));
  const worker = new QueueWorker(queue, executor, logger);
  const service = new GitHubWebhookService(config.webhookSecret, queue);
  const server = createGitHubWebhookServer({ service, worker });

  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.write({
      level: "error",
      event: "github_app_server_failed",
      operation: "listen",
      errorType: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "ServerError",
      ...(error.code && /^[A-Z0-9_]{1,32}$/.test(error.code) ? { errorCode: error.code } : {}),
    });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    logger.write({ level: "info", event: "github_app_server_started", operation: "listen" });
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start();
