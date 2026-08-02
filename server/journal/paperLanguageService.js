import { promptRegistry as defaultPromptRegistry } from "../promptRegistry.js";

export const PAPER_LANGUAGE_PROFILE = Object.freeze({
  providerId: "codex-subscription",
  modelId: "gpt-5.3-codex-spark",
  reasoningEffort: "low",
});

export const PROJECT_IMPACT_FALLBACK = "对项目的具体作用待核验。";

const TRANSLATION_PROMPT_ID = "venue-search-translate";
const PROJECT_IMPACT_PROMPT_ID = "paper-project-impact";
const MAX_TRANSLATION_ITEMS = 40;
const MAX_PROJECT_IMPACT_ITEMS = 8;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const FIELD_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_LIMITS = Object.freeze({
  title: 300,
  abstract: 500,
  summary: 600,
  selection_summary: 600,
  project_impact: 600,
  excerpt: 400,
  web_title: 300,
  web_excerpt: 400,
});

export function needsPaperTranslation(text) {
  return typeof text === "string" && /[A-Za-z]{4,}/.test(text);
}

export function resolvePaperLanguageProfile(env = {}) {
  const configuredModel = typeof env.PI_JOURNAL_TRANSLATION_MODEL === "string"
    ? env.PI_JOURNAL_TRANSLATION_MODEL.trim()
    : "";
  return Object.freeze({
    ...PAPER_LANGUAGE_PROFILE,
    modelId: configuredModel || PAPER_LANGUAGE_PROFILE.modelId,
  });
}

function compact(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replaceAll(/\s+/g, " ").slice(0, maxLength);
}

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "PAPER_LANGUAGE_FAILED",
    message: typeof error?.message === "string"
      ? error.message.slice(0, 240)
      : "论文中文整理暂时失败",
    retryable: Boolean(error?.retryable),
  };
}

function normalizeTranslationItems(items) {
  if (!Array.isArray(items)) throw new TypeError("translation items must be an array");
  const seen = new Set();
  return items.map((item) => {
    const requestId = typeof item?.requestId === "string" ? item.requestId.trim() : "";
    const field = typeof item?.field === "string" ? item.field.trim() : "";
    if (!REQUEST_ID_PATTERN.test(requestId) || seen.has(requestId)) {
      throw new TypeError("translation requestId must be unique and schema-safe");
    }
    if (!FIELD_PATTERN.test(field)) {
      throw new TypeError("translation field must be a safe snake_case identifier");
    }
    seen.add(requestId);
    return {
      requestId,
      field,
      text: compact(item?.text, FIELD_LIMITS[field] ?? 600),
    };
  }).filter((item) => item.text);
}

function translationInput(items) {
  return {
    items: items.map((item) => ({ id: item.requestId, text: item.text })),
  };
}

function invocationProvenance({ prompt, profile, inputHash, generated = null }) {
  return {
    provider_id: generated?.provider_id ?? profile.providerId,
    model_id: generated?.model_id ?? profile.modelId,
    reasoning_effort: generated?.reasoning_effort ?? profile.reasoningEffort,
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    input_hash: inputHash,
    operation_id: generated?.operation_id ?? null,
    upstream_request_id: generated?.upstream_request_id ?? null,
    usage: generated?.usage ?? null,
  };
}

function aggregateProvenance({ prompt, profile, inputHash, batches }) {
  return {
    provider_id: profile.providerId,
    model_id: profile.modelId,
    reasoning_effort: profile.reasoningEffort,
    prompt_id: prompt.id,
    prompt_version: prompt.version,
    prompt_hash: prompt.prompt_hash,
    input_hash: inputHash,
    batch_count: batches.length,
    batches,
  };
}

function projectContextInput(projectContext) {
  if (!projectContext || typeof projectContext !== "object" || Array.isArray(projectContext)) {
    return null;
  }
  const decisions = Array.isArray(projectContext.decisions) ? projectContext.decisions : [];
  const openQuestions = Array.isArray(
    projectContext.open_questions ?? projectContext.openQuestions,
  )
    ? (projectContext.open_questions ?? projectContext.openQuestions)
    : [];
  const context = {
    goal: compact(projectContext.goal, 400),
    decisions: decisions.slice(0, 4).map((item) => compact(item, 200)),
    open_questions: openQuestions
      .slice(0, 4)
      .map((item) => compact(item, 200)),
    next_action: compact(projectContext.next_action ?? projectContext.nextAction, 200),
  };
  return context.goal
    || context.decisions.some(Boolean)
    || context.open_questions.some(Boolean)
    || context.next_action
    ? context
    : null;
}

