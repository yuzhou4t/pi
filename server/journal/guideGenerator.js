import { promptRegistry as defaultPromptRegistry } from "../promptRegistry.js";

const PROMPT_ID = "five-minute-guide";
const MAX_SOURCE_SECTIONS = 5_000;
const MAX_SOURCE_BLOCKS = 20_000;
const MAX_SELECTED_BLOCKS = 36;
const MAX_BLOCK_CHARS = 1_200;
const MAX_CONTENT_CHARS = 28_000;
const BLOCK_ID_PATTERN = /^block-[a-f0-9]{20}$/;
const HAN_PATTERN = /\p{Script=Han}/u;

const GUIDE_FIELDS = [
  "paper_id",
  "problem",
  "why_read",
  "intuition",
  "evidence",
  "limitations",
  "questions",
  "evidence_refs",
];

export class GuideGeneratorError extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message);
    this.name = "GuideGeneratorError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function inputError(message) {
  return new GuideGeneratorError("GUIDE_INPUT_INVALID", message);
}

function outputError(message) {
  return new GuideGeneratorError("GUIDE_OUTPUT_INVALID", message, 502, true);
}

function compact(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ").slice(0, maxLength);
}

function requiredInputString(value, field, maxLength) {
  const normalized = compact(value, maxLength + 1);
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
    paper_id: requiredInputString(paper.paper_id, "paper.paper_id", 200),
    title: requiredInputString(paper.title, "paper.title", 500),
    authors: Array.isArray(paper.authors)
      ? paper.authors.slice(0, 10).map((author) => compact(author, 160)).filter(Boolean)
      : [],
    venue: compact(paper.venue, 200),
    published_at: compact(paper.published_at, 40),
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

function normalizeDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw inputError("document 必须是对象");
  }
  if (
    !Array.isArray(document.sections)
    || document.sections.length > MAX_SOURCE_SECTIONS
    || !Array.isArray(document.blocks)
    || document.blocks.length === 0
    || document.blocks.length > MAX_SOURCE_BLOCKS
  ) {
    throw inputError("document 的 sections 或 blocks 超出合同");
  }

  const sectionPaths = new Map();
  for (const section of document.sections) {
    const sectionId = compact(section?.section_id, 160);
    if (!sectionId || sectionPaths.has(sectionId)) {
      throw inputError("document 包含无效或重复的 section_id");
    }
    const path = Array.isArray(section.path)
      ? section.path.slice(0, 8).map((part) => compact(part, 160)).filter(Boolean)
      : [];
    sectionPaths.set(sectionId, path);
  }

  const blockIds = new Set();
  const blocks = [];
  for (const block of document.blocks) {
    const blockId = compact(block?.block_id, 160);
    const sectionId = compact(block?.section_id, 160);
    if (!BLOCK_ID_PATTERN.test(blockId) || blockIds.has(blockId) || !sectionPaths.has(sectionId)) {
      throw inputError("document 包含无效、重复或无章节归属的 block_id");
    }
    blockIds.add(blockId);
    const source = typeof block.markdown === "string" && block.markdown.trim()
      ? block.markdown.trim()
      : typeof block.text === "string"
        ? block.text.trim()
        : "";
    if (!source) continue;
    blocks.push({
      block_id: blockId,
      section_id: sectionId,
      section_path: Array.isArray(block.path)
        ? block.path.slice(0, 8).map((part) => compact(part, 160)).filter(Boolean)
        : sectionPaths.get(sectionId),
      kind: compact(block.kind, 30) || "text",
      source,
    });
  }
  if (blocks.length === 0) throw inputError("document 没有可用于导读的正文块");

  const firstBySection = new Map();
  blocks.forEach((block, index) => {
    if (!firstBySection.has(block.section_id)) firstBySection.set(block.section_id, index);
  });
  const candidates = [];
  const seen = new Set();
  const add = (index) => {
    if (index < 0 || index >= blocks.length || seen.has(index)) return;
    seen.add(index);
    candidates.push(index);
  };
  for (let index = 0; index < Math.min(4, blocks.length); index += 1) add(index);
  for (let index = Math.max(0, blocks.length - 4); index < blocks.length; index += 1) add(index);
  evenIndices(blocks.length, 20).forEach(add);
  const sectionStarts = [...firstBySection.values()];
  evenIndices(sectionStarts.length, 8).forEach((index) => add(sectionStarts[index]));
  evenIndices(blocks.length, MAX_SELECTED_BLOCKS).forEach(add);

  let contentChars = 0;
  const selected = [];
  for (const index of candidates) {
    if (selected.length >= MAX_SELECTED_BLOCKS || contentChars >= MAX_CONTENT_CHARS) break;
    const block = blocks[index];
    const remaining = MAX_CONTENT_CHARS - contentChars;
    const content = block.source.slice(0, Math.min(MAX_BLOCK_CHARS, remaining));
    if (!content) continue;
    contentChars += content.length;
    selected.push({
      block_id: block.block_id,
      section_path: block.section_path,
      kind: block.kind,
      content,
      truncated: content.length < block.source.length,
      source_index: index,
    });
  }
  selected.sort((left, right) => left.source_index - right.source_index);
  return {
    title: compact(document.title, 500),
    blocks: selected.map(({ source_index, ...block }) => block),
  };
}

