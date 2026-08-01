import assert from "node:assert/strict";
import test from "node:test";
import {
  safeWorkerErrorMessage,
  safeWorkerFailure,
  WorkerServiceError,
} from "./errors.js";

test("Worker error messages preserve diagnostics while redacting common credentials", () => {
  const message = [
    "Agent 邮箱确认失败",
    "ctk_confirmation.value-1",
    "Authorization: Bearer bearer.value-2",
    "PI_AGENT_API_KEY=api-value-3",
    'client_secret="secret value 4"',
    "sk-1234567890abcdef",
  ].join("; ");
  const sanitized = safeWorkerErrorMessage(message);
  assert.match(sanitized, /Agent 邮箱确认失败/u);
  assert.doesNotMatch(
    sanitized,
    /ctk_confirmation|bearer\.value|api-value|secret value|sk-1234567890abcdef/u,
  );
  assert.match(sanitized, /已脱敏/u);

  const failure = safeWorkerFailure(new WorkerServiceError(
    "WORKER_MAIL_CLI_FAILED",
    message,
    502,
    { retryable: true },
  ));
  assert.equal(failure.code, "WORKER_MAIL_CLI_FAILED");
  assert.equal(failure.retryable, true);
  assert.equal(failure.message, sanitized);
});
