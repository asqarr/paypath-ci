import type { SafeLogRecord } from "./model.js";

/** Contains only safe metadata; raw GitHub error text and response data are discarded. */
export class GitHubApiOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly errorType: string,
    readonly httpStatus?: number,
    readonly requestId?: string,
  ) {
    super("GitHub API operation failed");
    this.name = "GitHubApiOperationError";
  }
}

export function toSafeGitHubApiError(operation: string, error: unknown): GitHubApiOperationError {
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    response?: { headers?: Record<string, unknown> };
  };
  const errorType = typeof candidate?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate.name)
    ? candidate.name
    : "UnknownError";
  const status = typeof candidate?.status === "number" && Number.isInteger(candidate.status)
    ? candidate.status
    : undefined;
  const rawRequestId = candidate?.response?.headers?.["x-github-request-id"];
  const requestId = typeof rawRequestId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(rawRequestId)
    ? rawRequestId
    : undefined;

  return new GitHubApiOperationError(operation, errorType, status, requestId);
}

export function safeFailureLog(error: unknown): SafeLogRecord {
  if (error instanceof GitHubApiOperationError) {
    return {
      level: "error",
      event: "github_app_job_failed",
      operation: error.operation,
      errorType: error.errorType,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }

  return {
    level: "error",
    event: "github_app_job_failed",
    operation: "execute-check",
    errorType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : "UnknownError",
  };
}
