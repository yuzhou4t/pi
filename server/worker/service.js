import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { normalizeWorkerAction } from "./actionContracts.js";
import {
  createDisabledConnectionAdapter,
  createDisabledDeliveryExecutor,
} from "./cliAdapters.js";
import { getBuiltinWorkerDefinitions } from "./definitions.js";
import {
  safeWorkerFailure,
  workerError,
  WorkerServiceError,
} from "./errors.js";
import { sha256 } from "./hash.js";
import { createWorkerStore } from "./store.js";
import {
  buildWorkerReferenceContext,
  MAX_WORKER_SOURCES_PER_TASK,
  normalizeWorkerSource,
  publicWorkerSource,
  safeWorkerReadResult,
} from "./sources.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ACTIVE_PROPOSAL_STATUSES = new Set([
  "preparing",
  "pending_confirmation",
  "retryable_failed",
]);
const DELIVERY_BLOCKING_PROPOSAL_STATUSES = new Set([
  ...ACTIVE_PROPOSAL_STATUSES,
  "executing",
  "unknown_outcome",
]);
const FILE_HOLDING_PROPOSAL_STATUSES = new Set([
  ...ACTIVE_PROPOSAL_STATUSES,
  "executing",
]);
const ABANDONABLE_PROPOSAL_STATUSES = new Set([
  "pending_confirmation",
  "retryable_failed",
]);
const MAX_WORKER_FILE_BYTES = 25 * 1024 * 1024;
const MAX_WORKER_FILES_PER_TASK = 3;

function isPendingProviderWrite(proposal) {
  return proposal?.status === "queued"
    && proposal.workerId === "lark_doc"
    && proposal.operation === "history_revert";
}

function blocksNewDelivery(proposal) {
  return DELIVERY_BLOCKING_PROPOSAL_STATUSES.has(proposal?.status)
    || isPendingProviderWrite(proposal);
}

function isoNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must return a valid date");
  return date.toISOString();
}

function compactText(value, label, { required = true, max = 240 } = {}) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return null;
    throw workerError("WORKER_INPUT_INVALID", `${label}无效`, 400);
  }
  const normalized = value.normalize("NFKC").trim().replaceAll(/\s+/g, " ");
  if ((required && !normalized) || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw workerError("WORKER_INPUT_INVALID", `${label}无效`, 400);
  }
  return normalized || null;
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw workerError("WORKER_ID_INVALID", `${label}无效`, 400);
  }
  return value;
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireRecord(record, id, code, message) {
  if (!hasOwn(record, id)) throw workerError(code, message, 404);
  return record[id];
}

function makeId(prefix, idFactory) {
  const raw = String(idFactory());
  const compact = raw.replaceAll(/[^A-Za-z0-9._:-]/g, "").slice(0, 120);
  if (!compact) throw new TypeError("idFactory must return a usable identifier");
  return `${prefix}_${compact}`;
}

function publicProposal(proposal) {
  const {
    privateExecutionState: _privateExecutionState,
    privateAttachmentPaths: _privateAttachmentPaths,
    ...safe
  } = proposal;
  return structuredClone(safe);
}

function publicFile(file) {
  const { relativePath: _relativePath, ...safe } = file;
  return structuredClone(safe);
}

function publicState(state) {
  return {
    schemaVersion: state.schemaVersion,
    definitions: Object.values(state.definitions).map((value) => structuredClone(value)),
    tasks: Object.values(state.tasks).map((value) => structuredClone(value)),
    drafts: Object.values(state.drafts).map((value) => structuredClone(value)),
    sources: Object.values(state.sources).map(publicWorkerSource),
    files: Object.values(state.files).map(publicFile),
    proposals: Object.values(state.proposals).map(publicProposal),
    receipts: Object.values(state.receipts).map((value) => structuredClone(value)),
  };
}

function proposalHashCore(proposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    id: proposal.id,
    taskId: proposal.taskId,
    workerId: proposal.workerId,
    operation: proposal.operation,
    risk: proposal.risk,
    parameters: proposal.parameters,
    baseRevisionId: proposal.baseRevisionId,
    draftRevisionId: proposal.draftRevisionId,
    draftSha256: proposal.draftSha256,
    connectionBinding: proposal.connectionBinding ?? null,
    sourceBindings: proposal.sourceBindings ?? null,
    attachmentBindings: proposal.attachmentBindings ?? [],
    preview: proposal.preview,
  };
}

function exactSource(state, task, sourceId, label, operation) {
  const id = assertId(sourceId, label);
  const source = requireRecord(
    state.sources,
    id,
    "WORKER_SOURCE_NOT_FOUND",
    `${label}不存在或已经过期`,
  );
  if (
    source.taskId !== task.id
    || source.workerId !== task.workerId
    || source.operation !== operation
    || source.truncated === true
    || source.binding?.exact !== true
    || source.privateExactSnapshot === null
    || source.privateExactSnapshot === undefined
  ) {
    throw workerError(
      "WORKER_SOURCE_BINDING_INVALID",
      `${label}不是该任务可用于精确预览的完整读取结果`,
      409,
    );
  }
  return source;
}

function sourceReference(source) {
  return {
    id: source.id,
    operation: source.operation,
    contentSha256: source.contentSha256,
    exactContentSha256: source.binding?.contentSha256 ?? null,
    revisionId: source.binding?.revisionId ?? null,
    createdAt: source.createdAt,
  };
}

function assertSourceBindingsCurrent(state, proposal) {
  for (const binding of Object.values(proposal.sourceBindings ?? {})) {
    if (!binding) continue;
    const source = state.sources[binding.id];
    if (
      !source
      || source.taskId !== proposal.taskId
      || source.workerId !== proposal.workerId
      || source.contentSha256 !== binding.contentSha256
      || (source.binding?.contentSha256 ?? null) !== binding.exactContentSha256
      || (source.binding?.revisionId ?? null) !== binding.revisionId
    ) {
      throw workerError(
        "WORKER_SOURCE_BINDING_STALE",
        "交付提案绑定的外部读取来源已变化或不可用，请重新生成预览",
        409,
      );
    }
  }
}

function workerFileName(value) {
  if (typeof value !== "string") {
    throw workerError("WORKER_FILE_NAME_INVALID", "附件名称无效", 400);
  }
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized
    || normalized.length > 180
    || normalized === "."
    || normalized === ".."
    || /[\/\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw workerError("WORKER_FILE_NAME_INVALID", "附件名称无效", 400);
  }
  return normalized;
}

function workerFileMime(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(value)) {
    throw workerError("WORKER_FILE_TYPE_INVALID", "附件类型无效", 400);
  }
  return value.toLowerCase();
}

function workerFileLength(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WORKER_FILE_BYTES) {
    throw workerError(
      "WORKER_FILE_SIZE_INVALID",
      "单个附件必须大于 0 且不超过 25 MiB",
      400,
    );
  }
  return value;
}

function controlledWorkerPath(filesRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const candidate = path.resolve(filesRoot, relativePath);
  const relative = path.relative(filesRoot, candidate);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) return null;
  return candidate;
}

async function verifiedWorkerFile(filesRoot, file) {
  if (!file || file.status !== "ready" || typeof file.relativePath !== "string") {
    throw workerError("WORKER_FILE_NOT_READY", "附件尚未完整上传", 409);
  }
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(filesRoot);
  const candidate = path.resolve(filesRoot, file.relativePath);
  const linkState = await lstat(candidate).catch(() => null);
  if (!linkState || linkState.isSymbolicLink()) {
    throw workerError("WORKER_FILE_CHANGED", "附件文件已变化，请重新上传", 409);
  }
  const resolved = await realpath(candidate).catch(() => null);
  const relative = resolved ? path.relative(root, resolved) : "..";
  if (!resolved || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw workerError("WORKER_ATTACHMENT_PATH_UNSAFE", "附件不在 Worker 受控目录内", 409);
  }
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size !== file.byteLength) {
    throw workerError("WORKER_FILE_CHANGED", "附件大小已变化，请重新上传", 409);
  }
  const bytes = await readFile(resolved);
  const contentSha256 = sha256(bytes);
  if (contentSha256 !== file.sha256) {
    throw workerError("WORKER_FILE_CHANGED", "附件内容已变化，请重新上传", 409);
  }
  return {
    id: file.id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    byteLength: file.byteLength,
    sha256: file.sha256,
    relativePath: relative.split(path.sep).join("/"),
  };
}

