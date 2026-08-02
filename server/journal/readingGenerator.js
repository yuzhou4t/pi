import { promptRegistry as defaultPromptRegistry } from "../promptRegistry.js";

export const READING_STAGE_ORDER = Object.freeze([
  "research-question",
  "method",
  "evidence",
  "project-relation",
]);

const BLOCK_ID_PATTERN = /^block-[a-f0-9]{20}$/;
const MAX_SOURCE_BLOCKS = 20_000;
const MAX_SELECTED_BLOCKS = 24;
const MAX_BLOCK_CHARS = 1_200;
const MAX_CONTENT_CHARS = 18_000;
const MAX_PROJECT_CONTEXT_CHARS = 12_000;
const MAX_INTERVENTIONS_PER_STAGE = 2;
const MAX_INTERVENTION_QUESTION_CHARS = 500;
const MAX_INTERVENTION_ANSWER_CHARS = 1_000;
const MAX_INTERVENTION_EVIDENCE = 3;
const OUTPUT_FIELDS = ["paper_id", "stage", "answer", "evidence", "open_questions"];

const STAGE_PATTERNS = {
  "research-question": /abstract|introduction|background|related work|motivation|problem|contribution|摘要|引言|背景|相关工作|动机|问题|贡献/i,
  method: /method|approach|framework|architecture|workflow|planning|algorithm|implementation|model|方法|机制|框架|架构|工作流|规划|算法|实现|模型/i,
  evidence: /experiment|evaluation|result|ablation|analysis|benchmark|dataset|metric|discussion|limitation|conclusion|实验|评估|结果|消融|分析|基准|数据集|指标|讨论|局限|结论/i,
  "project-relation": /abstract|introduction|method|framework|experiment|result|discussion|limitation|conclusion|摘要|引言|方法|框架|实验|结果|讨论|局限|结论/i,
};

export class ReadingGeneratorError extends Error {
  constructor(code, message, status = 400, retryable = false) {
    super(message);
    this.name = "ReadingGeneratorError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function inputError(message) {
  return new ReadingGeneratorError("READING_INPUT_INVALID", message);
}

function outputError(message) {
  return new ReadingGeneratorError("READING_OUTPUT_INVALID", message, 502, true);
}

function compact(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ").slice(0, maxLength);
}

function requiredString(value, field, maxLength) {
  const normalized = compact(value, maxLength + 1);
  if (!normalized || normalized.length > maxLength) {
    throw inputError(`${field} 必须是长度不超过 ${maxLength} 的非空字符串`);
  }
  return normalized;
}

function boundedString(value, field, maxLength) {
  const normalized = compact(value, maxLength);
  if (!normalized) {
    throw inputError(`${field} 必须是非空字符串`);
  }
  return normalized;
}

function normalizeStage(stage) {
  if (!READING_STAGE_ORDER.includes(stage)) {
    throw inputError("stage 不在固定精读阶段中");
  }
  return stage;
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

function evenIndices(length, count) {
  if (length <= 0 || count <= 0) return [];
  if (length === 1 || count === 1) return [0];
  const size = Math.min(length, count);
  return Array.from(
    { length: size },
    (_, index) => Math.round(index * (length - 1) / (size - 1)),
  );
}

function normalizeDocument(document, stage, focusBlockIds = []) {
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

  const seen = new Set();
  const blocks = document.blocks.map((block, index) => {
    const blockId = compact(block?.block_id, 160);
    if (!BLOCK_ID_PATTERN.test(blockId) || seen.has(blockId)) {
      throw inputError("document 包含无效或重复的 block_id");
    }
    seen.add(blockId);
    const source = typeof block.markdown === "string" && block.markdown.trim()
      ? block.markdown.trim()
      : typeof block.text === "string"
        ? block.text.trim()
        : "";
    const sectionPath = Array.isArray(block.path)
      ? block.path.slice(0, 8).map((part) => compact(part, 160)).filter(Boolean)
      : [];
    return {
      block_id: blockId,
      section_path: sectionPath,
      kind: compact(block.kind, 30) || "text",
      source,
      source_index: index,
    };
  }).filter((block) => block.source && block.kind !== "heading");

  if (blocks.length === 0) throw inputError("document 没有可用于精读的正文块");

  const pattern = STAGE_PATTERNS[stage];
  const matched = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => pattern.test(`${block.section_path.join(" ")} ${block.source.slice(0, 200)}`))
    .map(({ index }) => index);
  const candidateIndices = [];
  const selectedIndices = new Set();
  const add = (index) => {
    if (index < 0 || index >= blocks.length || selectedIndices.has(index)) return;
    selectedIndices.add(index);
    candidateIndices.push(index);
  };

  if (
    !Array.isArray(focusBlockIds)
    || focusBlockIds.length > 12
    || focusBlockIds.some((blockId) => !BLOCK_ID_PATTERN.test(String(blockId ?? "")))
  ) {
    throw inputError("focusBlockIds 格式无效");
  }
  for (const blockId of focusBlockIds) {
    const index = blocks.findIndex((block) => block.block_id === blockId);
    if (index < 0) throw inputError("focusBlockIds 包含当前正文不存在的 block_id");
    add(index);
  }
  evenIndices(matched.length, 16).forEach((index) => add(matched[index]));
  for (let index = 0; index < Math.min(3, blocks.length); index += 1) add(index);
  evenIndices(blocks.length, 8).forEach(add);
  for (let index = Math.max(0, blocks.length - 3); index < blocks.length; index += 1) add(index);

  let contentChars = 0;
  const selected = [];
  for (const index of candidateIndices) {
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
      source_index: block.source_index,
    });
  }
  selected.sort((left, right) => left.source_index - right.source_index);
  return {
    title: compact(document.title, 500),
    revision: requiredString(document.revision, "document.revision", 160),
    blocks: selected.map(({ source_index, ...block }) => block),
  };
}

