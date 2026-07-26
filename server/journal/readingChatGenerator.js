import { promptRegistry as defaultPromptRegistry } from "../promptRegistry.js";

const PROMPT_ID = "reading-chat";
const BLOCK_ID_PATTERN = /^block-[a-f0-9]{20}$/;
const MAX_SOURCE_BLOCKS = 20_000;
const MAX_QUESTION_CHARS = 1_000;
const MAX_SELECTION_CHARS = 4_000;
const MAX_CONTEXT_SIDE_CHARS = 400;
const MAX_FALLBACK_REFERENCES = 8;
const MAX_FALLBACK_BLOCK_CHARS = 1_000;
const MAX_FALLBACK_CONTENT_CHARS = 8_000;
const MAX_HISTORY_TURNS = 4;
const MAX_HISTORY_CHARS = 6_000;
const MAX_PROJECT_CONTEXT_CHARS = 8_000;
const OUTPUT_FIELDS = ["paper_id", "answer", "citations"];

export class ReadingChatGeneratorError extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message);
    this.name = "ReadingChatGeneratorError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function inputError(message) {
  return new ReadingChatGeneratorError("READING_CHAT_INPUT_INVALID", message);
}

function outputError(message) {
  return new ReadingChatGeneratorError(
    "READING_CHAT_OUTPUT_INVALID",
    message,
    502,
    true,
  );
}

function compact(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ").slice(0, maxLength);
}

function requiredString(value, field, maxLength) {
  if (typeof value !== "string") throw inputError(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw inputError(`${field} 必须是长度不超过 ${maxLength} 的非空字符串`);
  }
  return normalized;
}

function normalizePaper(paper) {
  if (!paper || typeof paper !== "object" || Array.isArray(paper)) {
    throw inputError("paper 必须是对象");
  }
  return {
    paper_id: requiredString(paper.paper_id, "paper.paper_id", 200),
    title: requiredString(paper.title, "paper.title", 500),
    authors: Array.isArray(paper.authors)
      ? paper.authors.slice(0, 12).map((author) => compact(author, 160)).filter(Boolean)
      : [],
    venue: compact(paper.venue, 200),
    published_at: compact(paper.published_at, 40),
  };
}

function displaySource(block) {
  if (block?.kind === "table" && typeof block.markdown === "string") {
    return block.markdown.trim();
  }
  if (typeof block?.text === "string" && block.text.trim()) return block.text.trim();
  return typeof block?.markdown === "string" ? block.markdown.trim() : "";
}

function normalizeDocument(document) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || !Array.isArray(document.blocks)
    || document.blocks.length === 0
    || document.blocks.length > MAX_SOURCE_BLOCKS
  ) {
    throw inputError("document 的 blocks 超出合同");
  }
  const revision = requiredString(document.revision, "document.revision", 160);
  const seen = new Set();
  const blocks = document.blocks.map((block) => {
    const blockId = compact(block?.block_id, 160);
    if (!BLOCK_ID_PATTERN.test(blockId) || seen.has(blockId)) {
      throw inputError("document 包含无效或重复的 block_id");
    }
    seen.add(blockId);
    return {
      block_id: blockId,
      path: Array.isArray(block.path)
        ? block.path.slice(0, 8).map((item) => compact(item, 160)).filter(Boolean)
        : [],
      ordinal: Number.isSafeInteger(block.ordinal) ? block.ordinal : null,
      kind: compact(block.kind, 30) || "text",
      source: displaySource(block),
    };
  }).filter((block) => block.source);
  if (blocks.length === 0) throw inputError("document 没有可用于对话的正文块");
  return {
    title: compact(document.title, 500),
    revision,
    blocks,
  };
}

function evenIndices(length, count) {
  if (length <= 0 || count <= 0) return [];
  if (length === 1 || count === 1) return [0];
  const size = Math.min(length, count);
  return Array.from(
    { length: size },
    (_, index) => Math.round(index * (length - 1) / (size - 1)),
  );
}