function guideInput(paper, document) {
  return {
    paper,
    document: {
      title: document.title || paper.title,
      page_mapping_available: false,
      blocks: document.blocks,
    },
    reference_contract: {
      evidence_refs_must_match_block_id: true,
      allowed_block_ids: document.blocks.map((block) => block.block_id),
    },
  };
}

function fieldBlock(blocks, pattern, fallbackIndex) {
  const contentBlocks = blocks.filter((block) => block.kind !== "heading");
  return contentBlocks.find((block) => pattern.test(
    `${block.section_path.join(" ")} ${block.content.slice(0, 160)}`,
  )) ?? contentBlocks[fallbackIndex] ?? blocks[0];
}

function fixtureGuide(paper, blocks) {
  const problemBlock = fieldBlock(
    blocks,
    /abstract|introduction|background|摘要|引言|背景/i,
    0,
  );
  const methodBlock = fieldBlock(
    blocks,
    /method|approach|framework|architecture|方法|机制|框架|模型/i,
    Math.floor(blocks.length / 3),
  );
  const evidenceBlock = fieldBlock(
    blocks,
    /experiment|result|evaluation|evidence|实验|结果|评估|证据/i,
    Math.floor(blocks.length * 2 / 3),
  );
  const limitationBlock = fieldBlock(
    blocks,
    /limitation|discussion|conclusion|局限|讨论|结论/i,
    blocks.length - 1,
  );
  const evidenceRefs = [...new Set([
    problemBlock?.block_id,
    methodBlock?.block_id,
    evidenceBlock?.block_id,
    limitationBlock?.block_id,
  ].filter(Boolean))].slice(0, 8);

  return {
    paper_id: paper.paper_id,
    problem: `论文《${paper.title}》聚焦的核心研究问题，需要结合摘要与引言原文逐项核验。`,
    why_read: "可先核验研究问题、方法机制与主要证据，再决定是否进入分阶段精读。",
    intuition: "方法章节给出了核心机制；具体步骤、关键假设与实现边界仍需回到引用原文核验。",
    evidence: "实验与结果章节提供了主要证据；比较基线、指标和结果范围仍需回到引用原文核验。",
    limitations: "当前导读只整理已解析正文，论文报告的局限、失败案例与适用边界仍需回到原文核验。",
    questions: [
      "作者如何把研究问题转化为可检验的方法与假设？",
      "主要证据是否足以支持核心主张，哪些结果仍待核验？",
      "论文明确报告了哪些适用边界、失败案例或局限？",
    ],
    evidence_refs: evidenceRefs.length > 0 ? evidenceRefs : [blocks[0].block_id],
  };
}

function outputString(value, field, minimum, maximum) {
  if (typeof value !== "string") throw outputError(`${field} 必须是字符串`);
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  if (normalized.length < minimum) {
    throw outputError(`${field} 长度不符合导读合同`);
  }
  return normalized.slice(0, maximum).trimEnd();
}