async function importDownloadedWorkerFile(filesRoot, file, result) {
  const savedTo = result?.data?.saved_to ?? result?.data?.savedTo;
  if (typeof savedTo !== "string" || !savedTo.trim()) {
    throw workerError(
      "WORKER_ATTACHMENT_DOWNLOAD_INVALID",
      "Agent 邮箱未返回可登记的附件文件",
      502,
    );
  }
  await mkdir(filesRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(filesRoot);
  const outputDirectory = path.resolve(filesRoot, file.relativePath);
  const outputState = await lstat(outputDirectory).catch(() => null);
  if (!outputState || outputState.isSymbolicLink() || !outputState.isDirectory()) {
    throw workerError("WORKER_ATTACHMENT_PATH_UNSAFE", "附件下载目录无效", 409);
  }
  const outputRoot = await realpath(outputDirectory);
  const outputRelative = path.relative(root, outputRoot);
  if (
    outputRelative === ".."
    || outputRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(outputRelative)
  ) {
    throw workerError("WORKER_ATTACHMENT_PATH_UNSAFE", "附件下载目录不在受控范围内", 409);
  }
  const candidate = path.isAbsolute(savedTo)
    ? path.resolve(savedTo)
    : path.resolve(filesRoot, savedTo);
  const candidateState = await lstat(candidate).catch(() => null);
  if (!candidateState || candidateState.isSymbolicLink()) {
    throw workerError("WORKER_FILE_CHANGED", "下载的附件文件无效", 409);
  }
  const resolved = await realpath(candidate).catch(() => null);
  const relativeToOutput = resolved ? path.relative(outputRoot, resolved) : "..";
  if (
    !resolved
    || !relativeToOutput
    || relativeToOutput === ".."
    || relativeToOutput.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToOutput)
    || path.dirname(resolved) !== outputRoot
  ) {
    throw workerError("WORKER_ATTACHMENT_PATH_UNSAFE", "下载的附件不在受控目录内", 409);
  }
  const entries = await readdir(outputRoot, { withFileTypes: true });
  if (
    entries.length !== 1
    || entries[0].name !== path.basename(resolved)
    || entries[0].isSymbolicLink()
    || !entries[0].isFile()
  ) {
    throw workerError(
      "WORKER_ATTACHMENT_DOWNLOAD_INVALID",
      "附件下载结果包含无法安全登记的文件",
      409,
    );
  }
  const stat = await lstat(resolved);
  const byteLength = workerFileLength(stat.size);
  const bytes = await readFile(resolved);
  if (bytes.byteLength !== byteLength) {
    throw workerError("WORKER_FILE_CHANGED", "下载的附件在校验期间发生变化", 409);
  }
  let mimeType = "application/octet-stream";
  const reportedMime = result?.data?.content_type ?? result?.data?.mime_type;
  if (typeof reportedMime === "string") {
    try {
      mimeType = workerFileMime(reportedMime);
    } catch {
      // Untrusted metadata cannot prevent registering an otherwise valid file.
    }
  }
  return {
    fileName: workerFileName(path.basename(resolved)),
    mimeType,
    byteLength,
    sha256: sha256(bytes),
    relativePath: path.relative(root, resolved).split(path.sep).join("/"),
  };
}

function mailPartyAddresses(value) {
  const addresses = [];
  const seen = new Set();
  function visit(item) {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    let candidate = null;
    if (typeof item === "string") {
      const angle = item.match(/<([^<>\s@]+@[^<>\s@]+)>/u);
      candidate = angle?.[1] ?? item.trim();
    } else if (item && typeof item === "object") {
      candidate = item.email ?? item.address ?? null;
    }
    if (
      typeof candidate === "string"
      && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(candidate)
    ) {
      const normalized = candidate.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        addresses.push(normalized);
      }
    }
  }
  visit(value);
  return addresses;
}

function resolvedReplyRecipients(snapshot, operation, connectionBinding) {
  if (!["reply", "reply_all"].includes(operation)) return null;
  const ownAddresses = new Set([
    connectionBinding?.identity,
    ...(connectionBinding?.aliases ?? []),
  ].filter((value) => typeof value === "string").map((value) => value.toLowerCase()));
  const to = mailPartyAddresses(snapshot?.from)
    .filter((address) => !ownAddresses.has(address));
  if (operation === "reply") return { to, cc: [] };
  for (const address of mailPartyAddresses(snapshot?.to)) {
    if (!ownAddresses.has(address) && !to.includes(address)) to.push(address);
  }
  const cc = mailPartyAddresses(snapshot?.cc)
    .filter((address) => !ownAddresses.has(address) && !to.includes(address));
  return { to, cc };
}

function originalAttachmentPreview(snapshot) {
  return (Array.isArray(snapshot?.attachments) ? snapshot.attachments : [])
    .map((item) => ({
      id: typeof (item?.attachment_id ?? item?.id) === "string"
        ? (item.attachment_id ?? item.id).slice(0, 280)
        : null,
      name: typeof (item?.file_name ?? item?.name) === "string"
        ? (item.file_name ?? item.name).slice(0, 512)
        : "附件",
      size: Number.isSafeInteger(item?.size) && item.size >= 0 ? item.size : null,
    }))
    .slice(0, 100);
}

function bindActionSources(state, task, operation, input, connectionBinding = null) {
  const parameters = input?.parameters && typeof input.parameters === "object"
    && !Array.isArray(input.parameters)
    ? structuredClone(input.parameters)
    : {};
  if (task.workerId === "agent_mail") {
    if (operation === "send") {
      return { parameters, before: null, after: null, sourceBindings: null };
    }
    const before = exactSource(
      state,
      task,
      input.beforeSourceId,
      "当前邮件读取来源",
      "read",
    );
    if (
      typeof parameters.messageId !== "string"
      || before.binding?.messageId !== parameters.messageId
    ) {
      throw workerError(
        "WORKER_SOURCE_TARGET_MISMATCH",
        "邮件读取来源与交付目标不一致",
        409,
      );
    }
    parameters.resolvedRecipients = resolvedReplyRecipients(
      before.privateExactSnapshot,
      operation,
      connectionBinding,
    );
    if (operation === "forward" && parameters.includeAttachments === true) {
      const originalAttachments = originalAttachmentPreview(before.privateExactSnapshot);
      const addedAttachmentCount = Array.isArray(parameters.attachments)
        ? parameters.attachments.length
        : 0;
      if (originalAttachments.length + addedAttachmentCount > MAX_WORKER_FILES_PER_TASK) {
        throw workerError(
          "WORKER_MAIL_ATTACHMENT_LIMIT",
          "转发携带的原附件与新增附件合计不能超过 3 个",
          409,
        );
      }
      parameters.includedOriginalAttachments = originalAttachments;
    }
    return {
      parameters,
      before: structuredClone(before.privateExactSnapshot),
      after: null,
      sourceBindings: { before: sourceReference(before) },
    };
  }

  if (operation === "create") {
    return { parameters, before: null, after: null, sourceBindings: null };
  }
  const before = exactSource(
    state,
    task,
    input.beforeSourceId,
    "当前飞书文档来源",
    "fetch",
  );
  const document = before.binding?.requestedDocument;
  const baseRevisionId = before.binding?.revisionId;
  if (
    typeof parameters.document !== "string"
    || parameters.document !== document
    || !Number.isSafeInteger(baseRevisionId)
    || baseRevisionId <= 0
    || before.binding?.requestedRevisionId !== null
  ) {
    throw workerError(
      "WORKER_SOURCE_TARGET_MISMATCH",
      "当前文档读取来源、目标或基础版本不一致",
      409,
    );
  }
  if (
    parameters.baseRevisionId !== undefined
    && parameters.baseRevisionId !== null
    && Number(parameters.baseRevisionId) !== baseRevisionId
  ) {
    throw workerError(
      "WORKER_LARK_BASE_REVISION_STALE",
      "浏览器提交的基础版本与持久读取来源不一致",
      409,
    );
  }
  parameters.baseRevisionId = baseRevisionId;

  const blockOperations = new Set([
    "block_insert_after",
    "block_replace",
    "block_delete",
    "block_move_after",
  ]);
  const needsFullBlockInventory = blockOperations.has(operation)
    || ["overwrite", "history_revert"].includes(operation);
  if (
    needsFullBlockInventory
    && before.binding?.detail !== "full"
  ) {
    throw workerError(
      "WORKER_LARK_FULL_SOURCE_REQUIRED",
      "该操作必须绑定 detail=full 的完整飞书文档读取来源",
      409,
    );
  }
  const knownBlockIds = new Set(before.binding?.blockIds ?? []);
  if (before.binding?.blockIdsTruncated === true) {
    throw workerError(
      "WORKER_LARK_BLOCK_INVENTORY_INCOMPLETE",
      "文档块清单过大，当前读取结果不能安全用于写入",
      409,
    );
  }
  const referencedBlockIds = [
    parameters.blockId,
    parameters.anchorBlockId,
    ...(Array.isArray(parameters.blockIds) ? parameters.blockIds : []),
    ...(Array.isArray(parameters.sourceBlockIds) ? parameters.sourceBlockIds : []),
  ].filter((value) => typeof value === "string" && value !== "-1");
  if (referencedBlockIds.some((id) => !knownBlockIds.has(id))) {
    throw workerError(
      "WORKER_LARK_BLOCK_ID_STALE",
      "交付提案包含当前完整读取来源中不存在的块 ID",
      409,
    );
  }
  if (
    operation === "str_replace"
    && typeof parameters.pattern === "string"
    && !String(before.exactPreview).includes(parameters.pattern)
  ) {
    throw workerError(
      "WORKER_LARK_PATTERN_STALE",
      "待替换内容不在当前完整读取来源中",
      409,
    );
  }

  const sourceBindings = { before: sourceReference(before) };
  let after = null;
  if (operation === "overwrite") {
    const affectedBlockCount = knownBlockIds.size;
    if (affectedBlockCount <= 0) {
      throw workerError(
        "WORKER_LARK_BLOCK_INVENTORY_INCOMPLETE",
        "无法从完整读取来源派生覆盖操作的影响块数",
        409,
      );
    }
    parameters.affectedBlockCount = affectedBlockCount;
  }
  if (operation === "history_revert") {
    const afterSource = exactSource(
      state,
      task,
      input.afterSourceId,
      "目标历史版本来源",
      "fetch",
    );
    if (
      afterSource.binding?.requestedDocument !== document
      || afterSource.binding?.detail !== "full"
      || !Number.isSafeInteger(afterSource.binding?.requestedRevisionId)
      || afterSource.binding.requestedRevisionId !== afterSource.binding.revisionId
    ) {
      throw workerError(
        "WORKER_HISTORY_SOURCE_MISMATCH",
        "目标历史版本来源必须是同一文档指定 revisionId 的完整读取结果",
        409,
      );
    }
    const historySourceId = assertId(input.historySourceId, "飞书历史列表来源");
    const historySource = requireRecord(
      state.sources,
      historySourceId,
      "WORKER_SOURCE_NOT_FOUND",
      "飞书历史列表来源不存在或已经过期",
    );
    const historyVersionId = typeof parameters.historyVersionId === "string"
      ? parameters.historyVersionId
      : "";
    const historyEntry = historySource.taskId === task.id
      && historySource.workerId === task.workerId
      && historySource.operation === "history_list"
      && historySource.binding?.requestedDocument === document
      ? (historySource.binding?.historyVersions ?? []).find(
          (entry) => entry.historyVersionId === historyVersionId,
        )
      : null;
    if (
      !historyEntry
      || historyEntry.revisionId !== afterSource.binding.revisionId
    ) {
      throw workerError(
        "WORKER_HISTORY_SOURCE_MISMATCH",
        "历史版本标识未在绑定的历史列表中对应到目标 revisionId",
        409,
      );
    }
    const affectedBlockIds = new Set([
      ...knownBlockIds,
      ...(afterSource.binding?.blockIds ?? []),
    ]);
    if (affectedBlockIds.size <= 0) {
      throw workerError(
        "WORKER_LARK_BLOCK_INVENTORY_INCOMPLETE",
        "无法从两个完整版本派生版本恢复的影响块数",
        409,
      );
    }
    parameters.affectedBlockCount = affectedBlockIds.size;
    after = structuredClone(afterSource.privateExactSnapshot);
    sourceBindings.after = sourceReference(afterSource);
    sourceBindings.history = sourceReference(historySource);
  }
  return {
    parameters,
    before: structuredClone(before.privateExactSnapshot),
    after,
    sourceBindings,
  };
}

