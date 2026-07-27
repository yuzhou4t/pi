import { promptRegistry as defaultPromptRegistry } from "../promptRegistry.js";

export const TRANSLATION_PROMPT_ID = "translation";
export const TRANSLATION_MODEL_PROFILE = Object.freeze({
  providerId: "codex-subscription",
  modelId: "gpt-5.3-codex-spark",
  reasoningEffort: "low",
});
const BLOCK_ID_PATTERN = /^block-[a-f0-9]{20}$/;
const MAX_BATCH_BLOCKS = 24;
const MAX_BATCH_CHARS = 12_000;
const MAX_BLOCK_CHARS = 6_000;
const HAN_PATTERN = /\p{Script=Han}/u;
const MATH_ONLY_PATTERN = /^\s*\$\$[\s\S]*\$\$\s*$/;
const URL_PATTERN = /https?:\/\/\S+/gi;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const SUP_TAG_PATTERN = /<sup>[^<]*<\/sup>/gi;

export class TranslationGeneratorError extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message);
    this.name = "TranslationGeneratorError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function inputError(message) {
  return new TranslationGeneratorError("TRANSLATION_INPUT_INVALID", message);
}

function outputError(message) {
  return new TranslationGeneratorError("TRANSLATION_OUTPUT_INVALID", message, 502, true);
}

function blockSource(block) {
  if (block?.kind === "table") {
    return String(block.markdown ?? block.text ?? "").trim();
  }
  return String(block?.text ?? block?.markdown ?? "").trim();
}

function allowsNonChinesePassthrough(source) {
  const supTags = source.match(SUP_TAG_PATTERN) ?? [];
  const withoutMarkup = source.replaceAll(/<[^>]+>/g, " ");
  const authorWords = withoutMarkup.match(/\b[A-Za-z][A-Za-z'-]*\b/g) ?? [];
  const authorLine = supTags.length >= 2
    && authorWords.length >= 2
    && !/\b(?:school|university|institute|department|laboratory|college)\b/i.test(withoutMarkup);
  if (authorLine) return true;

  if (!URL_PATTERN.test(source) && !EMAIL_PATTERN.test(source)) return false;
  URL_PATTERN.lastIndex = 0;
  EMAIL_PATTERN.lastIndex = 0;
  const labels = source
    .replace(URL_PATTERN, " ")
    .replace(EMAIL_PATTERN, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .match(/\b[A-Za-z][A-Za-z'-]*\b/g) ?? [];
  return labels.length <= 4;
}

export function isTranslatableBlock(block) {
  if (!block || block.kind === "image" || block.kind === "heading") return false;
  return Boolean(blockSource(block));
}

export function isMathOnlyBlock(block) {
  return MATH_ONLY_PATTERN.test(blockSource(block));
}

/**
 * Split the document's translatable, non-math blocks into bounded batches
 * that each fit one structured model call.
 */
export function translationBatches(blocks, alreadyTranslated = new Set()) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const block of blocks ?? []) {
    if (!isTranslatableBlock(block) || isMathOnlyBlock(block)) continue;
    if (alreadyTranslated.has(block.block_id)) continue;
    const source = blockSource(block).slice(0, MAX_BLOCK_CHARS);
    if (
      current.length >= MAX_BATCH_BLOCKS
      || (current.length > 0 && chars + source.length > MAX_BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push({ block_id: block.block_id, kind: block.kind ?? "text", source });
    chars += source.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function normalizeBatch(batch) {
  if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH_BLOCKS) {
    throw inputError("翻译批次必须包含 1 至 24 个正文块");
  }
  const seen = new Set();
  return batch.map((block) => {
    const blockId = String(block?.block_id ?? "");
    const source = String(block?.source ?? "").trim();
    if (!BLOCK_ID_PATTERN.test(blockId) || seen.has(blockId) || !source) {
      throw inputError("翻译批次包含无效、重复或空内容的 block_id");
    }
    seen.add(blockId);
    return {
      block_id: blockId,
      kind: String(block.kind ?? "text").slice(0, 30),
      source: source.slice(0, MAX_BLOCK_CHARS),
    };
  });
}

function validateOutput(value, paperId, batch) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw outputError("模型没有返回翻译对象");
  }
  if (value.paper_id !== paperId) throw outputError("模型返回了错误的论文 ID");
  if (!Array.isArray(value.blocks) || value.blocks.length !== batch.length) {
    throw outputError("翻译结果必须覆盖本批全部正文块");
  }
  const expected = new Map(batch.map((block) => [block.block_id, block]));
  const translations = {};
  for (const item of value.blocks) {
    const blockId = String(item?.block_id ?? "");
    const zh = typeof item?.zh === "string" ? item.zh.trim() : "";
    if (!expected.has(blockId) || blockId in translations) {
      throw outputError("翻译结果包含未知或重复的 block_id");
    }
    if (!zh || zh.length > 8_000) throw outputError("译文长度不符合翻译合同");
    if (!HAN_PATTERN.test(zh)) {
      // Allow pure symbol/formula passthrough only when the source itself has
      // no prose to translate. Author lists and link-only metadata likewise
      // stay faithful when the model preserves them verbatim.
      const source = expected.get(blockId).source;
      const letters = source.replaceAll(/[^a-zA-Z]/g, "");
      if (letters.length > 12 && !allowsNonChinesePassthrough(source)) {
        throw outputError("译文必须使用简体中文");
      }
    }
    translations[blockId] = zh;
  }
  return translations;
}

function fixtureTranslations(batch) {
  return Object.fromEntries(batch.map((block) => [
    block.block_id,
    `【示例译文】${block.source.slice(0, 400)}`,
  ]));
}

export async function translatePaperBatch({
  paperId,
  batch,
  providerId,
  modelId,
  reasoningEffort,
  modelProviders,
  modelMode = "live",
  promptRegistry = defaultPromptRegistry,
} = {}) {
  if (typeof paperId !== "string" || !paperId) throw inputError("paper_id 必须是非空字符串");
  const normalizedBatch = normalizeBatch(batch);
  const prompt = promptRegistry.loadPrompt(TRANSLATION_PROMPT_ID);
  const input = {
    paper_id: paperId,
    blocks: normalizedBatch,
  };
  const inputHash = promptRegistry.createInputHash({
    promptId: TRANSLATION_PROMPT_ID,
    input,
    modelSettings: {
      provider_id: providerId ?? null,
      model_id: modelId ?? null,
      reasoning_effort: reasoningEffort ?? null,
    },
  });
  const audit = {
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    input_hash: inputHash,
  };

  if (modelMode !== "live") {
    return {
      translations: fixtureTranslations(normalizedBatch),
      source: "fixture",
      ...audit,
      provider_id: providerId ?? null,
      model_id: modelId ?? null,
      reasoning_effort: reasoningEffort ?? null,
      usage: null,
    };
  }
  if (!modelProviders?.completeStructured) {
    throw new TranslationGeneratorError(
      "MODEL_PROVIDER_REQUIRED",
      "实时翻译需要模型服务",
      500,
    );
  }
  const generated = await modelProviders.completeStructured({
    providerId,
    modelId,
    reasoningEffort,
    system: prompt.system,
    prompt: prompt.body,
    input,
    schema: prompt.schema,
  });
  return {
    translations: validateOutput(generated.value, paperId, normalizedBatch),
    source: "model",
    ...audit,
    provider_id: generated.provider_id ?? providerId,
    model_id: generated.model_id ?? modelId,
    reasoning_effort: generated.reasoning_effort ?? reasoningEffort ?? null,
    usage: generated.usage ?? null,
  };
}