function normalizePreviousStages(previousStages) {
  if (previousStages == null) return [];
  if (!Array.isArray(previousStages) || previousStages.length > 3) {
    throw inputError("previousStages 格式无效");
  }
  return previousStages.map((value) => {
    const stage = normalizeStage(value?.stage);
    return {
      stage,
      answer: requiredString(value?.answer, `previousStages.${stage}.answer`, 1_800),
      evidence: Array.isArray(value?.evidence)
        ? value.evidence.slice(0, 8).map((item) => ({
            locator: requiredString(item?.locator, "previousStages.evidence.locator", 160),
            support: requiredString(item?.support, "previousStages.evidence.support", 300),
          }))
        : [],
      open_questions: Array.isArray(value?.open_questions)
        ? value.open_questions.slice(0, 5).map((item) => compact(item, 240)).filter(Boolean)
        : [],
      interventions: Array.isArray(value?.interventions)
        ? value.interventions.slice(-MAX_INTERVENTIONS_PER_STAGE).map((item) => ({
            question: boundedString(
              item?.question,
              "previousStages.interventions.question",
              MAX_INTERVENTION_QUESTION_CHARS,
            ),
            answer: boundedString(
              item?.answer,
              "previousStages.interventions.answer",
              MAX_INTERVENTION_ANSWER_CHARS,
            ),
            evidence: Array.isArray(item?.evidence)
              ? item.evidence.slice(0, MAX_INTERVENTION_EVIDENCE).map((evidenceItem) => ({
                  locator: requiredString(
                    evidenceItem?.locator,
                    "previousStages.interventions.evidence.locator",
                    160,
                  ),
                  support: boundedString(
                    evidenceItem?.support,
                    "previousStages.interventions.evidence.support",
                    300,
                  ),
                }))
              : [],
          }))
        : [],
    };
  });
}