function assertBindings(proposal, bindings) {
  if (
    !bindings
    || bindings.proposalHash !== proposal.proposalHash
    || (bindings.draftSha256 ?? null) !== proposal.draftSha256
    || (bindings.baseRevisionId ?? null) !== proposal.baseRevisionId
  ) {
    throw workerError(
      "WORKER_ACTION_BINDING_MISMATCH",
      "交付提案已经变化，请重新检查精确预览",
      409,
    );
  }
}

function normalizeExecutionResult(result, proposal) {
  const deliveryStatus = result?.deliveryStatus === "queued" ? "queued" : "completed";
  const provider = compactText(result?.provider ?? proposal.workerId, "外部服务", {
    max: 80,
  });
  const externalId = compactText(result?.externalId, "外部回执标识", {
    required: false,
    max: 500,
  });
  let externalUrl = null;
  if (result?.externalUrl) {
    try {
      const parsed = new URL(result.externalUrl);
      if (["http:", "https:"].includes(parsed.protocol)) externalUrl = parsed.toString();
    } catch {
      // An invalid URL is omitted from the receipt rather than exposed.
    }
  }
  return {
    deliveryStatus,
    provider,
    externalId,
    externalUrl,
    providerState: compactText(result?.providerState ?? deliveryStatus, "外部状态", {
      max: 120,
    }),
    verification: result?.verification && typeof result.verification === "object"
      ? structuredClone(result.verification)
      : { status: "not_reported" },
  };
}

function retryableFailure(error) {
  if (error instanceof WorkerServiceError) return error;
  return workerError(
    "WORKER_EXECUTOR_FAILED",
    typeof error?.message === "string" ? error.message : "外部执行器失败",
    502,
    {
      retryable: error?.retryable === true,
      unknownOutcome: error?.unknownOutcome === true,
    },
  );
}

