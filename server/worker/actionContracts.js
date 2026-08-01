import { getWorkerOperation } from "./definitions.js";
import { workerError } from "./errors.js";

const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9._-]{1,240}$/;
const WORKER_FILE_ID_PATTERN = /^worker_file_[A-Za-z0-9._:-]{1,160}$/;
const BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_BODY_BYTES = 1024 * 1024;

function text(value, label, { required = true, maxBytes = 32_768 } = {}) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return null;
    throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}无效`, 400);
  }
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if ((required && !normalized.trim()) || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}无效`, 400);
  }
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw workerError("WORKER_ACTION_INPUT_TOO_LARGE", `${label}过长`, 400);
  }
  return normalized;
}

function compactText(value, label, options = {}) {
  const normalized = text(value, label, options);
  if (normalized === null) return null;
  if (/\r|\n/.test(normalized)) {
    throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}不能包含换行`, 400);
  }
  return normalized.trim();
}

function stringList(value, label, { required = false, max = 100 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}不能为空`, 400);
    return [];
  }
  if (!Array.isArray(value) || value.length > max) {
    throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}无效`, 400);
  }
  const normalized = value.map((item) => compactText(item, label, { maxBytes: 2_048 }));
  if (required && normalized.length === 0) {
    throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}不能为空`, 400);
  }
  return [...new Set(normalized)];
}

function emails(value, label, options = {}) {
  const normalized = stringList(value, label, { ...options, max: 100 });
  if (normalized.some((item) => !EMAIL_PATTERN.test(item))) {
    throw workerError("WORKER_EMAIL_ADDRESS_INVALID", `${label}包含无效邮箱地址`, 400);
  }
  return normalized;
}

function attachmentIds(value) {
  const attachments = stringList(value, "附件", { max: 3 });
  for (const attachment of attachments) {
    if (!WORKER_FILE_ID_PATTERN.test(attachment)) {
      throw workerError(
        "WORKER_ATTACHMENT_PATH_UNSAFE",
        "邮件附件必须使用该 Worker 任务已暂存的附件标识",
        400,
      );
    }
  }
  return attachments;
}

function messageId(value) {
  const normalized = compactText(value, "邮件标识", { maxBytes: 256 });
  if (!MESSAGE_ID_PATTERN.test(normalized)) {
    throw workerError("WORKER_MAIL_MESSAGE_ID_INVALID", "邮件标识无效", 400);
  }
  return normalized;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw workerError("WORKER_ACTION_INPUT_INVALID", `${label}无效`, 400);
  }
  return value;
}

function blockIds(value, label, { allowEnd = false, ...options } = {}) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const normalized = stringList(values, label, options);
  if (normalized.some((item) => !(allowEnd && item === "-1") && !BLOCK_ID_PATTERN.test(item))) {
    throw workerError("WORKER_LARK_BLOCK_ID_INVALID", `${label}包含无效块标识`, 400);
  }
  return normalized;
}

function requireDraft(draft, workerId) {
  if (!draft) {
    throw workerError("WORKER_DRAFT_REQUIRED", "该交付操作需要先保存草稿", 409);
  }
  if (Buffer.byteLength(draft.content, "utf8") > MAX_BODY_BYTES) {
    throw workerError("WORKER_DRAFT_TOO_LARGE", "草稿超过外部服务允许的大小", 400);
  }
  if (workerId === "agent_mail" && !["plain", "html"].includes(draft.format)) {
    throw workerError("WORKER_DRAFT_FORMAT_INVALID", "邮件草稿格式必须是 plain 或 html", 400);
  }
  if (workerId === "lark_doc" && !["xml", "markdown"].includes(draft.format)) {
    throw workerError("WORKER_DRAFT_FORMAT_INVALID", "飞书文档草稿格式必须是 xml 或 markdown", 400);
  }
  return draft;
}

function exactBefore(value, operation) {
  if (value === undefined || value === null) {
    throw workerError(
      "WORKER_EXACT_PREVIEW_REQUIRED",
      `${operation} 必须包含目标当前内容的精确预览`,
      400,
    );
  }
  return structuredClone(value);
}

