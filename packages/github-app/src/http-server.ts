import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { GitHubWebhookService } from "./webhook.js";
import type { QueueWorker } from "./worker.js";

export const GITHUB_WEBHOOK_PATH = "/webhooks/github";
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

async function readBoundedBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
      tooLarge = true;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }

  return tooLarge ? undefined : Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, string>): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createGitHubWebhookServer(input: {
  service: GitHubWebhookService;
  worker: QueueWorker;
}): Server {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method !== "POST" || request.url !== GITHUB_WEBHOOK_PATH) {
        sendJson(response, 404, { status: "not_found" });
        return;
      }

      const body = await readBoundedBody(request);
      if (!body) {
        sendJson(response, 413, { status: "rejected", reason: "body_too_large" });
        return;
      }

      const result = await input.service.receive(body, request.headers);
      sendJson(response, result.statusCode, {
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
      });

      if (result.wakeWorker) {
        // Respond before external GitHub API calls; webhook handling stays fast.
        setImmediate(() => { void input.worker.drain(); });
      }
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { status: "error", reason: "internal_error" });
      } else {
        response.destroy();
      }
    });
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