function selectedFallbackBlocks(blocks) {
  const readableBlocks = blocks.filter((block) => block.kind !== "heading");
  const sourceBlocks = readableBlocks.length > 0 ? readableBlocks : blocks;
  const candidates = [];
  const seen = new Set();
  const add = (index) => {
    if (index < 0 || index >= sourceBlocks.length || seen.has(index)) return;
    seen.add(index);
    candidates.push(sourceBlocks[index]);
  };
  for (let index = 0; index < Math.min(2, sourceBlocks.length); index += 1) add(index);
  evenIndices(sourceBlocks.length, 6).forEach(add);
  for (
    let index = Math.max(0, sourceBlocks.length - 2);
    index < sourceBlocks.length;
    index += 1
  ) {
    add(index);
  }

  let chars = 0;
  const selected = [];
  for (const block of candidates) {
    if (
      selected.length >= MAX_FALLBACK_REFERENCES
      || chars >= MAX_FALLBACK_CONTENT_CHARS
    ) {
      break;
    }
    const content = block.source.slice(
      0,
      Math.min(MAX_FALLBACK_BLOCK_CHARS, MAX_FALLBACK_CONTENT_CHARS - chars),
    );
    if (!content) continue;
    chars += content.length;
    selected.push({
      ...block,
      start_offset: 0,
      end_offset: content.length,
      content,
      context_before: "",
      context_after: "",
    });
  }
  return selected;
}

function normalizeReference(reference, document) {
  if (reference == null) return selectedFallbackBlocks(document.blocks);
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw inputError("reference 必须是对象或 null");
  }
  if (reference.document_revision !== document.revision) {
    throw new ReadingChatGeneratorError(
      "READING_CHAT_DOCUMENT_CHANGED",
      "论文正文已经变化，请重新选择原文",
      409,
    );
  }
  if (Array.isArray(reference.block_ids)) {
    if (reference.block_ids.length === 0 || reference.block_ids.length > 500) {
      throw inputError("reference.block_ids 数量无效");
    }
    const wanted = new Set();
    for (const id of reference.block_ids) {
      if (!BLOCK_ID_PATTERN.test(String(id ?? ""))) {
        throw inputError("reference.block_ids 含无效 block_id");
      }
      wanted.add(id);
    }
    const sectionBlocks = document.blocks.filter((block) => wanted.has(block.block_id));
    if (sectionBlocks.length === 0) {
      throw new ReadingChatGeneratorError(
        "READING_CHAT_BLOCK_NOT_FOUND",
        "引用的章节段落不存在",
        400,
      );
    }
    return selectedFallbackBlocks(sectionBlocks);
  }
  if (!BLOCK_ID_PATTERN.test(String(reference.block_id ?? ""))) {
    throw inputError("reference.block_id 格式无效");
  }
  const block = document.blocks.find((item) => item.block_id === reference.block_id);
  if (!block) {
    throw new ReadingChatGeneratorError(
      "READING_CHAT_BLOCK_NOT_FOUND",
      "引用的原文段落不存在",
      400,
    );
  }
  const start = reference.start_offset;
  const end = reference.end_offset;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || end > block.source.length
    || end - start > MAX_SELECTION_CHARS
  ) {
    throw inputError("reference 的 UTF-16 范围无效或超过长度限制");
  }
  return [{
    ...block,
    start_offset: start,
    end_offset: end,
    content: block.source.slice(start, end),
    context_before: block.source.slice(Math.max(0, start - MAX_CONTEXT_SIDE_CHARS), start),
    context_after: block.source.slice(end, end + MAX_CONTEXT_SIDE_CHARS),
  }];
}