function normalizeProjectContext(projectContext, stage) {
  if (stage !== "project-relation") return null;
  if (!projectContext || typeof projectContext !== "object" || Array.isArray(projectContext)) {
    throw inputError("项目关系阶段需要有限项目状态");
  }
  return {
    source_path: requiredString(projectContext.source_path, "projectContext.source_path", 800),
    revision: requiredString(projectContext.revision, "projectContext.revision", 160),
    content: requiredString(
      projectContext.content,
      "projectContext.content",
      MAX_PROJECT_CONTEXT_CHARS,
    ),
  };
}

function stageInput({
  paper,
  stage,
  document,
  previousStages,
  projectContext,
  question = null,
  currentStage = null,
  focusBlockIds = [],
}) {
  return {
    paper,
    stage,
    document: {
      title: document.title || paper.title,
      revision: document.revision,
      page_mapping_available: false,
      blocks: document.blocks,
    },
    previous_stages: previousStages,
    ...(projectContext ? { project_context: projectContext } : {}),
    ...(question ? {
      follow_up: {
        question,
        current_stage: currentStage,
        focus_block_ids: focusBlockIds,
      },
    } : {}),
    reference_contract: {
      evidence_locators_must_match_block_id: true,
      allowed_block_ids: document.blocks.map((block) => block.block_id),
    },
  };
}

function fixtureResult(paper, stage, blocks, projectContext, question) {
  const selected = blocks.slice(0, Math.min(3, blocks.length));
  const evidence = selected.map((block, index) => ({
    locator: block.block_id,
    support: `该原文块用于核验${index === 0 ? "核心判断" : "补充判断"}。`,
  }));
  const excerpt = compact(selected[0]?.content, 420);
  const prefix = question
    ? `针对追问“${compact(question, 120)}”，`
    : "";
  const answers = {
    "research-question": `${prefix}当前证据显示，论文围绕既有方法留下的具体问题提出研究主张。原文要点为：${excerpt}`,
    method: `${prefix}方法的核心信息流需要从输入、关键步骤和输出三个层次理解。当前原文要点为：${excerpt}`,
    evidence: `${prefix}实验是否支持主张取决于数据、基线、指标和消融是否完整。当前原文要点为：${excerpt}`,
    "project-relation": `${prefix}这篇论文最值得迁移的是用可核验证据约束工作流判断。结合有限项目状态“${compact(projectContext?.content, 180)}”，具体项目影响仍应作为候选结论等待用户确认。`,
  };
  return {
    paper_id: paper.paper_id,
    stage,
    answer: answers[stage],
    evidence,
    open_questions: ["还需要核验输入中未覆盖的图表、附录或失败案例。"],
  };
}

function outputString(value, field, minimum, maximum) {
  if (typeof value !== "string") throw outputError(`${field} 必须是字符串`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw outputError(`${field} 长度不符合精读合同`);
  }
  return normalized;
}

function validateResult(value, paperId, stage, allowedBlockIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw outputError("模型没有返回精读对象");
  }
  const keys = Object.keys(value).sort();
  const expected = [...OUTPUT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw outputError("模型返回的精读栏目不符合固定合同");
  }
  if (value.paper_id !== paperId) throw outputError("模型返回了错误的论文 ID");
  if (value.stage !== stage) throw outputError("模型返回了错误的精读阶段");
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 8) {
    throw outputError("精读结果必须包含 1 至 8 条证据");
  }
  const seen = new Set();
  const evidence = value.evidence.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw outputError("evidence 项格式无效");
    }
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.length !== 2 || itemKeys[0] !== "locator" || itemKeys[1] !== "support") {
      throw outputError("evidence 项必须只包含 locator 和 support");
    }
    const locator = outputString(item.locator, "evidence.locator", 1, 160);
    if (!allowedBlockIds.has(locator) || seen.has(locator)) {
      throw outputError("evidence.locator 必须是本次输入中唯一的 block_id");
    }
    seen.add(locator);
    return {
      locator,
      support: outputString(item.support, "evidence.support", 2, 300),
    };
  });
  if (!Array.isArray(value.open_questions) || value.open_questions.length > 5) {
    throw outputError("open_questions 不符合精读合同");
  }
  return {
    paper_id: paperId,
    stage,
    answer: outputString(value.answer, "answer", 8, 1_800),
    evidence,
    open_questions: value.open_questions.map(
      (item) => outputString(item, "open_questions", 2, 240),
    ),
  };
}

