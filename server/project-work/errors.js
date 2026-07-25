export class ProjectWorkError extends Error {
  constructor(code, message, status = 409, retryable = false) {
    super(message);
    this.name = "ProjectWorkError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function projectWorkError(code, message, status = 409, retryable = false) {
  return new ProjectWorkError(code, message, status, retryable);
}

export function safeProjectWorkError(error) {
  const isKnown = error instanceof ProjectWorkError || error?.safe === true;
  return {
    code: isKnown && typeof error?.code === "string"
      ? error.code
      : "PROJECT_WORK_FAILED",
    message: isKnown && typeof error?.message === "string"
      ? error.message.slice(0, 300)
      : "项目工作操作失败",
    retryable: isKnown && error?.retryable === true,
  };
}