function normalizeImpactPapers(papers) {
  if (!Array.isArray(papers)) throw new TypeError("impact papers must be an array");
  const seen = new Set();
  return papers.slice(0, MAX_PROJECT_IMPACT_ITEMS).map((paper) => {
    const requestId = typeof paper?.requestId === "string" ? paper.requestId.trim() : "";
    if (!REQUEST_ID_PATTERN.test(requestId) || seen.has(requestId)) {
      throw new TypeError("impact requestId must be unique and schema-safe");
    }
    seen.add(requestId);
    const topicMatches = Array.isArray(paper?.topicMatches ?? paper?.topic_matches)
      ? (paper.topicMatches ?? paper.topic_matches)
      : [];
    return {
      request_id: requestId,
      title: compact(paper?.title, 300),
      abstract: compact(paper?.abstract, 500)
        || "当前来源未提供摘要，具体作用只能依据题录初步判断。",
      venue: compact(paper?.venue, 160),
      published_at: compact(paper?.publishedAt ?? paper?.published_at, 40),
      topic_matches: topicMatches
        .slice(0, 8)
        .map((item) => compact(item, 100)),
    };
  }).filter((paper) => paper.title);
}

export function createPaperLanguageService({
  env = {},
  modelProviders = null,
  modelMode = "fixture",
  promptRegistry = defaultPromptRegistry,
} = {}) {
  const profile = resolvePaperLanguageProfile(env);

  async function translateFields(items, { onEvent = null } = {}) {
    const normalized = normalizeTranslationItems(items);
    const translatable = normalized.filter((item) => needsPaperTranslation(item.text));
    const prompt = promptRegistry.loadPrompt(TRANSLATION_PROMPT_ID);
    const aggregateInput = translationInput(translatable);
    const inputHash = promptRegistry.createInputHash({
      promptId: TRANSLATION_PROMPT_ID,
      input: aggregateInput,
      modelSettings: {
        provider_id: profile.providerId,
        model_id: profile.modelId,
        reasoning_effort: profile.reasoningEffort,
      },
    });
    if (translatable.length === 0) {
      return {
        status: "not_required",
        translations: [],
        byRequestId: new Map(),
        provenance: aggregateProvenance({ prompt, profile, inputHash, batches: [] }),
        error: null,
      };
    }
    if (modelMode !== "live" || typeof modelProviders?.completeStructured !== "function") {
      return {
        status: "unavailable",
        translations: [],
        byRequestId: new Map(),
        provenance: aggregateProvenance({ prompt, profile, inputHash, batches: [] }),
        error: null,
      };
    }

    const translations = [];
    const batches = [];
    let lastError = null;
    for (let index = 0; index < translatable.length; index += MAX_TRANSLATION_ITEMS) {
      const batch = translatable.slice(index, index + MAX_TRANSLATION_ITEMS);
      const input = translationInput(batch);
      const batchInputHash = promptRegistry.createInputHash({
        promptId: TRANSLATION_PROMPT_ID,
        input,
        modelSettings: {
          provider_id: profile.providerId,
          model_id: profile.modelId,
          reasoning_effort: profile.reasoningEffort,
        },
      });
      try {
        const generated = await modelProviders.completeStructured({
          providerId: profile.providerId,
          modelId: profile.modelId,
          reasoningEffort: profile.reasoningEffort,
          system: prompt.system,
          prompt: prompt.body,
          input,
          schema: prompt.schema,
          ...(typeof onEvent === "function" ? { onEvent } : {}),
        });
        const expected = new Map(batch.map((item) => [item.requestId, item]));
        const accepted = new Set();
        for (const entry of generated.value?.translations ?? []) {
          const requestId = typeof entry?.id === "string" ? entry.id : "";
          const zh = compact(entry?.zh, 600);
          const source = expected.get(requestId);
          if (!source || accepted.has(requestId) || !zh) continue;
          accepted.add(requestId);
          translations.push({
            request_id: requestId,
            field: source.field,
            source_text: source.text,
            zh,
          });
        }
        batches.push(invocationProvenance({
          prompt,
          profile,
          inputHash: batchInputHash,
          generated,
        }));
      } catch (error) {
        lastError = publicError(error);
        break;
      }
    }
    const byRequestId = new Map(translations.map((item) => [item.request_id, item]));
    const complete = translations.length === translatable.length;
    const incompleteError = complete ? null : lastError ?? {
      code: "PAPER_LANGUAGE_OUTPUT_INCOMPLETE",
      message: "论文中文字段返回不完整",
      retryable: true,
    };
    return {
      status: complete ? "ready" : translations.length > 0 ? "partial" : "failed",
      translations,
      byRequestId,
      provenance: aggregateProvenance({ prompt, profile, inputHash, batches }),
      error: incompleteError,
    };
  }

  async function generateProjectImpacts({ papers, projectContext } = {}) {
    const normalizedPapers = normalizeImpactPapers(papers);
    const context = projectContextInput(projectContext);
    const fallback = normalizedPapers.map((paper) => ({
      request_id: paper.request_id,
      project_impact: PROJECT_IMPACT_FALLBACK,
    }));
    const prompt = promptRegistry.loadPrompt(PROJECT_IMPACT_PROMPT_ID);
    const input = { project: context, papers: normalizedPapers };
    const inputHash = promptRegistry.createInputHash({
      promptId: PROJECT_IMPACT_PROMPT_ID,
      input,
      modelSettings: {
        provider_id: profile.providerId,
        model_id: profile.modelId,
        reasoning_effort: profile.reasoningEffort,
      },
    });
    const baseProvenance = invocationProvenance({ prompt, profile, inputHash });
    if (normalizedPapers.length === 0 || !context) {
      return {
        status: normalizedPapers.length === 0 ? "not_required" : "context_unavailable",
        impacts: fallback,
        byRequestId: new Map(fallback.map((item) => [item.request_id, item])),
        provenance: baseProvenance,
        error: null,
      };
    }
    if (modelMode !== "live" || typeof modelProviders?.completeStructured !== "function") {
      return {
        status: "unavailable",
        impacts: fallback,
        byRequestId: new Map(fallback.map((item) => [item.request_id, item])),
        provenance: baseProvenance,
        error: null,
      };
    }
    try {
      const generated = await modelProviders.completeStructured({
        providerId: profile.providerId,
        modelId: profile.modelId,
        reasoningEffort: profile.reasoningEffort,
        system: prompt.system,
        prompt: prompt.body,
        input,
        schema: prompt.schema,
      });
      const expected = new Set(normalizedPapers.map((paper) => paper.request_id));
      const generatedById = new Map();
      for (const item of generated.value?.impacts ?? []) {
        const requestId = typeof item?.request_id === "string" ? item.request_id : "";
        const projectImpact = compact(item?.project_impact, 260);
        if (!expected.has(requestId) || generatedById.has(requestId) || !projectImpact) continue;
        generatedById.set(requestId, {
          request_id: requestId,
          project_impact: projectImpact,
        });
      }
      const impacts = fallback.map((item) => generatedById.get(item.request_id) ?? item);
      const complete = generatedById.size === normalizedPapers.length;
      const status = complete ? "ready" : generatedById.size > 0 ? "partial" : "failed";
      return {
        status,
        impacts,
        byRequestId: new Map(impacts.map((item) => [item.request_id, item])),
        provenance: invocationProvenance({ prompt, profile, inputHash, generated }),
        error: complete ? null : {
          code: "PAPER_PROJECT_IMPACT_OUTPUT_INCOMPLETE",
          message: "论文项目作用返回不完整",
          retryable: true,
        },
      };
    } catch (error) {
      return {
        status: "failed",
        impacts: fallback,
        byRequestId: new Map(fallback.map((item) => [item.request_id, item])),
        provenance: baseProvenance,
        error: publicError(error),
      };
    }
  }

  return Object.freeze({
    profile,
    translateFields,
    generateProjectImpacts,
  });
}