function normalizeHistory(recentTurns) {
  if (recentTurns == null) return [];
  if (!Array.isArray(recentTurns)) throw inputError("recentTurns 必须是数组");
  const selected = recentTurns.slice(-MAX_HISTORY_TURNS);
  const normalized = [];
  let chars = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const turn = selected[index];
    const question = compact(turn?.question, MAX_QUESTION_CHARS);
    const answer = compact(turn?.answer, 3_000);
    if (!question || !answer) continue;
    const remaining = MAX_HISTORY_CHARS - chars;
    if (remaining <= 0) break;
    const boundedAnswer = answer.slice(0, Math.max(0, remaining - question.length));
    if (!boundedAnswer) continue;
    chars += question.length + boundedAnswer.length;
    normalized.unshift({ question, answer: boundedAnswer });
  }
  return normalized;
}

function normalizeProjectContext(projectContext, requested) {
  if (!requested) return null;
  if (!projectContext) return { status: "unavailable" };
  if (
    typeof projectContext !== "object"
    || Array.isArray(projectContext)
  ) {
    throw inputError("projectContext 格式无效");
  }
  const content = typeof projectContext.content === "string"
    ? projectContext.content.trim().slice(0, MAX_PROJECT_CONTEXT_CHARS)
    : "";
  if (!content) throw inputError("projectContext.content 必须是非空字符串");
  return {
    status: "available",
    source_path: requiredString(
      projectContext.source_path,
      "projectContext.source_path",
      800,
    ),
    revision: requiredString(projectContext.revision, "projectContext.revision", 160),
    content,
  };
}

function normalizedReferences(references) {
  return references.map((reference, index) => ({
    reference_id: `reference-${index + 1}`,
    block_id: reference.block_id,
    path: reference.path,
    ordinal: reference.ordinal,
    kind: reference.kind,
    start_offset: reference.start_offset,
    end_offset: reference.end_offset,
    content: reference.content,
    context_before: reference.context_before,
    context_after: reference.context_after,
  }));
}

function validateOutput(value, paperId, allowedReferenceIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw outputError("模型没有返回论文对话对象");
  }
  const keys = Object.keys(value).sort();
  const expected = [...OUTPUT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw outputError("模型返回的论文对话栏目不符合固定合同");
  }
  if (value.paper_id !== paperId) throw outputError("模型返回了错误的论文 ID");
  if (typeof value.answer !== "string") throw outputError("answer 必须是字符串");
  const answer = value.answer.trim();
  if (answer.length < 2 || answer.length > 6_000) {
    throw outputError("answer 长度不符合论文对话合同");
  }
  if (!Array.isArray(value.citations) || value.citations.length > 8) {
    throw outputError("citations 不符合论文对话合同");
  }
  const seen = new Set();
  const citations = value.citations.map((citation) => {
    if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
      throw outputError("citation 格式无效");
    }
    const citationKeys = Object.keys(citation).sort();
    if (
      citationKeys.length !== 2
      || citationKeys[0] !== "reference_id"
      || citationKeys[1] !== "support"
    ) {
      throw outputError("citation 只能包含 reference_id 和 support");
    }
    if (
      typeof citation.reference_id !== "string"
      || !allowedReferenceIds.has(citation.reference_id)
      || seen.has(citation.reference_id)
    ) {
      throw outputError("citation.reference_id 必须是唯一的允许引用");
    }
    if (
      typeof citation.support !== "string"
      || citation.support.trim().length < 2
      || citation.support.trim().length > 300
    ) {
      throw outputError("citation.support 长度无效");
    }
    seen.add(citation.reference_id);
    return {
      reference_id: citation.reference_id,
      support: citation.support.trim(),
    };
  });
  return { paper_id: paperId, answer, citations };
}