function outputChineseString(value, field, minimum, maximum) {
  const normalized = outputString(value, field, minimum, maximum);
  if (!HAN_PATTERN.test(normalized)) {
    throw outputError(`${field} 必须使用简体中文，可保留必要的英文术语`);
  }
  return normalized;
}

function outputReference(value) {
  if (typeof value !== "string") throw outputError("evidence_refs 必须是字符串");
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) {
    throw outputError("evidence_refs 长度不符合导读合同");
  }
  return normalized;
}

function validateGuide(value, paperId, allowedBlockIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw outputError("模型没有返回导读对象");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== GUIDE_FIELDS.length || keys.some((key, index) => (
    key !== [...GUIDE_FIELDS].sort()[index]
  ))) {
    throw outputError("模型返回的导读栏目不符合固定合同");
  }
  if (value.paper_id !== paperId) throw outputError("模型返回了错误的论文 ID");
  if (
    !Array.isArray(value.questions)
    || value.questions.length < 2
    || value.questions.length > 3
  ) {
    throw outputError("questions 不符合导读合同");
  }
  const questions = value.questions.map((question) => (
    outputChineseString(question, "questions", 2, 180)
  ));
  if (
    !Array.isArray(value.evidence_refs)
    || value.evidence_refs.length === 0
    || value.evidence_refs.length > 8
  ) {
    throw outputError("导读必须包含 1 至 8 个证据引用");
  }
  const seenRefs = new Set();
  const evidenceRefs = value.evidence_refs.map((reference) => {
    const normalized = outputReference(reference);
    if (!allowedBlockIds.has(normalized) || seenRefs.has(normalized)) {
      throw outputError("evidence_refs 必须是本次输入中唯一的 block_id");
    }
    seenRefs.add(normalized);
    return normalized;
  });
  return {
    paper_id: paperId,
    problem: outputChineseString(value.problem, "problem", 4, 500),
    why_read: outputChineseString(value.why_read, "why_read", 4, 300),
    intuition: outputChineseString(value.intuition, "intuition", 4, 600),
    evidence: outputChineseString(value.evidence, "evidence", 4, 600),
    limitations: outputChineseString(value.limitations, "limitations", 4, 400),
    questions,
    evidence_refs: evidenceRefs,
  };
}

export async function generateFiveMinuteGuide({
  paper,
  document,
  projectContext,
  providerId,
  modelId,
  modelProviders,
  modelMode = "live",
  promptRegistry = defaultPromptRegistry,
} = {}) {
  const normalizedPaper = normalizePaper(paper);
  const normalizedDocument = normalizeDocument(document);
  const prompt = promptRegistry.loadPrompt(PROMPT_ID);
  const input = guideInput(normalizedPaper, normalizedDocument);
  const inputHash = promptRegistry.createInputHash({
    promptId: PROMPT_ID,
    input,
    modelSettings: {
      provider_id: providerId ?? null,
      model_id: modelId ?? null,
    },
  });
  const audit = {
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    input_hash: inputHash,
    input_block_count: normalizedDocument.blocks.length,
    input_chars: JSON.stringify(input).length,
  };

  // The paper-only guide deliberately excludes project context.
  void projectContext;

  if (modelMode !== "live") {
    const guide = validateGuide(
      fixtureGuide(normalizedPaper, normalizedDocument.blocks),
      normalizedPaper.paper_id,
      new Set(normalizedDocument.blocks.map((block) => block.block_id)),
    );
    return {
      guide,
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
    throw new GuideGeneratorError(
      "MODEL_PROVIDER_REQUIRED",
      "实时导读需要模型服务",
      500,
    );
  }
  const generated = await modelProviders.completeStructured({
    providerId,
    modelId,
    system: prompt.system,
    prompt: prompt.body,
    input,
    schema: prompt.schema,
  });
  const guide = validateGuide(
    generated.value,
    normalizedPaper.paper_id,
    new Set(normalizedDocument.blocks.map((block) => block.block_id)),
  );
  return {
    guide,
    source: "model",
    ...audit,
    provider_id: generated.provider_id ?? providerId,
    model_id: generated.model_id ?? modelId,
    operation_id: generated.operation_id ?? null,
    upstream_request_id: generated.upstream_request_id ?? null,
    usage: generated.usage ?? null,
  };
}