function normalizeMailAction(operation, input, draft) {
  const parameters = input?.parameters ?? {};
  const common = {
    cc: emails(parameters.cc, "抄送地址"),
    bcc: emails(parameters.bcc, "密送地址"),
    attachments: attachmentIds(parameters.attachments),
  };
  if (operation === "trash") {
    const normalized = { messageId: messageId(parameters.messageId) };
    return {
      parameters: normalized,
      draft: null,
      baseRevisionId: null,
      preview: {
        operationLabel: "移入回收站（保留 30 天）",
        target: { messageId: normalized.messageId },
        before: exactBefore(input.before, operation),
        after: null,
        warnings: ["该操作不会永久删除邮件；邮件将在回收站保留 30 天。"],
      },
    };
  }

  const currentDraft = requireDraft(draft, "agent_mail");
  if (operation !== "forward" && !currentDraft.content.trim()) {
    throw workerError("WORKER_DRAFT_CONTENT_INVALID", "发送或回复邮件时正文不能为空", 400);
  }
  if (operation === "send") {
    const normalized = {
      ...common,
      to: emails(parameters.to, "收件地址", { required: true }),
      subject: compactText(parameters.subject, "邮件主题", { maxBytes: 4_096 }),
    };
    return {
      parameters: normalized,
      draft: currentDraft,
      baseRevisionId: null,
      preview: {
        operationLabel: "发送新邮件",
        target: { to: normalized.to, cc: normalized.cc, bcc: normalized.bcc },
        before: null,
        after: {
          subject: normalized.subject,
          body: currentDraft.content,
          bodyFormat: currentDraft.format,
          attachments: normalized.attachments,
        },
        warnings: ["确认后仅能证明邮件进入发送队列，不能证明收件人已经收到。"],
      },
    };
  }

  const normalized = {
    ...common,
    messageId: messageId(parameters.messageId),
  };
  const resolvedRecipients = parameters.resolvedRecipients
    && typeof parameters.resolvedRecipients === "object"
    ? {
        to: emails(parameters.resolvedRecipients.to, "解析后的收件地址"),
        cc: emails(parameters.resolvedRecipients.cc, "解析后的抄送地址"),
      }
    : null;
  if (
    ["reply", "reply_all"].includes(operation)
    && (!resolvedRecipients || resolvedRecipients.to.length === 0)
  ) {
    throw workerError(
      "WORKER_MAIL_RECIPIENTS_UNRESOLVED",
      "无法从绑定的原邮件与当前邮箱身份解析精确收件人",
      409,
    );
  }
  if (operation === "forward") {
    normalized.to = emails(parameters.to, "收件地址", { required: true });
    normalized.includeAttachments = parameters.includeAttachments === true;
    normalized.includedOriginalAttachments = normalized.includeAttachments
      && Array.isArray(parameters.includedOriginalAttachments)
      ? parameters.includedOriginalAttachments.slice(0, 3).map((item) => ({
          id: typeof item?.id === "string" ? item.id : null,
          name: typeof item?.name === "string" ? item.name : "附件",
          size: Number.isSafeInteger(item?.size) ? item.size : null,
        }))
      : [];
  } else {
    normalized.resolvedRecipients = resolvedRecipients;
  }
  return {
    parameters: normalized,
    draft: currentDraft,
    baseRevisionId: null,
    preview: {
      operationLabel: operation === "forward"
        ? "转发邮件"
        : operation === "reply_all"
          ? "回复全部"
          : "回复邮件",
      target: {
        messageId: normalized.messageId,
        ...(normalized.to ? { to: normalized.to } : {}),
        ...(normalized.resolvedRecipients
          ? { resolvedRecipients: normalized.resolvedRecipients }
          : {}),
        cc: normalized.cc,
        bcc: normalized.bcc,
      },
      before: exactBefore(input.before, operation),
      after: {
        body: currentDraft.content,
        bodyFormat: currentDraft.format,
        attachments: normalized.attachments,
        ...(operation === "forward"
          ? {
              includeOriginalAttachments: normalized.includeAttachments,
              includedOriginalAttachments: normalized.includedOriginalAttachments,
            }
          : {}),
      },
      warnings: ["确认后仅能证明邮件进入发送队列，不能证明收件人已经收到。"],
    },
  };
}