async function generate({
  promptId,
  paper,
  stage,
  document,
  previousStages,
  projectContext,
  question,
  currentStage,
  focusBlockIds,
  providerId,
  modelId,
  modelProviders,
  modelMode,
  promptRegistry,
}) {
  const normalizedStage = normalizeStage(stage);
  const normalizedPaper = normalizePaper(paper);
  const normalizedFocusBlockIds = [
    ...(Array.isArray(focusBlockIds) ? focusBlockIds : focusBlockIds == null ? [] : [focusBlockIds]),
    ...(Array.isArray(currentStage?.evidence)
      ? currentStage.evidence.map((item) => item?.locator).filter(Boolean)
      : []),
  ].filter((blockId, index, values) => values.indexOf(blockId) === index);
  const normalizedDocument = normalizeDocument(document, normalizedStage, normalizedFocusBlockIds);
  const normalizedPreviousStages = normalizePreviousStages(previousStages);
  const normalizedProjectContext = normalizeProjectContext(projectContext, normalizedStage);
  const normalizedQuestion = question == null
    ? null
    : requiredString(question, "question", 1_000);
  const normalizedCurrentStage = currentStage == null
    ? null
    : validateResult(
        currentStage,
        normalizedPaper.paper_id,
        normalizedStage,
        new Set(normalizedDocument.blocks.map((block) => block.block_id)),
      );
  const prompt = promptRegistry.loadPrompt(promptId);
  const input = stageInput({
    paper: normalizedPaper,
    stage: normalizedStage,
    document: normalizedDocument,
    previousStages: normalizedPreviousStages,
    projectContext: normalizedProjectContext,
    question: normalizedQuestion,
    currentStage: normalizedCurrentStage,
    focusBlockIds: normalizedFocusBlockIds,
  });
  const inputHash = promptRegistry.createInputHash({
    promptId,
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
    document_revision: normalizedDocument.revision,
    project_context_revision: normalizedProjectContext?.revision ?? null,
  };
  const allowedBlockIds = new Set(normalizedDocument.blocks.map((block) => block.block_id));

  if (modelMode !== "live") {
    return {
      result: validateResult(
        fixtureResult(
          normalizedPaper,
          normalizedStage,
          normalizedDocument.blocks,
          normalizedProjectContext,
          normalizedQuestion,
        ),
        normalizedPaper.paper_id,
        normalizedStage,
        allowedBlockIds,
      ),
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
    throw new ReadingGeneratorError(
      "MODEL_PROVIDER_REQUIRED",
      "实时精读需要模型服务",
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
  return {
    result: validateResult(
      generated.value,
      normalizedPaper.paper_id,
      normalizedStage,
      allowedBlockIds,
    ),
    source: "model",
    ...audit,
    provider_id: generated.provider_id ?? providerId,
    model_id: generated.model_id ?? modelId,
    operation_id: generated.operation_id ?? null,
    upstream_request_id: generated.upstream_request_id ?? null,
    usage: generated.usage ?? null,
  };
}

export function generateReadingStage(options = {}) {
  return generate({
    ...options,
    promptId: options.stage,
    modelMode: options.modelMode ?? "live",
    promptRegistry: options.promptRegistry ?? defaultPromptRegistry,
    question: null,
    currentStage: null,
  });
}

export function generateReadingFollowUp(options = {}) {
  return generate({
    ...options,
    promptId: "reading-follow-up",
    modelMode: options.modelMode ?? "live",
    promptRegistry: options.promptRegistry ?? defaultPromptRegistry,
  });
}