export function prepareReadingChatMessage({
  paper,
  document,
  question,
  reference = null,
  recentTurns = [],
  projectContext = null,
  projectContextRequested = false,
  providerId,
  modelId,
  promptRegistry = defaultPromptRegistry,
} = {}) {
  const normalizedPaper = normalizePaper(paper);
  const normalizedDocument = normalizeDocument(document);
  const normalizedQuestion = requiredString(question, "question", MAX_QUESTION_CHARS);
  const references = normalizedReferences(normalizeReference(reference, normalizedDocument));
  const history = normalizeHistory(recentTurns);
  const normalizedProjectContext = normalizeProjectContext(
    projectContext,
    projectContextRequested,
  );
  const prompt = promptRegistry.loadPrompt(PROMPT_ID);
  const input = {
    paper: normalizedPaper,
    document_revision: normalizedDocument.revision,
    question: normalizedQuestion,
    references,
    recent_turns: history,
    ...(normalizedProjectContext ? { project_context: normalizedProjectContext } : {}),
    reference_contract: {
      citations_must_match_reference_id: true,
      allowed_reference_ids: references.map((item) => item.reference_id),
    },
  };
  const inputHash = promptRegistry.createInputHash({
    promptId: PROMPT_ID,
    input,
    modelSettings: {
      provider_id: providerId ?? null,
      model_id: modelId ?? null,
    },
  });
  return {
    paper: normalizedPaper,
    documentRevision: normalizedDocument.revision,
    question: normalizedQuestion,
    references,
    recentTurns: history,
    projectContext: normalizedProjectContext,
    prompt,
    input,
    inputHash,
  };
}

export async function generateReadingChatMessage({
  prepared,
  paper,
  document,
  question,
  reference = null,
  recentTurns = [],
  projectContext = null,
  projectContextRequested = false,
  providerId,
  modelId,
  modelProviders,
  modelMode = "live",
  promptRegistry = defaultPromptRegistry,
} = {}) {
  const request = prepared ?? prepareReadingChatMessage({
    paper,
    document,
    question,
    reference,
    recentTurns,
    projectContext,
    projectContextRequested,
    providerId,
    modelId,
    promptRegistry,
  });
  const allowedReferenceIds = new Set(request.references.map((item) => item.reference_id));
  const audit = {
    prompt_id: request.prompt.id,
    prompt_version: request.prompt.version,
    prompt_hash: request.prompt.prompt_hash,
    input_hash: request.inputHash,
    input_reference_count: request.references.length,
    input_chars: JSON.stringify(request.input).length,
    document_revision: request.documentRevision,
    project_context_revision: request.projectContext?.status === "available"
      ? request.projectContext.revision
      : null,
    project_context_source_path: request.projectContext?.status === "available"
      ? request.projectContext.source_path
      : null,
    project_context_requested: Boolean(request.projectContext),
    project_context_status: request.projectContext?.status ?? "not_requested",
  };
  if (modelMode !== "live") {
    const first = request.references[0] ?? null;
    return {
      result: {
        paper_id: request.paper.paper_id,
        answer: first
          ? `这段内容的核心意思是：${compact(first.content, 500)}`
          : "当前没有足够的论文证据，仍需选择原文后核验。",
        citations: first ? [{
          reference_id: first.reference_id,
          support: "该引用是当前回答所依据的论文原文。",
        }] : [],
      },
      references: request.references,
      source: "fixture",
      ...audit,
      provider_id: null,
      model_id: null,
      operation_id: null,
      upstream_request_id: null,
      usage: null,
    };
  }
  if (!modelProviders?.completeStructured) {
    throw new ReadingChatGeneratorError(
      "MODEL_PROVIDER_REQUIRED",
      "实时论文对话需要模型服务",
      500,
    );
  }
  const generated = await modelProviders.completeStructured({
    providerId,
    modelId,
    system: request.prompt.system,
    prompt: request.prompt.body,
    input: request.input,
    schema: request.prompt.schema,
  });
  return {
    result: validateOutput(
      generated.value,
      request.paper.paper_id,
      allowedReferenceIds,
    ),
    references: request.references,
    source: "model",
    ...audit,
    provider_id: generated.provider_id ?? providerId,
    model_id: generated.model_id ?? modelId,
    operation_id: generated.operation_id ?? null,
    upstream_request_id: generated.upstream_request_id ?? null,
    usage: generated.usage ?? null,
  };
}