function normalizeLarkAction(operation, input, draft) {
  const parameters = input?.parameters ?? {};
  if (operation === "create") {
    const currentDraft = requireDraft(draft, "lark_doc");
    const parentToken = compactText(parameters.parentToken, "父级 token", {
      required: false,
      maxBytes: 512,
    });
    const parentPosition = compactText(parameters.parentPosition, "父级位置", {
      required: false,
      maxBytes: 512,
    });
    if (parentToken && parentPosition) {
      throw workerError(
        "WORKER_ACTION_INPUT_INVALID",
        "飞书父级 token 与父级位置不能同时设置",
        400,
      );
    }
    const normalized = {
      title: compactText(parameters.title, "文档标题", {
        required: false,
        maxBytes: 4_096,
      }),
      parentToken,
      parentPosition,
    };
    return {
      parameters: normalized,
      draft: currentDraft,
      baseRevisionId: null,
      preview: {
        operationLabel: "新建飞书文档",
        contentContract: "full_after",
        target: { parentToken, parentPosition },
        before: null,
        after: { format: currentDraft.format, content: currentDraft.content },
        fullBefore: null,
        fullAfter: { format: currentDraft.format, content: currentDraft.content },
        warnings: [],
      },
    };
  }

  const document = compactText(parameters.document, "飞书文档地址或 token", {
    maxBytes: 2_048,
  });
  if (document.startsWith("-")) {
    throw workerError("WORKER_LARK_DOCUMENT_INVALID", "飞书文档地址或 token 无效", 400);
  }
  const baseRevisionId = positiveInteger(parameters.baseRevisionId, "飞书基础版本");
  if (operation === "history_revert") {
    const historyVersionId = compactText(
      parameters.historyVersionId,
      "历史版本标识",
      { maxBytes: 256 },
    );
    const before = exactBefore(input.before, operation);
    const after = exactBefore(input.after, operation);
    const affectedBlockCount = positiveInteger(
      parameters.affectedBlockCount,
      "受影响块数",
    );
    return {
      parameters: { document, historyVersionId, affectedBlockCount },
      draft: null,
      baseRevisionId,
      preview: {
        operationLabel: "恢复飞书历史版本",
        contentContract: "full_before_and_after",
        target: { document, baseRevisionId, historyVersionId },
        before,
        after,
        fullBefore: before,
        fullAfter: after,
        impact: { affectedBlockCount },
        warnings: ["版本恢复会替换当前文档内容，确认前请核对完整差异。"],
      },
    };
  }

  if (operation === "block_delete") {
    const affectedBlockIds = blockIds(parameters.blockIds, "待删除块", {
      required: true,
      max: 100,
    });
    const affectedBlockCount = affectedBlockIds.length;
    return {
      parameters: { document, affectedBlockIds, affectedBlockCount },
      draft: null,
      baseRevisionId,
      preview: {
        operationLabel: "删除飞书文档块",
        contentContract: "full_before_with_exact_operation_diff",
        target: { document, baseRevisionId, affectedBlockIds },
        before: exactBefore(input.before, operation),
        after: null,
        fullBefore: exactBefore(input.before, operation),
        fullAfter: null,
        exactOperationDiff: {
          kind: "block_delete",
          blockIds: affectedBlockIds,
        },
        impact: { affectedBlockCount },
        warnings: [
          "删除后受影响的块 ID 会失效，后续操作必须重新读取文档。",
          "Pi Agent 不在本地猜测飞书删除后的完整 XML；确认内容为完整删除前正文与精确块 ID 差异。",
        ],
      },
    };
  }

  if (operation === "block_move_after") {
    const anchorBlockId = blockIds(parameters.anchorBlockId, "目标锚点", {
      required: true,
      max: 1,
      allowEnd: true,
    })[0];
    const sourceBlockIds = blockIds(parameters.sourceBlockIds, "待移动块", {
      required: true,
      max: 100,
    });
    return {
      parameters: { document, anchorBlockId, sourceBlockIds },
      draft: null,
      baseRevisionId,
      preview: {
        operationLabel: "移动飞书文档块",
        contentContract: "full_before_with_exact_operation_diff",
        target: { document, baseRevisionId, anchorBlockId, sourceBlockIds },
        before: exactBefore(input.before, operation),
        after: null,
        fullBefore: exactBefore(input.before, operation),
        fullAfter: null,
        exactOperationDiff: {
          kind: "block_move_after",
          anchorBlockId,
          sourceBlockIds,
        },
        warnings: ["移动后依赖块位置的后续操作必须重新读取文档。"],
      },
    };
  }

  const currentDraft = requireDraft(draft, "lark_doc");
  const normalized = { document };
  if (operation === "str_replace") {
    normalized.pattern = text(parameters.pattern, "待替换内容", {
      maxBytes: 128 * 1024,
    });
  }
  if (["block_insert_after", "block_replace"].includes(operation)) {
    normalized.blockId = blockIds(parameters.blockId, "目标块", {
      required: true,
      max: 1,
    })[0];
  }
  const needsBefore = ["overwrite", "str_replace", "block_replace"].includes(operation);
  const before = needsBefore ? exactBefore(input.before, operation) : input.before ?? null;
  if (operation === "overwrite") {
    normalized.affectedBlockCount = positiveInteger(
      parameters.affectedBlockCount,
      "受影响块数",
    );
  }
  const fullAfter = operation === "overwrite"
    ? { format: currentDraft.format, content: currentDraft.content }
    : null;
  const exactOperationDiff = operation === "append"
    ? { kind: "append", content: currentDraft.content, format: currentDraft.format }
    : operation === "str_replace"
      ? {
          kind: "str_replace",
          pattern: normalized.pattern,
          replacement: currentDraft.content,
          format: currentDraft.format,
        }
      : operation === "block_insert_after"
        ? {
            kind: "block_insert_after",
            blockId: normalized.blockId,
            content: currentDraft.content,
            format: currentDraft.format,
          }
        : operation === "block_replace"
          ? {
              kind: "block_replace",
              blockId: normalized.blockId,
              content: currentDraft.content,
              format: currentDraft.format,
            }
          : null;
  return {
    parameters: normalized,
    draft: currentDraft,
    baseRevisionId,
    preview: {
      operationLabel: {
        append: "追加飞书文档内容",
        overwrite: "覆盖飞书文档全文",
        str_replace: "精确替换飞书文档内容",
        block_insert_after: "插入飞书文档块",
        block_replace: "替换飞书文档块",
      }[operation],
      contentContract: operation === "overwrite"
        ? "full_before_and_after"
        : "full_before_with_exact_operation_diff",
      target: {
        document,
        baseRevisionId,
        ...(normalized.blockId ? { blockId: normalized.blockId } : {}),
        ...(normalized.pattern ? { pattern: normalized.pattern } : {}),
      },
      before,
      after: fullAfter,
      fullBefore: before,
      fullAfter,
      exactOperationDiff,
      ...(operation === "overwrite"
        ? { impact: { affectedBlockCount: normalized.affectedBlockCount } }
        : {}),
      warnings: ["写入后如需继续使用块 ID，必须按该操作的块生命周期重新读取文档。"],
    },
  };
}

export function normalizeWorkerAction({ definition, operation, input, draft }) {
  const capability = getWorkerOperation(definition, operation);
  if (!capability) {
    throw workerError(
      "WORKER_ACTION_NOT_ALLOWED",
      "该 Worker 不允许执行此操作",
      400,
    );
  }
  const normalized = definition.id === "agent_mail"
    ? normalizeMailAction(operation, input, draft)
    : normalizeLarkAction(operation, input, draft);
  return {
    operation,
    risk: capability.risk,
    parameters: normalized.parameters,
    baseRevisionId: normalized.baseRevisionId,
    draftRevisionId: normalized.draft?.id ?? null,
    draftSha256: normalized.draft?.sha256 ?? null,
    preview: normalized.preview,
  };
}

export const __test = Object.freeze({
  attachmentIds,
  messageId,
  blockIds,
});
