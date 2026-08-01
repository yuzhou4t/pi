export class WorkerServiceError extends Error {
  constructor(
    code,
    message,
    status = 409,
    { retryable = false, unknownOutcome = false, details = null } = {},
  ) {
    super(message);
    this.name = "WorkerServiceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.unknownOutcome = unknownOutcome;
    this.details = details;
  }
}

export function workerError(code, message, status = 409, options = {}) {
  return new WorkerServiceError(code, message, status, options);
}

const REDACTED_WORKER_SECRET = "[已脱敏]";
const WORKER_ERROR_MESSAGE_LIMIT = 500;

export function safeWorkerErrorMessage(value, fallback = "Worker 操作失败") {
  const source = typeof value === "string" ? value : fallback;
  return source
    .replace(/ctk_[A-Za-z0-9._-]+/gu, REDACTED_WORKER_SECRET)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, `$1${REDACTED_WORKER_SECRET}`)
    .replace(
      /((?:["']?[A-Za-z0-9_.-]*(?:api[_ -]*key|client[_ -]*secret|access[_ -]*token|refresh[_ -]*token|confirmation[_ -]*token|authorization|password|secret)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/giu,
      `$1${REDACTED_WORKER_SECRET}`,
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, REDACTED_WORKER_SECRET)
    .slice(0, WORKER_ERROR_MESSAGE_LIMIT);
}

export function safeWorkerFailure(error, fallbackCode = "WORKER_ACTION_FAILED") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: safeWorkerErrorMessage(error?.message),
    retryable: error?.retryable === true,
    unknownOutcome: error?.unknownOutcome === true,
  };
}