export function createWorkerService({
  storageRoot,
  store = null,
  executor = createDisabledDeliveryExecutor(),
  connections = createDisabledConnectionAdapter(),
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  const workerStore = store ?? createWorkerStore({ storageRoot });
  const filesRoot = path.resolve(storageRoot, "worker", "files");
  const executionSecrets = new Map();
  const queuedResumeClaims = new Set();
  const readyPromise = workerStore.initialize(getBuiltinWorkerDefinitions())
    .then(() => workerStore.transaction((state) => {
      const recoveredAt = isoNow(now);
      const cleanupTargets = [];
      for (const proposal of Object.values(state.proposals)) {
        const hadPrivateState = proposal.privateExecutionState
          && typeof proposal.privateExecutionState === "object";
        proposal.privateExecutionState = null;
        if (proposal.status === "executing") {
          proposal.status = "unknown_outcome";
          proposal.lastError = {
            code: "WORKER_ACTION_INTERRUPTED_UNKNOWN",
            message: "Pi Agent 在外部写入期间重启，必须人工检查结果",
            retryable: false,
            unknownOutcome: true,
          };
          if (!proposal.receiptId) {
            const receipt = {
              schemaVersion: 1,
              id: makeId("receipt", idFactory),
              taskId: proposal.taskId,
              proposalId: proposal.id,
              workerId: proposal.workerId,
              provider: proposal.workerId,
              status: "unknown",
              externalId: null,
              externalUrl: null,
              providerState: "manual_check_required",
              proposalHash: proposal.proposalHash,
              draftSha256: proposal.draftSha256,
              verification: {
                status: "manual_check_required",
                error: proposal.lastError,
              },
              createdAt: recoveredAt,
            };
            state.receipts[receipt.id] = receipt;
            proposal.receiptId = receipt.id;
          }
          proposal.updatedAt = recoveredAt;
        } else if (
          proposal.workerId === "agent_mail"
          && (hadPrivateState || proposal.status === "pending_confirmation")
        ) {
          proposal.status = "retryable_failed";
          proposal.lastError = {
            code: "WORKER_MAIL_CONFIRMATION_EXPIRED",
            message: "邮箱确认令牌未持久化，请重新生成交付预览",
            retryable: true,
            unknownOutcome: false,
          };
          proposal.updatedAt = recoveredAt;
        }
      }
      for (const file of Object.values(state.files)) {
        if (file.status === "downloading") {
          const target = controlledWorkerPath(filesRoot, file.relativePath);
          if (target) cleanupTargets.push(target);
          delete state.files[file.id];
        } else if (file.status === "uploading") {
          const target = controlledWorkerPath(filesRoot, file.relativePath);
          if (target) cleanupTargets.push(path.dirname(target));
          file.status = "awaiting_content";
          file.sha256 = null;
          file.uploadedAt = null;
        }
      }
      return cleanupTargets;
    }))
    .then(async (cleanupTargets) => {
      await Promise.all(cleanupTargets.map(
        (target) => rm(target, { recursive: true, force: true }).catch(() => undefined),
      ));
    });

  async function ready() {
    await readyPromise;
    return service;
  }

  async function resolveConnectionBinding(definition) {
    const health = await connections.health({
      workerId: definition.id,
      definition,
    });
    const identity = compactText(health?.identity, "连接身份", {
      required: false,
      max: 320,
    });
    if (health?.status !== "connected" || health?.verified !== true || !identity) {
      throw workerError(
        "WORKER_CONNECTION_NOT_READY",
        "外部连接身份未通过验证，不能生成交付提案",
        409,
        { retryable: true },
      );
    }
    const aliases = definition.id === "agent_mail"
      ? [...new Set([identity, ...(Array.isArray(health.aliases) ? health.aliases : [])]
        .filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase()))].sort()
      : [];
    return {
      connectorId: definition.connectorId,
      identity,
      aliases,
    };
  }

  async function assertConnectionBindingCurrent(proposal) {
    const state = await workerStore.read();
    const definition = requireRecord(
      state.definitions,
      proposal.workerId,
      "WORKER_DEFINITION_NOT_FOUND",
      "Worker 不存在",
    );
    const current = await resolveConnectionBinding(definition);
    if (JSON.stringify(current) !== JSON.stringify(proposal.connectionBinding ?? null)) {
      throw workerError(
        "WORKER_CONNECTION_BINDING_STALE",
        "外部连接身份已经变化，请重新生成交付预览",
        409,
        { retryable: true },
      );
    }
  }

  async function listDefinitions() {
    await readyPromise;
    const state = await workerStore.read();
    return Object.values(state.definitions)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
      .map((value) => structuredClone(value));
  }

  async function getDefinition(workerId) {
    await readyPromise;
    const id = assertId(workerId, "Worker 标识");
    const state = await workerStore.read();
    return structuredClone(requireRecord(
      state.definitions,
      id,
      "WORKER_DEFINITION_NOT_FOUND",
      "Worker 不存在",
    ));
  }

  async function createTask(input = {}) {
    await readyPromise;
    const workerId = assertId(input.workerId, "Worker 标识");
    const title = compactText(input.title, "任务标题", { max: 160 });
    const conversationId = assertId(input.conversationId, "Pi 会话标识");
    const sourceProjectId = compactText(input.sourceProjectId, "项目背景标识", {
      required: false,
      max: 200,
    });
    return workerStore.transaction((state) => {
      requireRecord(
        state.definitions,
        workerId,
        "WORKER_DEFINITION_NOT_FOUND",
        "Worker 不存在",
      );
      if (Object.values(state.tasks).some(
        (task) => task.conversationId === conversationId,
      )) {
        throw workerError(
          "WORKER_CONVERSATION_ALREADY_BOUND",
          "该 Pi 会话已经绑定到另一个 Worker 任务",
          409,
        );
      }
      const at = isoNow(now);
      const task = {
        schemaVersion: 1,
        id: makeId("worker_task", idFactory),
        workType: "worker",
        workspaceKind: "scratch",
        projectId: null,
        workerId,
        conversationId,
        title,
        sourceProjectId,
        sourceProjectAccess: sourceProjectId ? "read_only" : null,
        status: "active",
        currentDraftRevisionId: null,
        createdAt: at,
        updatedAt: at,
      };
      state.tasks[task.id] = task;
      return task;
    });
  }

  async function getTask(taskId) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const state = await workerStore.read();
    return structuredClone(requireRecord(
      state.tasks,
      id,
      "WORKER_TASK_NOT_FOUND",
      "Worker 任务不存在",
    ));
  }

  async function getTaskByConversation(conversationId) {
    await readyPromise;
    const id = assertId(conversationId, "Pi 会话标识");
    const state = await workerStore.read();
    const task = Object.values(state.tasks).find(
      (candidate) => candidate.conversationId === id,
    );
    if (!task) {
      throw workerError(
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
        404,
      );
    }
    return structuredClone(task);
  }

  async function listTasks({ workerId = null } = {}) {
    await readyPromise;
    const normalizedWorkerId = workerId ? assertId(workerId, "Worker 标识") : null;
    const state = await workerStore.read();
    return Object.values(state.tasks)
      .filter((task) => !normalizedWorkerId || task.workerId === normalizedWorkerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((value) => structuredClone(value));
  }

  async function removeTask(taskId) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const cleanupTargets = [];
    const proposalIds = [];
    const removed = await workerStore.transaction((state) => {
      const task = requireRecord(
        state.tasks,
        id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      for (const file of Object.values(state.files)) {
        if (file.taskId !== id) continue;
        const resolved = controlledWorkerPath(filesRoot, file.relativePath);
        if (resolved) {
          cleanupTargets.push(
            file.status === "downloading" ? resolved : path.dirname(resolved),
          );
        }
        delete state.files[file.id];
      }
      for (const [draftId, draft] of Object.entries(state.drafts)) {
        if (draft.taskId === id) delete state.drafts[draftId];
      }
      for (const [sourceId, source] of Object.entries(state.sources)) {
        if (source.taskId === id) delete state.sources[sourceId];
      }
      for (const [proposalId, proposal] of Object.entries(state.proposals)) {
        if (proposal.taskId !== id) continue;
        proposalIds.push(proposalId);
        delete state.proposals[proposalId];
      }
      for (const [receiptId, receipt] of Object.entries(state.receipts)) {
        if (receipt.taskId === id) delete state.receipts[receiptId];
      }
      delete state.tasks[id];
      return { id, conversationId: task.conversationId, removed: true };
    });
    for (const proposalId of proposalIds) {
      executionSecrets.delete(proposalId);
      queuedResumeClaims.delete(proposalId);
    }
    await Promise.all([...new Set(cleanupTargets)].map((target) => rm(target, {
      recursive: true,
      force: true,
    })));
    return removed;
  }

  async function updateTaskContext(taskId, { sourceProjectId = null } = {}) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const normalizedProjectId = compactText(
      sourceProjectId,
      "项目背景标识",
      { required: false, max: 200 },
    );
    return workerStore.transaction((state) => {
      const task = requireRecord(
        state.tasks,
        id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      task.sourceProjectId = normalizedProjectId;
      task.sourceProjectAccess = normalizedProjectId ? "read_only" : null;
      task.updatedAt = isoNow(now);
      return task;
    });
  }

  async function createTaskFile(taskId, input = {}) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const fileName = workerFileName(input.fileName);
    const mimeType = workerFileMime(input.mimeType ?? "application/octet-stream");
    const byteLength = workerFileLength(input.byteLength);
    return workerStore.transaction((state) => {
      const task = requireRecord(
        state.tasks,
        id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      if (task.workerId !== "agent_mail") {
        throw workerError(
          "WORKER_FILE_NOT_ALLOWED",
          "当前 Worker 不接受邮件附件",
          400,
        );
      }
      if (Object.values(state.files).filter((file) => file.taskId === id).length >= MAX_WORKER_FILES_PER_TASK) {
        throw workerError(
          "WORKER_FILE_LIMIT_REACHED",
          "每个 Worker 任务最多暂存 3 个附件",
          409,
        );
      }
      const at = isoNow(now);
      const fileId = makeId("worker_file", idFactory);
      const file = {
        schemaVersion: 1,
        id: fileId,
        taskId: id,
        fileName,
        mimeType,
        byteLength,
        sha256: null,
        status: "awaiting_content",
        relativePath: `${id}/${fileId}/${fileName}`,
        createdAt: at,
        uploadedAt: null,
      };
      state.files[file.id] = file;
      task.updatedAt = at;
      return publicFile(file);
    });
  }

  async function stageTaskFile(taskId, fileId, bytes) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(fileId, "Worker 附件标识");
    if (!(bytes instanceof Uint8Array)) {
      throw workerError("WORKER_FILE_CONTENT_INVALID", "附件内容无效", 400);
    }
    const file = await workerStore.transaction((state) => {
      const current = requireRecord(
        state.files,
        id,
        "WORKER_FILE_NOT_FOUND",
        "Worker 附件不存在",
      );
      if (current.taskId !== task.id) {
        throw workerError("WORKER_FILE_NOT_FOUND", "Worker 附件不存在", 404);
      }
      if (current.status !== "awaiting_content") {
        throw workerError("WORKER_FILE_STATE_INVALID", "附件内容不能重复上传", 409);
      }
      if (bytes.byteLength !== current.byteLength) {
        throw workerError("WORKER_FILE_SIZE_MISMATCH", "附件实际大小与登记大小不一致", 409);
      }
      current.status = "uploading";
      return structuredClone(current);
    });
    const destination = path.resolve(filesRoot, file.relativePath);
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let installed = false;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await link(temporary, destination);
      installed = true;
      const contentSha256 = sha256(bytes);
      return await workerStore.transaction((state) => {
        const current = requireRecord(
          state.files,
          id,
          "WORKER_FILE_NOT_FOUND",
          "Worker 附件不存在",
        );
        if (current.taskId !== task.id || current.status !== "uploading") {
          throw workerError("WORKER_FILE_STATE_INVALID", "附件状态已经变化", 409);
        }
        current.status = "ready";
        current.sha256 = contentSha256;
        current.uploadedAt = isoNow(now);
        state.tasks[task.id].updatedAt = current.uploadedAt;
        return publicFile(current);
      });
    } catch (error) {
      if (installed) await rm(destination, { force: true }).catch(() => undefined);
      await workerStore.transaction((state) => {
        const current = state.files[id];
        if (current?.taskId === task.id && current.status === "uploading") {
          current.status = "awaiting_content";
        }
        return null;
      }).catch(() => undefined);
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async function listTaskFiles(taskId) {
    const task = await getTask(taskId);
    const state = await workerStore.read();
    return Object.values(state.files)
      .filter((file) => file.taskId === task.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicFile);
  }

  async function removeTaskFile(taskId, fileId) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(fileId, "Worker 附件标识");
    let cleanupTarget = null;
    const removed = await workerStore.transaction((state) => {
      const file = requireRecord(
        state.files,
        id,
        "WORKER_FILE_NOT_FOUND",
        "Worker 附件不存在",
      );
      if (file.taskId !== task.id) {
        throw workerError("WORKER_FILE_NOT_FOUND", "Worker 附件不存在", 404);
      }
      if (Object.values(state.proposals).some((proposal) => (
        proposal.taskId === task.id
        && FILE_HOLDING_PROPOSAL_STATUSES.has(proposal.status)
        && (proposal.attachmentBindings ?? []).some((binding) => binding.id === id)
      ))) {
        throw workerError(
          "WORKER_FILE_IN_USE",
          "附件已绑定到交付提案，不能删除",
          409,
        );
      }
      const resolved = controlledWorkerPath(filesRoot, file.relativePath);
      if (!resolved) {
        throw workerError("WORKER_ATTACHMENT_PATH_UNSAFE", "附件路径不在受控目录内", 409);
      }
      cleanupTarget = file.status === "downloading" ? resolved : path.dirname(resolved);
      delete state.files[id];
      state.tasks[task.id].updatedAt = isoNow(now);
      return { id, removed: true };
    });
    if (cleanupTarget) {
      await rm(cleanupTarget, {
        recursive: true,
        force: true,
      });
    }
    return removed;
  }

  async function resolveAttachmentBindings(state, task, attachmentIds = []) {
    if (task.workerId !== "agent_mail" || attachmentIds.length === 0) {
      return { publicBindings: [], privatePaths: [] };
    }
    const publicBindings = [];
    const privatePaths = [];
    for (const rawId of attachmentIds) {
      const id = assertId(rawId, "Worker 附件标识");
      const file = requireRecord(
        state.files,
        id,
        "WORKER_FILE_NOT_FOUND",
        "Worker 附件不存在",
      );
      if (file.taskId !== task.id) {
        throw workerError("WORKER_FILE_NOT_FOUND", "Worker 附件不存在", 404);
      }
      const verified = await verifiedWorkerFile(filesRoot, file);
      publicBindings.push({
        id: verified.id,
        fileName: verified.fileName,
        mimeType: verified.mimeType,
        byteLength: verified.byteLength,
        sha256: verified.sha256,
      });
      privatePaths.push({ id: verified.id, relativePath: verified.relativePath });
    }
    return { publicBindings, privatePaths };
  }

  async function verifyProposalAttachments(state, proposal) {
    const expected = proposal.attachmentBindings ?? [];
    const privatePaths = proposal.privateAttachmentPaths ?? [];
    if (expected.length !== privatePaths.length) {
      throw workerError("WORKER_FILE_BINDING_MISMATCH", "附件绑定不完整", 409);
    }
    for (const binding of expected) {
      const file = state.files[binding.id];
      if (
        !file
        || file.taskId !== proposal.taskId
        || file.fileName !== binding.fileName
        || file.mimeType !== binding.mimeType
        || file.byteLength !== binding.byteLength
        || file.sha256 !== binding.sha256
      ) {
        throw workerError("WORKER_FILE_CHANGED", "附件绑定已变化，请重新生成交付预览", 409);
      }
      const verified = await verifiedWorkerFile(filesRoot, file);
      const privateBinding = privatePaths.find((item) => item.id === binding.id);
      if (!privateBinding || privateBinding.relativePath !== verified.relativePath) {
        throw workerError("WORKER_FILE_BINDING_MISMATCH", "附件路径绑定已变化", 409);
      }
    }
  }

  async function saveDraft(taskId, input = {}) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    if (typeof input.content !== "string") {
      throw workerError("WORKER_DRAFT_CONTENT_INVALID", "草稿内容无效", 400);
    }
    if (Buffer.byteLength(input.content, "utf8") > 4 * 1024 * 1024) {
      throw workerError("WORKER_DRAFT_TOO_LARGE", "草稿内容过大", 400);
    }
    const source = input.source === "agent" ? "agent" : "user";
    const invalidatedProposalIds = [];
    const draft = await workerStore.transaction((state) => {
      const task = requireRecord(
        state.tasks,
        id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      const allowedFormats = task.workerId === "agent_mail"
        ? ["plain", "html"]
        : ["xml", "markdown"];
      if (!allowedFormats.includes(input.format)) {
        throw workerError("WORKER_DRAFT_FORMAT_INVALID", "草稿格式无效", 400);
      }
      if (Object.values(state.proposals).some(
        (proposal) => proposal.taskId === id && proposal.status === "executing",
      )) {
        throw workerError(
          "WORKER_ACTION_IN_PROGRESS",
          "外部交付正在执行，暂时不能修改草稿",
          409,
        );
      }
      const versions = Object.values(state.drafts)
        .filter((draft) => draft.taskId === id)
        .map((draft) => draft.version);
      const at = isoNow(now);
      const draft = {
        schemaVersion: 1,
        id: makeId("draft", idFactory),
        taskId: id,
        version: Math.max(0, ...versions) + 1,
        format: input.format,
        content: input.content,
        sha256: sha256(input.content),
        source,
        createdAt: at,
      };
      state.drafts[draft.id] = draft;
      task.currentDraftRevisionId = draft.id;
      task.updatedAt = at;
      for (const proposal of Object.values(state.proposals)) {
        if (proposal.taskId !== id || !ACTIVE_PROPOSAL_STATUSES.has(proposal.status)) continue;
        proposal.status = "invalidated";
        proposal.invalidatedAt = at;
        proposal.invalidatedReason = "draft_revised";
        proposal.invalidatedByDraftRevisionId = draft.id;
        proposal.privateExecutionState = null;
        invalidatedProposalIds.push(proposal.id);
        proposal.updatedAt = at;
      }
      return draft;
    });
    for (const proposalId of invalidatedProposalIds) executionSecrets.delete(proposalId);
    return draft;
  }

  async function invalidateDraftActions(taskId, input = {}) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const draftRevisionId = assertId(input.draftRevisionId, "当前草稿版本标识");
    const result = await workerStore.transaction((state) => {
      const task = requireRecord(
        state.tasks,
        id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      if (task.currentDraftRevisionId !== draftRevisionId) {
        throw workerError(
          "WORKER_DRAFT_STALE",
          "草稿版本已经变化，不能开始编辑旧版本",
          409,
        );
      }
      if (Object.values(state.proposals).some(
        (proposal) => proposal.taskId === id && proposal.status === "executing",
      )) {
        throw workerError(
          "WORKER_ACTION_IN_PROGRESS",
          "外部交付正在执行，暂时不能开始编辑草稿",
          409,
        );
      }
      const at = isoNow(now);
      for (const proposal of Object.values(state.proposals)) {
        if (proposal.taskId !== id || !ACTIVE_PROPOSAL_STATUSES.has(proposal.status)) continue;
        proposal.status = "invalidated";
        proposal.invalidatedAt = at;
        proposal.invalidatedReason = "draft_edit_started";
        proposal.invalidatedByDraftRevisionId = draftRevisionId;
        proposal.privateExecutionState = null;
        proposal.updatedAt = at;
      }
      const invalidatedProposalIds = Object.values(state.proposals)
        .filter((proposal) => (
          proposal.taskId === id
          && proposal.status === "invalidated"
          && proposal.invalidatedReason === "draft_edit_started"
          && proposal.invalidatedByDraftRevisionId === draftRevisionId
        ))
        .map((proposal) => proposal.id)
        .sort();
      task.updatedAt = at;
      return {
        schemaVersion: 1,
        taskId: id,
        draftRevisionId,
        invalidatedProposalIds,
      };
    });
    for (const proposalId of result.invalidatedProposalIds) {
      executionSecrets.delete(proposalId);
    }
    return result;
  }

  async function getDraft(taskId, draftRevisionId = null) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const state = await workerStore.read();
    const task = requireRecord(
      state.tasks,
      id,
      "WORKER_TASK_NOT_FOUND",
      "Worker 任务不存在",
    );
    const targetId = draftRevisionId
      ? assertId(draftRevisionId, "草稿版本标识")
      : task.currentDraftRevisionId;
    if (!targetId) return null;
    const draft = requireRecord(
      state.drafts,
      targetId,
      "WORKER_DRAFT_NOT_FOUND",
      "草稿版本不存在",
    );
    if (draft.taskId !== id) {
      throw workerError("WORKER_DRAFT_NOT_FOUND", "草稿版本不存在", 404);
    }
    return structuredClone(draft);
  }

  async function listDrafts(taskId) {
    await getTask(taskId);
    const state = await workerStore.read();
    return Object.values(state.drafts)
      .filter((draft) => draft.taskId === taskId)
      .sort((left, right) => right.version - left.version)
      .map((value) => structuredClone(value));
  }

  async function listSources(taskId) {
    const task = await getTask(taskId);
    const state = await workerStore.read();
    return Object.values(state.sources)
      .filter((source) => source.taskId === task.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicWorkerSource);
  }

  async function getAgentReferenceContext(taskId) {
    return buildWorkerReferenceContext(await listSources(taskId));
  }

  async function prepareProposal(proposalId) {
    const snapshot = await workerStore.read();
    const proposal = requireRecord(
      snapshot.proposals,
      proposalId,
      "WORKER_ACTION_NOT_FOUND",
      "交付提案不存在",
    );
    const draft = proposal.draftRevisionId
      ? requireRecord(
        snapshot.drafts,
        proposal.draftRevisionId,
        "WORKER_DRAFT_NOT_FOUND",
        "草稿版本不存在",
      )
      : null;
    try {
      assertSourceBindingsCurrent(snapshot, proposal);
      await verifyProposalAttachments(snapshot, proposal);
      await assertConnectionBindingCurrent(proposal);
      const prepared = await executor.prepare({
        proposal: structuredClone(proposal),
        draft: draft ? structuredClone(draft) : null,
      });
      if (prepared?.privateState) {
        executionSecrets.set(proposalId, {
          proposalHash: proposal.proposalHash,
          value: structuredClone(prepared.privateState),
        });
      } else {
        executionSecrets.delete(proposalId);
      }
      const persisted = await workerStore.transaction((state) => {
        const current = requireRecord(
          state.proposals,
          proposalId,
          "WORKER_ACTION_NOT_FOUND",
          "交付提案不存在",
        );
        if (current.status !== "preparing") return publicProposal(current);
        const at = isoNow(now);
        current.status = "pending_confirmation";
        current.preparation = prepared?.publicState
          ? structuredClone(prepared.publicState)
          : null;
        current.privateExecutionState = null;
        current.lastError = null;
        current.preparedAt = at;
        current.updatedAt = at;
        return publicProposal(current);
      });
      if (persisted.status !== "pending_confirmation") {
        executionSecrets.delete(proposalId);
      }
      return persisted;
    } catch (originalError) {
      const error = retryableFailure(originalError);
      executionSecrets.delete(proposalId);
      await workerStore.transaction((state) => {
        const current = state.proposals[proposalId];
        if (!current || current.status !== "preparing") return null;
        const at = isoNow(now);
        current.status = error.unknownOutcome
          ? "unknown_outcome"
          : error.retryable
            ? "retryable_failed"
            : "failed";
        current.lastError = safeWorkerFailure(error, "WORKER_PREPARATION_FAILED");
        current.privateExecutionState = null;
        current.updatedAt = at;
        if (error.unknownOutcome && !current.receiptId) {
          const receipt = {
            schemaVersion: 1,
            id: makeId("receipt", idFactory),
            taskId: current.taskId,
            proposalId: current.id,
            workerId: current.workerId,
            provider: current.workerId,
            status: "unknown",
            externalId: null,
            externalUrl: null,
            providerState: "manual_check_required",
            proposalHash: current.proposalHash,
            draftSha256: current.draftSha256,
            verification: {
              status: "manual_check_required",
              error: current.lastError,
            },
            createdAt: at,
          };
          state.receipts[receipt.id] = receipt;
          current.receiptId = receipt.id;
        }
        return null;
      });
      throw error;
    }
  }

  async function proposeAction(taskId, input = {}) {
    await readyPromise;
    const id = assertId(taskId, "Worker 任务标识");
    const operation = compactText(input.operation, "交付操作", { max: 80 });
    const clientRequestId = compactText(input.clientRequestId, "请求标识", {
      required: false,
      max: 160,
    });
    const snapshot = await workerStore.read();
    const task = requireRecord(
      snapshot.tasks,
      id,
      "WORKER_TASK_NOT_FOUND",
      "Worker 任务不存在",
    );
    const definition = requireRecord(
      snapshot.definitions,
      task.workerId,
      "WORKER_DEFINITION_NOT_FOUND",
      "Worker 不存在",
    );
    const draft = task.currentDraftRevisionId
      ? requireRecord(
        snapshot.drafts,
        task.currentDraftRevisionId,
        "WORKER_DRAFT_NOT_FOUND",
        "当前草稿版本不存在",
      )
      : null;
    const connectionBinding = await resolveConnectionBinding(definition);
    const boundSources = bindActionSources(
      snapshot,
      task,
      operation,
      input,
      connectionBinding,
    );
    const normalized = normalizeWorkerAction({
      definition,
      operation,
      input: {
        parameters: boundSources.parameters,
        before: boundSources.before,
        after: boundSources.after,
      },
      draft,
    });
    const attachments = await resolveAttachmentBindings(
      snapshot,
      task,
      normalized.parameters.attachments ?? [],
    );
    const created = await workerStore.transaction((state) => {
      if (clientRequestId) {
        const repeated = Object.values(state.proposals).find(
          (proposal) => proposal.taskId === id
            && proposal.clientRequestId === clientRequestId,
        );
        if (repeated) return { repeated: true, proposal: publicProposal(repeated) };
      }
      if (Object.values(state.proposals).some(
        (proposal) => proposal.taskId === id
          && blocksNewDelivery(proposal),
      )) {
        throw workerError(
          "WORKER_ACTION_ALREADY_PENDING",
          "当前任务已有待处理的交付提案",
          409,
        );
      }
      const currentTask = requireRecord(
        state.tasks,
        id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      if (currentTask.currentDraftRevisionId !== task.currentDraftRevisionId) {
        throw workerError(
          "WORKER_DRAFT_STALE",
          "草稿已经变化，请重新生成交付提案",
          409,
        );
      }
      const bindingProbe = {
        taskId: id,
        workerId: task.workerId,
        sourceBindings: boundSources.sourceBindings,
      };
      assertSourceBindingsCurrent(state, bindingProbe);
      const at = isoNow(now);
      const proposal = {
        schemaVersion: 1,
        id: makeId("delivery", idFactory),
        taskId: id,
        workerId: task.workerId,
        clientRequestId,
        operation: normalized.operation,
        risk: normalized.risk,
        parameters: normalized.parameters,
        baseRevisionId: normalized.baseRevisionId,
        draftRevisionId: normalized.draftRevisionId,
        draftSha256: normalized.draftSha256,
        connectionBinding,
        sourceBindings: boundSources.sourceBindings,
        attachmentBindings: attachments.publicBindings,
        privateAttachmentPaths: attachments.privatePaths,
        preview: normalized.preview,
        proposalHash: null,
        status: "preparing",
        preparation: null,
        privateExecutionState: null,
        approval: null,
        attemptCount: 0,
        receiptId: null,
        lastError: null,
        createdAt: at,
        updatedAt: at,
      };
      proposal.proposalHash = sha256(proposalHashCore(proposal));
      state.proposals[proposal.id] = proposal;
      currentTask.updatedAt = at;
      return { repeated: false, proposal: publicProposal(proposal) };
    });
    if (created.repeated || created.proposal.status !== "preparing") {
      return created.proposal;
    }
    return prepareProposal(created.proposal.id);
  }

  async function getAction(taskId, actionId) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(actionId, "交付提案标识");
    const state = await workerStore.read();
    const proposal = requireRecord(
      state.proposals,
      id,
      "WORKER_ACTION_NOT_FOUND",
      "交付提案不存在",
    );
    if (proposal.taskId !== task.id) {
      throw workerError("WORKER_ACTION_NOT_FOUND", "交付提案不存在", 404);
    }
    return publicProposal(proposal);
  }

  async function listActions(taskId) {
    await getTask(taskId);
    const state = await workerStore.read();
    return Object.values(state.proposals)
      .filter((proposal) => proposal.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicProposal);
  }

  async function abandonAction(taskId, actionId, input = {}) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(actionId, "交付提案标识");
    return workerStore.transaction((state) => {
      const proposal = requireRecord(
        state.proposals,
        id,
        "WORKER_ACTION_NOT_FOUND",
        "交付提案不存在",
      );
      if (proposal.taskId !== task.id) {
        throw workerError("WORKER_ACTION_NOT_FOUND", "交付提案不存在", 404);
      }
      if (proposal.status === "abandoned") return publicProposal(proposal);
      const manualUnknownResolution = proposal.status === "unknown_outcome";
      if (manualUnknownResolution && input.manualCheckCompleted !== true) {
        throw workerError(
          "WORKER_ACTION_MANUAL_CHECK_REQUIRED",
          "外部结果不确定；请先人工核对，再明确结束该提案",
          409,
        );
      }
      if (!manualUnknownResolution && !ABANDONABLE_PROPOSAL_STATUSES.has(proposal.status)) {
        throw workerError(
          "WORKER_ACTION_STATE_INVALID",
          "当前交付提案不能放弃",
          409,
        );
      }
      const at = isoNow(now);
      proposal.status = "abandoned";
      proposal.abandonedAt = at;
      const userReason = compactText(input.reason, "放弃原因", {
        required: false,
        max: 240,
      });
      proposal.abandonReason = manualUnknownResolution
        ? "manual_check_completed"
        : userReason;
      proposal.manualCheckCompleted = manualUnknownResolution;
      proposal.manualCheckCompletedAt = manualUnknownResolution ? at : null;
      proposal.manualCheckNote = manualUnknownResolution ? userReason : null;
      proposal.privateExecutionState = null;
      executionSecrets.delete(proposal.id);
      proposal.updatedAt = at;
      if (manualUnknownResolution && proposal.receiptId) {
        const receipt = state.receipts[proposal.receiptId];
        if (receipt) {
          receipt.verification = {
            ...(receipt.verification ?? {}),
            manualCheckCompleted: true,
            manualCheckCompletedAt: at,
            manualCheckNote: userReason,
          };
          receipt.updatedAt = at;
        }
      }
      return publicProposal(proposal);
    });
  }

  async function resumeQueuedAction(task, actionId) {
    if (queuedResumeClaims.has(actionId)) {
      throw workerError(
        "WORKER_ACTION_IN_PROGRESS",
        "正在查询外部任务状态，请稍后再试",
        409,
        { retryable: true },
      );
    }
    queuedResumeClaims.add(actionId);
    try {
      const snapshot = await workerStore.read();
      const proposal = requireRecord(
        snapshot.proposals,
        actionId,
        "WORKER_ACTION_NOT_FOUND",
        "交付提案不存在",
      );
      if (
        proposal.taskId !== task.id
        || proposal.status !== "queued"
        || proposal.workerId !== "lark_doc"
        || proposal.operation !== "history_revert"
      ) {
        throw workerError("WORKER_ACTION_STATE_INVALID", "当前交付提案不能续查", 409);
      }
      const receipt = proposal.receiptId ? snapshot.receipts[proposal.receiptId] : null;
      if (!receipt || typeof executor.resume !== "function") {
        throw workerError(
          "WORKER_ACTION_RESUME_UNAVAILABLE",
          "当前外部任务不能安全续查",
          409,
          { retryable: true },
        );
      }
      assertSourceBindingsCurrent(snapshot, proposal);
      await assertConnectionBindingCurrent(proposal);
      const resumed = normalizeExecutionResult(await executor.resume({
        proposal: structuredClone(proposal),
        receipt: structuredClone(receipt),
      }), proposal);
      return workerStore.transaction((state) => {
        const current = requireRecord(
          state.proposals,
          actionId,
          "WORKER_ACTION_NOT_FOUND",
          "交付提案不存在",
        );
        const currentReceipt = current.receiptId ? state.receipts[current.receiptId] : null;
        if (current.status !== "queued" || !currentReceipt) {
          throw workerError("WORKER_ACTION_STATE_INVALID", "交付状态已经变化", 409);
        }
        const at = isoNow(now);
        currentReceipt.status = resumed.deliveryStatus;
        currentReceipt.providerState = resumed.providerState;
        currentReceipt.externalId = resumed.externalId;
        currentReceipt.externalUrl = resumed.externalUrl;
        currentReceipt.verification = resumed.verification;
        currentReceipt.updatedAt = at;
        current.status = resumed.deliveryStatus === "queued" ? "queued" : "succeeded";
        if (current.status === "succeeded") current.succeededAt = at;
        else current.queuedAt = at;
        current.lastError = null;
        current.updatedAt = at;
        return {
          resumed: true,
          proposal: publicProposal(current),
          receipt: structuredClone(currentReceipt),
        };
      });
    } catch (originalError) {
      const error = retryableFailure(originalError);
      if (error.unknownOutcome) {
        await workerStore.transaction((state) => {
          const proposal = state.proposals[actionId];
          if (!proposal || proposal.status !== "queued") return null;
          const at = isoNow(now);
          proposal.status = "unknown_outcome";
          proposal.lastError = safeWorkerFailure(error);
          proposal.updatedAt = at;
          const receipt = proposal.receiptId ? state.receipts[proposal.receiptId] : null;
          if (receipt) {
            receipt.status = "unknown";
            receipt.providerState = "manual_check_required";
            receipt.verification = {
              status: "manual_check_required",
              error: safeWorkerFailure(error),
            };
            receipt.updatedAt = at;
          }
          return null;
        });
      }
      throw error;
    } finally {
      queuedResumeClaims.delete(actionId);
    }
  }

  async function retryAction(taskId, actionId) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(actionId, "交付提案标识");
    const initial = await workerStore.read();
    if (initial.proposals[id]?.status === "queued") {
      return resumeQueuedAction(task, id);
    }
    const transition = await workerStore.transaction(async (state) => {
      const proposal = requireRecord(
        state.proposals,
        id,
        "WORKER_ACTION_NOT_FOUND",
        "交付提案不存在",
      );
      if (proposal.taskId !== task.id) {
        throw workerError("WORKER_ACTION_NOT_FOUND", "交付提案不存在", 404);
      }
      if (proposal.status === "unknown_outcome") {
        throw workerError(
          "WORKER_ACTION_MANUAL_CHECK_REQUIRED",
          "外部结果不确定，必须人工检查，不能盲目重试",
          409,
        );
      }
      if (proposal.status !== "retryable_failed") {
        throw workerError(
          "WORKER_ACTION_STATE_INVALID",
          "当前交付提案不能重试",
          409,
        );
      }
      const currentTask = state.tasks[task.id];
      assertSourceBindingsCurrent(state, proposal);
      await verifyProposalAttachments(state, proposal);
      if (
        proposal.draftRevisionId
        && currentTask.currentDraftRevisionId !== proposal.draftRevisionId
      ) {
        const at = isoNow(now);
        proposal.status = "invalidated";
        proposal.invalidatedAt = at;
        proposal.invalidatedReason = "draft_revised";
        proposal.privateExecutionState = null;
        proposal.updatedAt = at;
        return { stale: true };
      }
      proposal.status = "preparing";
      proposal.preparation = null;
      proposal.privateExecutionState = null;
      executionSecrets.delete(proposal.id);
      proposal.lastError = null;
      proposal.updatedAt = isoNow(now);
      return { stale: false };
    });
    if (transition.stale) {
      throw workerError(
        "WORKER_DRAFT_STALE",
        "草稿已经变化，请重新生成交付提案",
        409,
      );
    }
    return prepareProposal(id);
  }

  async function confirmAction(taskId, actionId, bindings = {}) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(actionId, "交付提案标识");
    const prepared = await workerStore.transaction(async (state) => {
      const proposal = requireRecord(
        state.proposals,
        id,
        "WORKER_ACTION_NOT_FOUND",
        "交付提案不存在",
      );
      if (proposal.taskId !== task.id) {
        throw workerError("WORKER_ACTION_NOT_FOUND", "交付提案不存在", 404);
      }
      assertBindings(proposal, bindings);
      if (["succeeded", "queued"].includes(proposal.status)) {
        return {
          alreadySucceeded: true,
          proposal: publicProposal(proposal),
          receipt: proposal.receiptId ? structuredClone(state.receipts[proposal.receiptId]) : null,
        };
      }
      if (proposal.status !== "pending_confirmation") {
        throw workerError(
          "WORKER_ACTION_STATE_INVALID",
          "当前交付提案不处于待确认状态",
          409,
        );
      }
      const currentTask = state.tasks[task.id];
      assertSourceBindingsCurrent(state, proposal);
      await verifyProposalAttachments(state, proposal);
      if (
        proposal.draftRevisionId
        && (
          currentTask.currentDraftRevisionId !== proposal.draftRevisionId
          || state.drafts[proposal.draftRevisionId]?.sha256 !== proposal.draftSha256
        )
      ) {
        throw workerError(
          "WORKER_DRAFT_STALE",
          "草稿已经变化，请重新生成交付提案",
          409,
        );
      }
      if (executor.externalWritesEnabled !== true) {
        throw workerError(
          "WORKER_EXTERNAL_WRITES_DISABLED",
          "真实外部写入尚未启用",
          403,
        );
      }
      const secret = executionSecrets.get(proposal.id);
      const expiresAt = Date.parse(
        proposal.preparation?.confirmationExpiresAt ?? "",
      );
      if (
        proposal.workerId === "agent_mail"
        && (
          !secret
          || secret.proposalHash !== proposal.proposalHash
          || !Number.isFinite(expiresAt)
          || Date.parse(isoNow(now)) >= expiresAt
        )
      ) {
        const at = isoNow(now);
        proposal.status = "retryable_failed";
        proposal.lastError = {
          code: "WORKER_MAIL_CONFIRMATION_EXPIRED",
          message: "邮箱确认令牌已失效，请重新生成交付预览",
          retryable: true,
          unknownOutcome: false,
        };
        proposal.privateExecutionState = null;
        executionSecrets.delete(proposal.id);
        proposal.updatedAt = at;
        return { expired: true, proposal: publicProposal(proposal) };
      }
      const at = isoNow(now);
      proposal.status = "executing";
      proposal.attemptCount += 1;
      proposal.approval = {
        proposalHash: proposal.proposalHash,
        draftSha256: proposal.draftSha256,
        baseRevisionId: proposal.baseRevisionId,
        clientRequestId: compactText(bindings.clientRequestId, "确认请求标识", {
          required: false,
          max: 160,
        }),
        approvedAt: at,
      };
      proposal.updatedAt = at;
      const privateExecutionState = secret?.value
        ? structuredClone(secret.value)
        : null;
      executionSecrets.delete(proposal.id);
      return {
        alreadySucceeded: false,
        proposal: structuredClone(proposal),
        privateExecutionState,
        draft: proposal.draftRevisionId
          ? structuredClone(state.drafts[proposal.draftRevisionId])
          : null,
      };
    });
    if (prepared.alreadySucceeded) return prepared;
    if (prepared.expired) {
      throw workerError(
        "WORKER_MAIL_CONFIRMATION_EXPIRED",
        "邮箱确认令牌已失效，请重新生成交付预览",
        409,
        { retryable: true },
      );
    }

    let executionResult;
    try {
      const executionSnapshot = await workerStore.read();
      assertSourceBindingsCurrent(executionSnapshot, prepared.proposal);
      await verifyProposalAttachments(executionSnapshot, prepared.proposal);
      await assertConnectionBindingCurrent(prepared.proposal);
      executionResult = normalizeExecutionResult(await executor.execute({
        proposal: structuredClone(prepared.proposal),
        draft: prepared.draft ? structuredClone(prepared.draft) : null,
        privateState: prepared.proposal.privateExecutionState
          ? structuredClone(prepared.proposal.privateExecutionState)
          : prepared.privateExecutionState,
      }), prepared.proposal);
    } catch (originalError) {
      const error = retryableFailure(originalError);
      await workerStore.transaction((state) => {
        const proposal = state.proposals[id];
        if (!proposal || proposal.status !== "executing") return null;
        const at = isoNow(now);
        proposal.status = error.unknownOutcome
          ? "unknown_outcome"
          : error.retryable
            ? "retryable_failed"
            : "failed";
        proposal.lastError = safeWorkerFailure(error);
        proposal.privateExecutionState = null;
        proposal.updatedAt = at;
        if (error.unknownOutcome) {
          const receipt = {
            schemaVersion: 1,
            id: makeId("receipt", idFactory),
            taskId: proposal.taskId,
            proposalId: proposal.id,
            workerId: proposal.workerId,
            provider: proposal.workerId,
            status: "unknown",
            externalId: null,
            externalUrl: null,
            providerState: "manual_check_required",
            proposalHash: proposal.proposalHash,
            draftSha256: proposal.draftSha256,
            verification: {
              status: "manual_check_required",
              error: safeWorkerFailure(error),
            },
            createdAt: at,
          };
          state.receipts[receipt.id] = receipt;
          proposal.receiptId = receipt.id;
        }
        return null;
      });
      throw error;
    }

    return workerStore.transaction((state) => {
      const proposal = requireRecord(
        state.proposals,
        id,
        "WORKER_ACTION_NOT_FOUND",
        "交付提案不存在",
      );
      if (proposal.status !== "executing") {
        throw workerError(
          "WORKER_ACTION_STATE_INVALID",
          "交付状态已经变化，不能记录重复结果",
          409,
        );
      }
      const at = isoNow(now);
      const receipt = {
        schemaVersion: 1,
        id: makeId("receipt", idFactory),
        taskId: proposal.taskId,
        proposalId: proposal.id,
        workerId: proposal.workerId,
        provider: executionResult.provider,
        status: executionResult.deliveryStatus,
        externalId: executionResult.externalId,
        externalUrl: executionResult.externalUrl,
        providerState: executionResult.providerState,
        proposalHash: proposal.proposalHash,
        draftSha256: proposal.draftSha256,
        verification: executionResult.verification,
        createdAt: at,
      };
      state.receipts[receipt.id] = receipt;
      proposal.status = executionResult.deliveryStatus === "queued"
        ? "queued"
        : "succeeded";
      proposal.receiptId = receipt.id;
      if (proposal.status === "queued") proposal.queuedAt = at;
      else proposal.succeededAt = at;
      proposal.lastError = null;
      proposal.privateExecutionState = null;
      proposal.updatedAt = at;
      state.tasks[proposal.taskId].updatedAt = at;
      return {
        alreadySucceeded: false,
        proposal: publicProposal(proposal),
        receipt: structuredClone(receipt),
      };
    });
  }

  async function getReceipt(taskId, receiptId) {
    await readyPromise;
    const task = await getTask(taskId);
    const id = assertId(receiptId, "交付回执标识");
    const state = await workerStore.read();
    const receipt = requireRecord(
      state.receipts,
      id,
      "WORKER_RECEIPT_NOT_FOUND",
      "交付回执不存在",
    );
    if (receipt.taskId !== task.id) {
      throw workerError("WORKER_RECEIPT_NOT_FOUND", "交付回执不存在", 404);
    }
    return structuredClone(receipt);
  }

  async function listReceipts(taskId) {
    await getTask(taskId);
    const state = await workerStore.read();
    return Object.values(state.receipts)
      .filter((receipt) => receipt.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((value) => structuredClone(value));
  }

  async function inspect() {
    await readyPromise;
    return publicState(await workerStore.read());
  }

  async function getConnectionHealth(workerId) {
    await readyPromise;
    const definition = await getDefinition(workerId);
    const result = await connections.health({
      workerId: definition.id,
      definition,
    });
    return {
      workerId: definition.id,
      connectorId: definition.connectorId,
      status: result?.status === "connected" ? "connected" : "unavailable",
      verified: result?.verified === true,
      identity: typeof result?.identity === "string"
        ? result.identity.slice(0, 320)
        : null,
      reason: typeof result?.reason === "string"
        ? result.reason.slice(0, 300)
        : null,
    };
  }

  async function downloadMailAttachment(task, definition, input = {}) {
    const messageId = compactText(input.parameters?.messageId, "邮件标识", { max: 280 });
    const attachmentId = compactText(input.parameters?.attachmentId, "附件标识", { max: 280 });
    let reservedFile;
    await workerStore.transaction((state) => {
      const currentTask = requireRecord(
        state.tasks,
        task.id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      if (currentTask.workerId !== "agent_mail") {
        throw workerError("WORKER_FILE_NOT_ALLOWED", "当前 Worker 不接受邮件附件", 400);
      }
      if (
        Object.values(state.files).filter((file) => file.taskId === task.id).length
        >= MAX_WORKER_FILES_PER_TASK
      ) {
        throw workerError(
          "WORKER_FILE_LIMIT_REACHED",
          "每个 Worker 任务最多暂存 3 个附件",
          409,
        );
      }
      const at = isoNow(now);
      const fileId = makeId("worker_file", idFactory);
      if (hasOwn(state.files, fileId)) {
        throw workerError("WORKER_ID_COLLISION", "无法安全生成 Worker 附件标识", 500);
      }
      reservedFile = {
        schemaVersion: 1,
        id: fileId,
        taskId: task.id,
        fileName: "下载中的附件",
        mimeType: "application/octet-stream",
        byteLength: null,
        sha256: null,
        status: "downloading",
        relativePath: `${task.id}/${fileId}`,
        createdAt: at,
        uploadedAt: null,
      };
      state.files[fileId] = reservedFile;
      currentTask.updatedAt = at;
      return null;
    });
    const downloadDirectory = path.resolve(filesRoot, reservedFile.relativePath);
    try {
      await mkdir(path.dirname(downloadDirectory), { recursive: true, mode: 0o700 });
      await mkdir(downloadDirectory, { mode: 0o700 });
      const result = await connections.read({
        workerId: definition.id,
        definition,
        task: structuredClone(task),
        operation: "attachment_download",
        parameters: {
          messageId,
          attachmentId,
          output: `./${reservedFile.relativePath}`,
        },
      });
      const imported = await importDownloadedWorkerFile(filesRoot, reservedFile, result);
      const readyFile = await workerStore.transaction((state) => {
        const current = requireRecord(
          state.files,
          reservedFile.id,
          "WORKER_FILE_NOT_FOUND",
          "Worker 附件不存在",
        );
        if (current.taskId !== task.id || current.status !== "downloading") {
          throw workerError("WORKER_FILE_STATE_INVALID", "附件下载状态已经变化", 409);
        }
        Object.assign(current, imported, {
          status: "ready",
          uploadedAt: isoNow(now),
        });
        state.tasks[task.id].updatedAt = current.uploadedAt;
        return publicFile(current);
      });
      const {
        saved_to: _savedTo,
        savedTo: _savedToCamel,
        download_url: _downloadUrl,
        downloadUrl: _downloadUrlCamel,
        ...safeProviderData
      } = result?.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data
        : {};
      return {
        result: {
          ...result,
          data: {
            ...safeProviderData,
            file: readyFile,
          },
        },
        sourceParameters: { messageId, attachmentId },
      };
    } catch (error) {
      await rm(downloadDirectory, { recursive: true, force: true }).catch(() => undefined);
      await workerStore.transaction((state) => {
        if (state.files[reservedFile.id]?.status === "downloading") {
          delete state.files[reservedFile.id];
        }
        return null;
      }).catch(() => undefined);
      throw error;
    }
  }

  async function readExternal(taskId, input = {}) {
    await readyPromise;
    const task = await getTask(taskId);
    const definition = await getDefinition(task.workerId);
    const operation = compactText(input.operation, "读取操作", { max: 80 });
    if (!definition.readCapabilities.includes(operation)) {
      throw workerError(
        "WORKER_READ_ACTION_NOT_ALLOWED",
        "该 Worker 不允许执行此读取操作",
        400,
      );
    }
    const rawParameters = input.parameters && typeof input.parameters === "object"
      && !Array.isArray(input.parameters)
      ? structuredClone(input.parameters)
      : {};
    const attachmentDownload = operation === "attachment_download"
      ? await downloadMailAttachment(task, definition, { parameters: rawParameters })
      : null;
    const result = attachmentDownload?.result ?? await connections.read({
      workerId: definition.id,
      definition,
      task: structuredClone(task),
      operation,
      parameters: rawParameters,
    });
    const sourceParameters = attachmentDownload?.sourceParameters ?? rawParameters;
    const createdAt = isoNow(now);
    const source = normalizeWorkerSource({
      id: makeId("worker_source", idFactory),
      taskId: task.id,
      workerId: definition.id,
      operation,
      data: result?.data ?? null,
      parameters: sourceParameters,
      createdAt,
    });
    await workerStore.transaction((state) => {
      const currentTask = requireRecord(
        state.tasks,
        task.id,
        "WORKER_TASK_NOT_FOUND",
        "Worker 任务不存在",
      );
      state.sources[source.id] = source;
      const boundSourceIds = new Set(
        Object.values(state.proposals)
          .filter((proposal) => proposal.taskId === task.id)
          .flatMap((proposal) => Object.values(proposal.sourceBindings ?? {}))
          .map((binding) => binding?.id)
          .filter(Boolean),
      );
      const overflow = Object.values(state.sources)
        .filter((item) => item.taskId === task.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(MAX_WORKER_SOURCES_PER_TASK)
        .filter((item) => !boundSourceIds.has(item.id));
      for (const item of overflow) delete state.sources[item.id];
      currentTask.updatedAt = createdAt;
      return null;
    });
    return safeWorkerReadResult(result, source);
  }

  const service = Object.freeze({
    ready,
    listDefinitions,
    getDefinition,
    createTask,
    getTask,
    getTaskByConversation,
    listTasks,
    removeTask,
    updateTaskContext,
    createTaskFile,
    stageTaskFile,
    listTaskFiles,
    removeTaskFile,
    saveDraft,
    invalidateDraftActions,
    getDraft,
    listDrafts,
    listSources,
    getAgentReferenceContext,
    proposeAction,
    getAction,
    listActions,
    abandonAction,
    confirmAction,
    retryAction,
    getReceipt,
    listReceipts,
    getConnectionHealth,
    readExternal,
    inspect,
  });

  return service;
}

export const __test = Object.freeze({
  proposalHashCore,
  assertBindings,
  normalizeExecutionResult,
  publicProposal,
});
