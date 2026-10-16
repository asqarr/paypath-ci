import { SupabaseDatabaseError } from "@paypath/supabase-adapter";

export interface WebhookFailureLogRecord {
  operation: string;
  errorType: string;
  errorCode?: string;
  httpStatus?: number;
}

type DiagnosticWriter = (record: Readonly<WebhookFailureLogRecord>) => void;

const SAFE_ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "FetchError",
  "PostgrestError",
  "SupabaseError",
  "UnknownError",
]);

function isSafeHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function toSafeFailureRecord(error: unknown): WebhookFailureLogRecord {
  if (error instanceof SupabaseDatabaseError) {
    const diagnostic = error.diagnostic;
    const record: WebhookFailureLogRecord = {
      operation: diagnostic.rpcName === "process_demo_stripe_event"
        ? "process_demo_stripe_event"
        : "stripe_webhook.process",
      errorType: SAFE_ERROR_TYPES.has(diagnostic.errorType) ? diagnostic.errorType : "SupabaseError",
    };

    if (diagnostic.errorCode !== undefined && /^[A-Z0-9_]{1,32}$/.test(diagnostic.errorCode)) {
      record.errorCode = diagnostic.errorCode;
    }
    if (isSafeHttpStatus(diagnostic.httpStatus)) record.httpStatus = diagnostic.httpStatus;
    return record;
  }

  return {
    operation: "stripe_webhook.process",
    errorType: "UnhandledError",
  };
}

export function logWebhookProcessingFailure(
  error: unknown,
  write: DiagnosticWriter = (record) => console.error(JSON.stringify(record)),
): void {
  const record = toSafeFailureRecord(error);
  try {
    write(record);
  } catch {
    // Logging must not replace the generic webhook response with another error.
  }
}
