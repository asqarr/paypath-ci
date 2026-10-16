import { SupabaseDatabaseError } from "@paypath/supabase-adapter";

export type DemoAccessEndpoint = "/api/entitlement" | "/api/pro/feature";
export type DemoAccessFailureStage =
  | "service_initialization"
  | "authorization_read"
  | "subscription_read"
  | "evidence_read";

export interface DemoAccessFailureRecord {
  endpoint: DemoAccessEndpoint;
  httpStatus: 503;
  durationMs: number;
  stage: DemoAccessFailureStage;
  category: "supabase" | "network" | "timeout" | "internal";
  errorType: string;
  errorCode?: string;
  backendHttpStatus?: number;
}

type DiagnosticWriter = (record: Readonly<DemoAccessFailureRecord>) => void;

const SAFE_ERROR_TYPES = new Set([
  "AbortError",
  "Error",
  "FetchError",
  "PostgrestError",
  "SupabaseError",
  "TimeoutError",
  "TypeError",
  "UnknownError",
]);

const NETWORK_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function readProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) return undefined;
  return value[property as keyof typeof value];
}

function safeErrorName(error: unknown): string {
  const name = readProperty(error, "name");
  return typeof name === "string" && SAFE_ERROR_TYPES.has(name) ? name : "UnknownError";
}

function safeNetworkCode(error: unknown): string | undefined {
  const cause = readProperty(error, "cause");
  const code = readProperty(cause, "code");
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code) ? code : undefined;
}

function buildFailureRecord(
  endpoint: DemoAccessEndpoint,
  stage: DemoAccessFailureStage,
  durationMs: number,
  error: unknown,
): DemoAccessFailureRecord {
  const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  const record: DemoAccessFailureRecord = {
    endpoint,
    httpStatus: 503,
    durationMs: duration,
    stage,
    category: "internal",
    errorType: safeErrorName(error),
  };

  if (error instanceof SupabaseDatabaseError) {
    const diagnostic = error.diagnostic;
    const timedOut = diagnostic.errorType === "AbortError" || diagnostic.errorType === "TimeoutError" ||
      diagnostic.errorCode === "ETIMEDOUT" || diagnostic.errorCode?.includes("TIMEOUT") === true;
    const transportFailure = diagnostic.errorType === "FetchError" ||
      (diagnostic.errorType === "TypeError" &&
        diagnostic.message.startsWith("Node.js could not establish the Supabase HTTP request"));
    record.category = timedOut
      ? "timeout"
      : transportFailure
        ? "network"
        : "supabase";
    record.errorType = SAFE_ERROR_TYPES.has(diagnostic.errorType) ? diagnostic.errorType : "SupabaseError";
    if (diagnostic.errorCode !== undefined && /^[A-Z0-9_]{1,32}$/.test(diagnostic.errorCode)) {
      record.errorCode = diagnostic.errorCode;
    }
    if (isHttpStatus(diagnostic.httpStatus)) record.backendHttpStatus = diagnostic.httpStatus;
    return record;
  }

  const networkCode = safeNetworkCode(error);
  if (record.errorType === "AbortError" || record.errorType === "TimeoutError" || networkCode === "ETIMEDOUT" || networkCode?.includes("TIMEOUT")) {
    record.category = "timeout";
  } else if (networkCode !== undefined || record.errorType === "FetchError") {
    record.category = "network";
  }
  if (networkCode !== undefined) record.errorCode = networkCode;

  const status = readProperty(error, "status");
  if (isHttpStatus(status)) record.backendHttpStatus = status;
  return record;
}

export function logDemoAccessFailure(
  endpoint: DemoAccessEndpoint,
  stage: DemoAccessFailureStage,
  durationMs: number,
  error: unknown,
  write: DiagnosticWriter = (record) => console.error("PayPath demo API failure", JSON.stringify(record)),
): void {
  const record = buildFailureRecord(endpoint, stage, durationMs, error);
  try {
    write(record);
  } catch {
    // Diagnostics must not change the fail-closed API response.
  }
}
