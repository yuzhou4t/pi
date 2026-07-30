import { createHash } from "node:crypto";
import { access, lstat, mkdir, open, realpath } from "node:fs/promises";
import { resolveModelMode } from "../modelMode.js";
import path from "node:path";
import { createMineruCloudAdapter, MineruCloudError } from "../mineruCloud.js";
import { createModelUsageLedger } from "../modelUsageLedger.js";
import { createModelProviderRegistry } from "../modelProviders.js";
import { codexReasoningEffortFromThinking } from "../providers/codexSubscription.js";
import { promptRegistry } from "../promptRegistry.js";
import { createZoteroDesktopAdapter } from "../zoteroDesktop.js";
import { deterministicCandidateRanking, rankCandidates } from "./candidateRanking.js";
import { buildDocumentIndex } from "./documentIndex.js";
import { downloadPdf, readPdfManifest } from "./pdfDownloader.js";
import { generateFiveMinuteGuide } from "./guideGenerator.js";
import {
  isMathOnlyBlock,
  isTranslatableBlock,
  TRANSLATION_MODEL_PROFILE,
  TRANSLATION_PROMPT_ID,
  translatePaperBatch,
  translationBatches,
} from "./translationGenerator.js";
import { createObsidianPreviewService } from "./obsidianPreview.js";
import { createProjectContextReader } from "./projectContext.js";
import { createProjectStatePreviewService } from "./projectStatePreview.js";
import { createReadingNoteActionService } from "./readingNoteAction.js";
import { createReadingService } from "./readingService.js";
import { createJournalModelUsageService } from "./modelUsageService.js";
import { createRunStore, journalWeekWindowKey } from "./runStore.js";
import {
  commitJournalSourceScan,
  scanJournalSources,
} from "./sourceScanner.js";
import { createSourceStateStore } from "./sourceStateStore.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";
import { searchRegisteredVenues } from "./venueSearch.js";
import { createVenueSearchService } from "./venueSearchService.js";
import { createZoteroArchivalService } from "./zoteroArchival.js";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function providerDefaults(env) {
  return env.PI_DEFAULT_PROVIDER === "deepseek"
    ? { providerId: "deepseek", modelId: "deepseek-v4-flash" }
    : { providerId: "codex-subscription", modelId: "account-default" };
}

// GPT 订阅通道下把选中的思考强度转成 Codex reasoning effort；DeepSeek 或未选
// 时返回 null（不注入）。用于包装 modelProviders，让各结构化步骤沿用用户所选
// 强度，而无需逐个改生成器签名。
function reasoningEffortFor(providerId, thinkingLevel) {
  if (providerId !== "codex-subscription") return null;
  return codexReasoningEffortFromThinking(thinkingLevel);
}

function withReasoningEffort(providers, reasoningEffort) {
  if (!reasoningEffort || typeof providers?.completeStructured !== "function") {
    return providers;
  }
  return {
    ...providers,
    completeStructured: (request) => providers.completeStructured({
      reasoningEffort,
      ...request,
    }),
  };
}

function safeName(value) {
  const result = String(value || "").replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (!result) throw new Error("PAPER_ID_INVALID");
  return result.slice(0, 120);
}

const READER_IMAGE_MIME_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

function imageSrcFromMarkdown(markdown) {
  const md = String(markdown || "");
  const mdImage = md.match(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/);
  if (mdImage) return mdImage[1];
  const htmlImage = md.match(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  return htmlImage ? htmlImage[1] : null;
}

function readerImageUrl(runId, paperId, block) {
  const src = imageSrcFromMarkdown(block?.markdown);
  if (!src) return null;
  const base = path.basename(src);
  if (!/^[a-zA-Z0-9._-]+\.(?:png|jpg|jpeg|gif|webp)$/i.test(base)) return null;
  return `/api/v1/journal-runs/${encodeURIComponent(runId)}`
    + `/papers/${encodeURIComponent(paperId)}/images/${encodeURIComponent(base)}`;
}

function publicError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : error?.message ?? "WORKFLOW_STEP_FAILED",
    message: typeof error?.message === "string" ? error.message.slice(0, 300) : "工作流步骤失败",
    retryable: Boolean(error?.retryable),
  };
}

function artifactError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = false;
  return error;
}

function emptyGuides() {
  return {
    status: "not_started",
    requested_paper_ids: [],
    provider_id: null,
    model_id: null,
    papers: {},
  };
}

function normalizedGuides(run) {
  const guides = run?.guides;
  if (!guides || typeof guides !== "object" || Array.isArray(guides)) return emptyGuides();
  return {
    ...emptyGuides(),
    ...guides,
    requested_paper_ids: Array.isArray(guides.requested_paper_ids)
      ? [...guides.requested_paper_ids]
      : [],
    papers: guides.papers && typeof guides.papers === "object" && !Array.isArray(guides.papers)
      ? { ...guides.papers }
      : {},
  };
}

function guideMarkdown(paper, guide) {
  const questions = guide.questions.length > 0
    ? guide.questions.map((question) => `- ${question}`).join("\n")
    : "- 暂无";
  const references = guide.evidence_refs
    .map((blockId) => `- \`${blockId}\``)
    .join("\n");
  return [
    `# ${paper.title} · 五分钟导读`,
    "",
    "## 研究问题",
    "",
    guide.problem,
    "",
    "## 为什么值得读",
    "",
    guide.why_read,
    "",
    "## 核心直觉",
    "",
    guide.intuition,
    "",
    "## 主要证据",
    "",
    guide.evidence,
    "",
    "## 局限与边界",
    "",
    guide.limitations,
    "",
    "## 精读问题",
    "",
    questions,
    "",
    "## 正文证据锚点",
    "",
    references,
    "",
  ].join("\n");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), items.length) },
      worker,
    ),
  );
  return results;
}

export function createJournalWorkflowService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  dataDir = path.resolve(env.PI_DATA_DIR || ".pi-agent"),
  runStore = createRunStore({ dataDir }),
  usageLedger = createModelUsageLedger({ dataDir }),
  modelUsageService = createJournalModelUsageService({ dataDir }),
  sourceStateStore = createSourceStateStore({ dataDir }),
  sourceScanner = scanJournalSources,
  sourceScanCommitter = commitJournalSourceScan,
  candidateRanker = rankCandidates,
  guideGenerator = generateFiveMinuteGuide,
  translationGenerator = translatePaperBatch,
  modelProviders = createModelProviderRegistry({
    env,
    fetchImpl,
    usageRecorder: usageLedger.capture,
  }),
  pdfDownloader = downloadPdf,
  mineruAdapter = env.PI_MINERU_API_TOKEN
    ? createMineruCloudAdapter({
        apiToken: env.PI_MINERU_API_TOKEN,
        baseUrl: env.PI_MINERU_BASE_URL || undefined,
        fetchImpl,
      })
    : null,
  zoteroAdapter = createZoteroDesktopAdapter({
    baseUrl: env.PI_ZOTERO_BASE_URL || undefined,
    fetchImpl,
  }),
  zoteroArchivalService = null,
  venueSearchService = null,
  obsidianPreviewService = null,
  projectStatePreviewService = null,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const inFlight = new Map();
  const guideInFlight = new Map();
  const guideStartLocks = new Map();
  const translationInFlight = new Map();
  const documentRetryInFlight = new Map();
  const archiveCommitJobs = new Map();
  const archiveStartLocks = new Map();
  let reading;
  let readingNoteAction;
  let obsidianPreview;
  let projectStatePreview;
  const pdfCacheDir = path.resolve(dataDir, "cache", "pdfs");
  const pdfConcurrency = Math.min(
    positiveInteger(env.PI_PDF_PREP_CONCURRENCY, 3),
    5,
  );
  const pollIntervalMs = positiveInteger(env.PI_MINERU_POLL_INTERVAL_MS, 10000);
  const pollTimeoutMs = positiveInteger(env.PI_MINERU_TIMEOUT_MS, 30 * 60 * 1000);
  // A missing mode must fail closed through the real adapters instead of
  // silently turning a desktop run into fixture data.
  const modelMode = resolveModelMode(env);
  const defaults = providerDefaults(env);
  const activeGuidePrompt = guideGenerator === generateFiveMinuteGuide
    ? promptRegistry.loadPrompt("five-minute-guide")
    : null;
  const activeTranslationPrompt = promptRegistry.loadPrompt(TRANSLATION_PROMPT_ID);
  const translationProfile = Object.freeze({
    ...TRANSLATION_MODEL_PROFILE,
    promptId: activeTranslationPrompt.id,
    promptVersion: activeTranslationPrompt.version,
    promptHash: activeTranslationPrompt.prompt_hash,
  });
  const projectContext = createProjectContextReader({
    projectRoot: path.resolve(env.PI_PROJECT_ROOT || "."),
    projectStatePath: env.PI_PROJECT_STATE_PATH || "project_state.md",
  });
  const zoteroArchival = zoteroArchivalService
    ?? createZoteroArchivalService({
      runStore,
      zoteroAdapter,
      getPaperGuide,
      getPaperPdf,
    });
  const venueSearch = venueSearchService ?? createVenueSearchService({
    dataDir,
    env,
    fetchImpl,
    modelProviders,
    modelMode,
    projectContextReader: projectContext,
    mailto: env.PI_OPENALEX_MAILTO || "",
  });

  async function update(runId, patch, event) {
    const run = await runStore.updateRun(runId, patch);
    if (event) await runStore.appendEvent(runId, { ...event, at: run.updated_at });
    return run;
  }

  async function ensurePdf(paper) {
    await mkdir(pdfCacheDir, { recursive: true });
    const candidatePath = path.join(pdfCacheDir, `${safeName(paper.paper_id)}.pdf`);
    const cachedManifest = await readPdfManifest(candidatePath);
    if (cachedManifest && await fileExists(candidatePath)) {
      return { ...cachedManifest, file_path: candidatePath, cache_hit: true };
    }
    const pdfUrl = paper.pdf_url || paper.pdf_candidates?.[0];
    if (!pdfUrl) throw new Error("PDF_URL_UNAVAILABLE");
    return {
      ...await pdfDownloader({
        paperId: paper.paper_id,
        url: pdfUrl,
        outputDir: pdfCacheDir,
        fetchImpl,
      }),
      cache_hit: false,
    };
  }

  async function preparePdfs(runId, candidates) {
    const papers = {};
    const files = [];
    const outcomes = await mapWithConcurrency(
      candidates,
      pdfConcurrency,
      async (paper) => {
        let outcome;
        try {
          const pdf = await ensurePdf(paper);
          outcome = {
            file: {
              filePath: pdf.file_path,
              fileName: `${safeName(paper.paper_id)}.pdf`,
              dataId: safeName(paper.paper_id),
            },
            state: {
              status: "pdf_ready",
              pdf_sha256: pdf.sha256,
              pdf_bytes: pdf.byte_length,
              pdf_cache_hit: pdf.cache_hit,
              error: null,
            },
          };
        } catch (error) {
          outcome = {
            file: null,
            state: {
              status: "pdf_failed",
              error: publicError(error),
            },
          };
        }
        await update(runId, (current) => ({
          status: "preparing_documents",
          phase: "pdf_download",
          mineru: {
            ...current.mineru,
            status: "preparing_pdfs",
            papers: {
              ...(current.mineru?.papers ?? {}),
              [paper.paper_id]: outcome.state,
            },
          },
        }), {
          type: "pdf_paper_prepared",
          paper_id: paper.paper_id,
          status: outcome.state.status,
        });
        return outcome;
      },
    );
    outcomes.forEach((outcome, index) => {
      const paper = candidates[index];
      papers[paper.paper_id] = outcome.state;
      if (outcome.file) files.push(outcome.file);
    });
    await update(runId, (current) => ({
      status: "preparing_documents",
      phase: "pdf_download",
      mineru: {
        ...current.mineru,
        status: files.length > 0 ? "pdf_ready" : "unavailable",
        papers,
      },
    }), {
      type: "pdf_preparation_completed",
      attempted_count: candidates.length,
      ready_count: files.length,
    });
    return { files, papers };
  }

  async function saveMineruArtifacts(runId, batch, papers) {
    const nextPapers = { ...papers };
    for (const item of batch.items) {
      const paperId = item.dataId;
      if (!paperId || !nextPapers[paperId]) continue;
      if (item.state === "done") {
        try {
          const manifest = await runStore.readArtifact(
            runId,
            `extraction/${paperId}/manifest.json`,
          );
          if (
            manifest?.paper_id === paperId
            && Number.isSafeInteger(manifest.markdown_chars)
            && Number.isSafeInteger(manifest.image_count)
          ) {
            nextPapers[paperId] = {
              ...nextPapers[paperId],
              status: "ready",
              markdown_chars: manifest.markdown_chars,
              image_count: manifest.image_count,
              progress: null,
              error: null,
            };
            continue;
          }
        } catch {
          // The result has not been stored yet; download it below.
        }
      }
      if (
        nextPapers[paperId].status === "mineru_upload_failed"
        && item.state === "waiting-file"
      ) {
        continue;
      }
      if (item.state !== "done") {
        nextPapers[paperId] = {
          ...nextPapers[paperId],
          status: item.state === "failed" ? "mineru_failed" : `mineru_${item.state}`,
          progress: item.progress,
          error: item.error ? { code: "MINERU_ITEM_FAILED", message: item.error, retryable: true } : null,
        };
        continue;
      }
      try {
        const result = await mineruAdapter.downloadResult(item.fullZipUrl);
        await runStore.writeArtifact(runId, `extraction/${paperId}/paper.md`, result.markdown);
        for (const image of result.images) {
          await runStore.writeBinaryArtifact(
            runId,
            `extraction/${paperId}/images/${image.name}`,
            image.bytes,
          );
        }
        await runStore.writeArtifact(runId, `extraction/${paperId}/manifest.json`, {
          schema_version: 1,
          paper_id: paperId,
          batch_id: batch.batchId,
          markdown_chars: result.markdown.length,
          image_count: result.images.length,
          completed_at: new Date().toISOString(),
        });
        nextPapers[paperId] = {
          ...nextPapers[paperId],
          status: "ready",
          markdown_chars: result.markdown.length,
          image_count: result.images.length,
          progress: null,
          error: null,
        };
      } catch (error) {
        nextPapers[paperId] = {
          ...nextPapers[paperId],
          status: "result_failed",
          error: publicError(error),
        };
      }
    }
    return nextPapers;
  }

  function mineruStatusFromPapers(papers) {
    const values = Object.values(papers);
    const ready = values.filter((paper) => paper.status === "ready").length;
    const pending = values.filter((paper) => /^mineru_(waiting-file|pending|running|converting)$/.test(paper.status)).length;
    if (ready === values.length && values.length > 0) return "ready";
    if (pending > 0) return "remote_running";
    if (ready > 0) return "partial";
    return "failed";
  }

  async function pollMineru(runId, batchId, initialPapers) {
    const startedAt = Date.now();
    let papers = initialPapers;
    while (Date.now() - startedAt < pollTimeoutMs) {
      const batch = await mineruAdapter.getBatch(batchId);
      papers = await saveMineruArtifacts(runId, batch, papers);
      const mineruStatus = mineruStatusFromPapers(papers);
      await update(runId, (current) => ({
        status: mineruStatus === "remote_running" ? "preparing_documents" : "review_ready",
        phase: mineruStatus === "remote_running" ? "mineru_extract" : "candidate_review",
        paused_reason: mineruStatus === "remote_running" ? null : "等待审阅本轮 5 篇候选",
        mineru: {
          ...current.mineru,
          status: mineruStatus,
          papers,
        },
      }), {
        type: "mineru_polled",
        batch_id: batchId,
        status: mineruStatus,
      });
      if (mineruStatus !== "remote_running") return;
      await sleep(pollIntervalMs);
    }
    await update(runId, (current) => ({
      status: "review_ready",
      phase: "candidate_review",
      paused_reason: "MinerU 仍在云端处理，可稍后继续查询",
      mineru: {
        ...current.mineru,
        status: "remote_running",
        papers,
      },
    }), {
      type: "mineru_poll_deferred",
      batch_id: batchId,
    });
  }

  async function startMineru(runId, files, papers) {
    if (files.length === 0) {
      await update(runId, (current) => ({
        status: "review_ready",
        phase: "candidate_review",
        paused_reason: "5 篇候选均未取得可解析 PDF；候选仍可审阅并逐篇重试",
        mineru: {
          ...current.mineru,
          status: "unavailable",
          papers,
        },
      }), { type: "mineru_skipped_no_pdf" });
      return;
    }
    if (!mineruAdapter) {
      await update(runId, (current) => ({
        status: "review_ready",
        phase: "candidate_review",
        paused_reason: "MinerU Token 尚未配置；5 篇候选已保留",
        mineru: {
          ...current.mineru,
          status: "not_configured",
          papers,
        },
      }), { type: "mineru_not_configured" });
      return;
    }
    try {
      await update(runId, (current) => ({
        status: "preparing_documents",
        phase: "mineru_upload",
        mineru: {
          ...current.mineru,
          status: "uploading",
          error: null,
          papers,
        },
      }), {
        type: "mineru_upload_started",
        file_count: files.length,
      });
      const submitted = await mineruAdapter.submitBatch(files);
      const uploadedById = new Map(submitted.uploads.map((item) => [item.dataId, item]));
      const nextPapers = Object.fromEntries(Object.entries(papers).map(([paperId, paper]) => {
        const upload = uploadedById.get(paperId);
        return [paperId, upload
          ? {
              ...paper,
              status: upload.state === "uploaded" ? "mineru_pending" : "mineru_upload_failed",
              error: upload.error,
            }
          : paper];
      }));
      await update(runId, (current) => ({
        status: "preparing_documents",
        phase: "mineru_extract",
        mineru: {
          ...current.mineru,
          status: submitted.state === "uploaded" ? "remote_running" : "partial",
          batch_id: submitted.batchId,
          papers: nextPapers,
        },
      }), {
        type: "mineru_batch_submitted",
        batch_id: submitted.batchId,
        uploaded_count: submitted.uploads.filter((item) => item.state === "uploaded").length,
      });
      await pollMineru(runId, submitted.batchId, nextPapers);
    } catch (error) {
      const quota = error instanceof MineruCloudError && error.category === "quota";
      await update(runId, (current) => ({
        status: "review_ready",
        phase: "candidate_review",
        paused_reason: quota ? "MinerU 今日额度已用尽，将在下次运行继续" : "MinerU 提交失败，可稍后重试",
        mineru: {
          ...current.mineru,
          status: quota ? "quota_deferred" : "failed",
          error: publicError(error),
          papers,
        },
      }), {
        type: quota ? "mineru_quota_deferred" : "mineru_failed",
      });
    }
  }

  async function executeRun(runId, { providerId, modelId, reasoningEffort = null } = defaults) {
    const rankingProviders = withReasoningEffort(modelProviders, reasoningEffort);
    try {
      const scan = await sourceScanner({
        runId,
        runStore,
        sourceStateStore,
        fetchImpl,
        openAlexMailto: env.PI_OPENALEX_MAILTO || "",
        deferCursorCommit: true,
      });
      await update(runId, {
        status: "ranking",
        phase: "candidate_ranking",
        scan_summary: scan.summary,
      }, { type: "candidate_ranking_started" });

      let ranking;
      let currentProjectContext = null;
      try {
        currentProjectContext = await projectContext.read();
      } catch (error) {
        if (modelMode === "live") throw error;
        ranking = {
          candidates: deterministicCandidateRanking(scan.candidateBatch.candidates),
          source: "deterministic_fallback",
          error: publicError(error),
        };
      }
      if (currentProjectContext) {
        try {
        ranking = await candidateRanker({
          papers: scan.candidateBatch.candidates,
          projectContext: currentProjectContext.state,
          providerId,
          modelId,
          modelProviders: rankingProviders,
          modelMode,
        });
        ranking.project_context_source_path = currentProjectContext.source_path;
        ranking.project_context_revision = currentProjectContext.revision;
        } catch (error) {
          ranking = {
            candidates: deterministicCandidateRanking(scan.candidateBatch.candidates),
            source: "deterministic_fallback",
            error: publicError(error),
          };
        }
      }
      const candidates = ranking.candidates.map((paper) => ({
        ...paper,
        display_label: paper.candidate_origin === "classic_review"
          ? "经典回顾 · 非本周新论文"
          : paper.display_label ?? "本周新论文",
      }));
      await runStore.writeArtifact(runId, "inputs/candidates.json", candidates);
      await runStore.writeArtifact(runId, "audit/candidate-ranking.json", {
        ...ranking,
        candidates: candidates.map((paper) => ({
          paper_id: paper.paper_id,
          rank: paper.rank,
        })),
      });
      await update(runId, {
        status: "preparing_documents",
        phase: "pdf_download",
        candidates,
        ranking: {
          source: ranking.source,
          provider_id: ranking.provider_id ?? null,
          model_id: ranking.model_id ?? null,
          prompt_id: ranking.prompt_id ?? null,
          prompt_version: ranking.prompt_version ?? null,
          input_hash: ranking.input_hash ?? null,
          input_paper_count: ranking.input_paper_count ?? null,
          input_chars: ranking.input_chars ?? null,
          usage: ranking.usage ?? null,
          error: ranking.error ?? null,
        },
      }, {
        type: "candidate_ranking_completed",
        candidate_count: candidates.length,
        source: ranking.source,
      });
      if (scan.cursor_commit_pending) {
        await sourceScanCommitter({
          runId,
          runStore,
          sourceStateStore,
          requiredArtifacts: [
            "inputs/candidates.json",
            "audit/candidate-ranking.json",
          ],
        });
      }
      const prepared = await preparePdfs(runId, candidates);
      await startMineru(runId, prepared.files, prepared.papers);
      return await runStore.getRun(runId);
    } catch (error) {
      await update(runId, {
        status: "failed",
        phase: "failed",
        paused_reason: "本轮准备失败，可从运行记录重试",
        last_error: publicError(error),
      }, { type: "run_failed", error: publicError(error) });
      return await runStore.getRun(runId);
    }
  }

  async function searchVenues({ query, limit, fromYear } = {}) {
    return searchRegisteredVenues({
      query,
      sources: SOURCE_REGISTRY,
      fetchImpl,
      limit,
      fromYear,
      mailto: env.PI_OPENALEX_MAILTO || "",
    });
  }

  function getVenueSearchConversation(conversationId = null) {
    return venueSearch.getConversation(conversationId);
  }

  function listVenueSearchConversations() {
    return venueSearch.listConversations();
  }

  function createVenueSearchConversation({ title } = {}) {
    return venueSearch.createConversation({ title });
  }

  function deleteVenueSearchConversation(conversationId) {
    return venueSearch.deleteConversation(conversationId);
  }

  function submitVenueSearchTurn({
    conversationId = null,
    question,
    providerId = defaults.providerId,
    modelId = defaults.modelId,
    thinkingLevel = null,
    clientRequestId,
  } = {}) {
    return venueSearch.submitTurn({
      conversationId,
      question,
      providerId,
      modelId,
      reasoningEffort: reasoningEffortFor(providerId, thinkingLevel),
      clientRequestId,
    });
  }

  function getVenueSearchTurnProgress(clientRequestId) {
    return venueSearch.getTurnProgress(clientRequestId);
  }

  async function addVenueSearchPapersToWeekly({ conversationId = null, turnId, paperIds } = {}) {
    if (!Array.isArray(paperIds) || paperIds.length === 0) {
      throw artifactError(
        "VENUE_SEARCH_PAPER_IDS_REQUIRED",
        "请先选择要加入本周推荐的论文",
        400,
      );
    }
    const conversation = await venueSearch.getConversation(conversationId);
    const turn = venueSearch.getTurn(conversation, turnId);
    const byId = new Map(turn.papers.map((paper) => [paper.paper_id, paper]));
    for (const paperId of paperIds) {
      if (!byId.has(paperId)) {
        throw artifactError(
          "VENUE_SEARCH_PAPER_NOT_FOUND",
          "所选论文不在该次检索结果中",
          404,
        );
      }
    }
    const runs = await runStore.listRuns();
    const windowKey = journalWeekWindowKey(new Date().toISOString());
    const targetRun = runs.find((run) => (
      (run.window_key || journalWeekWindowKey(run.created_at)) === windowKey
      && ["review_ready", "guide_ready", "reading", "draft_ready", "reading_ready"].includes(run.status)
    ));
    if (!targetRun) {
      throw artifactError(
        "WEEKLY_RUN_NOT_READY",
        "本周运行还没有进入候选审阅，请先完成每周扫描",
        409,
      );
    }
    const reasonById = new Map(
      (turn.recommendations ?? []).map((item) => [item.paper_id, item]),
    );
    const updatedRun = await update(targetRun.run_id, (current) => {
      const existingIds = new Set(
        (current.candidates ?? []).map((paper) => paper.paper_id),
      );
      const existingKeys = new Set(
        (current.candidates ?? []).map((paper) => paper.dedupe_key).filter(Boolean),
      );
      let nextRank = (current.candidates ?? []).reduce(
        (max, paper) => Math.max(max, Number(paper.rank) || 0),
        0,
      );
      const added = [];
      for (const paperId of paperIds) {
        const paper = byId.get(paperId);
        if (existingIds.has(paperId) || (paper.dedupe_key && existingKeys.has(paper.dedupe_key))) {
          continue;
        }
        nextRank += 1;
        const recommendation = reasonById.get(paperId);
        added.push({
          ...paper,
          rank: nextRank,
          candidate_origin: "venue_search",
          display_label: "主题检索推荐 · 非本周新论文",
          title_zh: recommendation?.title_zh ?? paper.title_zh ?? null,
          selection_summary: recommendation?.reason
            ?? (paper.abstract
              ? paper.abstract.slice(0, 220)
              : `${paper.title}：来自主题检索，价值待全文核验。`),
          project_impact: recommendation?.project_impact ?? "对项目的具体作用待核验。",
        });
        existingIds.add(paperId);
        if (paper.dedupe_key) existingKeys.add(paper.dedupe_key);
      }
      if (added.length === 0) return {};
      return {
        candidates: [...(current.candidates ?? []), ...added],
        mineru: {
          ...current.mineru,
          papers: {
            ...(current.mineru?.papers ?? {}),
            ...Object.fromEntries(added.map((paper) => [
              paper.paper_id,
              { status: "pdf_not_prepared", error: null },
            ])),
          },
        },
      };
    }, {
      type: "venue_search_papers_added",
      turn_id: turnId,
      paper_ids: paperIds,
    });
    const updatedConversation = await venueSearch.markPapersAdded(
      conversation.conversation_id,
      turnId,
      paperIds,
    );
    return { run: updatedRun, conversation: updatedConversation };
  }

  async function startRun({
    trigger = "manual",
    providerId = defaults.providerId,
    modelId = defaults.modelId,
    thinkingLevel = null,
  } = {}) {
    const creation = typeof runStore.createOrReuseActiveRun === "function"
      ? await runStore.createOrReuseActiveRun({
          trigger,
          sourceIds: SOURCE_REGISTRY.map((source) => source.source_id),
        })
      : {
          run: await runStore.createRun({
            trigger,
            sourceIds: SOURCE_REGISTRY.map((source) => source.source_id),
          }),
          created: true,
        };
    const { run } = creation;
    if (!creation.created) return run;
    const reasoningEffort = reasoningEffortFor(providerId, thinkingLevel);
    // 记录本轮所选模型与强度，供扫描/排序阶段中断后恢复时沿用。
    const persisted = await update(run.run_id, {
      model_selection: {
        provider_id: providerId,
        model_id: modelId,
        thinking_level: thinkingLevel ?? null,
        reasoning_effort: reasoningEffort,
      },
    });
    const completion = executeRun(run.run_id, { providerId, modelId, reasoningEffort })
      .finally(() => inFlight.delete(run.run_id));
    inFlight.set(run.run_id, completion);
    return persisted;
  }

  async function resumeRun(runId) {
    if (inFlight.has(runId)) return runStore.getRun(runId);
    let run = await runStore.getRun(runId);
    if (!run) return null;
    if (run.archive_batch?.status === "committing") {
      return resumeArchiveCommit(runId, run);
    }
    if (run.status === "committing" && run.zotero?.status === "committing") {
      return zoteroArchival.resumeCommit(runId);
    }
    if (["scanning", "ranking"].includes(run.status)) {
      const selection = run.model_selection ?? {};
      const completion = executeRun(runId, {
        providerId: selection.provider_id ?? defaults.providerId,
        modelId: selection.model_id ?? defaults.modelId,
        reasoningEffort: selection.reasoning_effort ?? null,
      })
        .finally(() => inFlight.delete(runId));
      inFlight.set(runId, completion);
      return run;
    }
    run = await reading.resume(runId) ?? run;
    if (["reading", "draft_ready"].includes(run.status)) return run;
    if (!mineruAdapter) return run;
    const hasCandidates = Array.isArray(run.candidates) && run.candidates.length > 0;
    if (!run.mineru?.batch_id && !hasCandidates) return run;
    const resumedPapers = Object.fromEntries(
      Object.entries(run.mineru?.papers ?? {}).map(([paperId, paper]) => [
        paperId,
        paper.status === "mineru_waiting-file"
          ? {
              ...paper,
              status: "mineru_upload_failed",
              error: {
                code: "MINERU_UPLOAD_INCOMPLETE",
                message: "上次上传未完成，需要重新提交该篇 PDF",
                retryable: true,
              },
            }
          : paper,
      ]),
    );
    const resumedRun = await update(runId, {
      status: "preparing_documents",
      phase: run.mineru?.batch_id ? "mineru_extract" : "pdf_download",
      paused_reason: null,
      mineru: {
        ...run.mineru,
        papers: resumedPapers,
      },
    }, {
      type: run.mineru?.batch_id ? "mineru_poll_resumed" : "mineru_submission_resumed",
    });
    const operation = run.mineru?.batch_id
      ? pollMineru(runId, run.mineru.batch_id, resumedPapers).catch(async (error) => (
          update(runId, (current) => ({
            status: "review_ready",
            phase: "candidate_review",
            paused_reason: "MinerU 进度查询暂时失败；已保存批次，可稍后继续",
            mineru: {
              ...current.mineru,
              status: mineruStatusFromPapers(current.mineru?.papers ?? resumedPapers),
              error: publicError(error),
            },
          }), {
            type: "mineru_poll_failed",
            batch_id: run.mineru.batch_id,
            error: publicError(error),
          })
        ))
      : (async () => {
          const prepared = await preparePdfs(runId, run.candidates);
          await startMineru(runId, prepared.files, prepared.papers);
        })();
    const completion = operation
      .then(() => runStore.getRun(runId))
      .finally(() => inFlight.delete(runId));
    inFlight.set(runId, completion);
    return resumedRun;
  }

  async function retryPaperDocument(runId, paperId, {
    clientRequestId,
  } = {}) {
    if (!isNonEmptyString(clientRequestId)) {
      throw artifactError(
        "DOCUMENT_RETRY_REQUEST_ID_REQUIRED",
        "逐篇重试必须提供稳定的请求标识",
        400,
      );
    }
    const activeRetry = documentRetryInFlight.get(runId);
    if (activeRetry) {
      if (
        activeRetry.paperId === paperId
        && activeRetry.clientRequestId === clientRequestId
      ) {
        return runStore.getRun(runId);
      }
      throw artifactError(
        "DOCUMENT_PREPARATION_BUSY",
        "当前已有一篇候选全文正在重试",
      );
    }
    const { run, paper } = await runPaper(runId, paperId);
    const currentState = run.mineru?.papers?.[paperId];
    if (currentState?.status === "ready") return run;
    if (
      run.mineru?.status === "remote_running"
      || Object.values(run.mineru?.papers ?? {}).some(
        (state) => /^mineru_(pending|running|converting|waiting-file)$/.test(
          state?.status ?? "",
        ),
      )
    ) {
      throw artifactError(
        "DOCUMENT_PREPARATION_BUSY",
        "当前仍有候选全文正在处理中，请完成后再逐篇重试",
      );
    }
    const retrying = await update(runId, (current) => ({
      status: "preparing_documents",
      phase: "pdf_download",
      paused_reason: null,
      mineru: {
        ...current.mineru,
        status: "preparing_pdfs",
        papers: {
          ...(current.mineru?.papers ?? {}),
          [paperId]: {
            ...(current.mineru?.papers?.[paperId] ?? {}),
            status: "pdf_retrying",
            retry_request_id: clientRequestId,
            error: null,
          },
        },
      },
    }), {
      type: "pdf_paper_retry_started",
      paper_id: paperId,
    });
    const operation = (async () => {
      try {
        const pdf = await ensurePdf(paper);
        const latest = await runStore.getRun(runId);
        const papers = {
          ...(latest.mineru?.papers ?? {}),
          [paperId]: {
            status: "pdf_ready",
            pdf_sha256: pdf.sha256,
            pdf_bytes: pdf.byte_length,
            pdf_cache_hit: pdf.cache_hit,
            error: null,
          },
        };
        await update(runId, (current) => ({
          mineru: {
            ...current.mineru,
            papers,
          },
        }), {
          type: "pdf_paper_prepared",
          paper_id: paperId,
          status: "pdf_ready",
          retry: true,
        });
        await startMineru(runId, [{
          filePath: pdf.file_path,
          fileName: `${safeName(paperId)}.pdf`,
          dataId: safeName(paperId),
        }], papers);
      } catch (error) {
        await update(runId, (current) => ({
          status: "review_ready",
          phase: "candidate_review",
          paused_reason: "该篇全文准备失败，可稍后再次重试",
          mineru: {
            ...current.mineru,
            status: Object.values(current.mineru?.papers ?? {}).some(
              (state) => state?.status === "ready",
            ) ? "partial" : "failed",
            papers: {
              ...(current.mineru?.papers ?? {}),
              [paperId]: {
                ...(current.mineru?.papers?.[paperId] ?? {}),
                status: "pdf_failed",
                error: publicError(error),
              },
            },
          },
        }), {
          type: "pdf_paper_retry_failed",
          paper_id: paperId,
          error: publicError(error),
        });
      }
    })().finally(() => documentRetryInFlight.delete(runId));
    documentRetryInFlight.set(runId, {
      paperId,
      clientRequestId,
      operation,
    });
    return retrying;
  }

  async function runPaper(runId, paperId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(String(paperId ?? ""))) {
      throw artifactError("PAPER_NOT_FOUND", "论文不在当前运行中", 404);
    }
    let run;
    try {
      run = await runStore.getRun(runId);
    } catch {
      throw artifactError("RUN_NOT_FOUND", "运行不存在", 404);
    }
    if (!run) throw artifactError("RUN_NOT_FOUND", "运行不存在", 404);
    const paper = run.candidates?.find((candidate) => candidate.paper_id === paperId);
    if (!paper) throw artifactError("PAPER_NOT_FOUND", "论文不在当前运行中", 404);
    return { run, paper };
  }

  async function getPaperDocument(runId, paperId) {
    const { run, paper } = await runPaper(runId, paperId);
    if (run.mineru?.papers?.[paperId]?.status !== "ready") {
      throw artifactError("DOCUMENT_NOT_READY", "论文正文尚未准备完成");
    }
    const artifactRoot = `extraction/${paperId}`;
    let manifest;
    let markdown;
    try {
      manifest = await runStore.readArtifact(runId, `${artifactRoot}/manifest.json`);
      markdown = await runStore.readArtifact(runId, `${artifactRoot}/paper.md`);
    } catch {
      throw artifactError("DOCUMENT_NOT_READY", "论文正文尚未准备完成");
    }
    if (manifest?.paper_id !== paperId || manifest.markdown_chars !== markdown.length) {
      throw artifactError("DOCUMENT_CORRUPT", "论文正文校验失败");
    }
    const document = buildDocumentIndex(markdown);
    const firstBlockBySection = new Map();
    document.blocks.forEach((block) => {
      if (!firstBlockBySection.has(block.section_id)) {
        firstBlockBySection.set(block.section_id, block.block_id);
      }
    });
    return {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      revision: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
      paper: {
        title: paper.title,
        authors: paper.authors ?? [],
        venue: paper.venue ?? "",
        published_at: paper.published_at ?? null,
      },
      title: document.title || paper.title,
      sections: document.sections.map((section) => ({
        ...section,
        first_block_id: firstBlockBySection.get(section.section_id) ?? null,
      })),
      blocks: document.blocks.map((block, index) => ({
        ...block,
        image_url: block.kind === "image" ? readerImageUrl(runId, paperId, block) : null,
        previous_block_id: document.blocks[index - 1]?.block_id ?? null,
        next_block_id: document.blocks[index + 1]?.block_id ?? null,
      })),
      links: {
        original_pdf: `/api/v1/journal-runs/${encodeURIComponent(runId)}/papers/${encodeURIComponent(paperId)}/pdf`,
      },
    };
  }

  async function getPaperPdf(runId, paperId) {
    const { run } = await runPaper(runId, paperId);
    const paperState = run.mineru?.papers?.[paperId];
    if (
      typeof paperState?.pdf_sha256 !== "string"
      || !Number.isSafeInteger(paperState.pdf_bytes)
    ) {
      throw artifactError("PDF_NOT_READY", "论文原版尚未准备完成");
    }
    const filePath = path.join(pdfCacheDir, `${safeName(paperId)}.pdf`);
    const manifest = await readPdfManifest(filePath).catch(() => null);
    let fileStat;
    let resolvedCacheDir;
    let resolvedPath;
    try {
      fileStat = await lstat(filePath);
      resolvedCacheDir = await realpath(pdfCacheDir);
      resolvedPath = await realpath(filePath);
    } catch {
      throw artifactError("PDF_NOT_READY", "论文原版尚未准备完成");
    }
    const relative = path.relative(resolvedCacheDir, resolvedPath);
    if (
      !fileStat.isFile()
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || manifest?.paper_id !== paperId
      || manifest.sha256 !== paperState.pdf_sha256
      || manifest.byte_length !== paperState.pdf_bytes
      || fileStat.size !== paperState.pdf_bytes
    ) {
      throw artifactError("PDF_CORRUPT", "论文原版校验失败");
    }
    let handle;
    try {
      handle = await open(resolvedPath, "r");
      const signature = Buffer.alloc(5);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead !== 5 || signature.toString("ascii") !== "%PDF-") {
        throw artifactError("PDF_CORRUPT", "论文原版校验失败");
      }
    } finally {
      await handle?.close();
    }
    return {
      file_path: resolvedPath,
      byte_length: fileStat.size,
      sha256: paperState.pdf_sha256,
      file_name: `${paperId}.pdf`,
    };
  }

  async function getPaperImage(runId, paperId, imageName) {
    const { run } = await runPaper(runId, paperId);
    if (run.mineru?.papers?.[paperId]?.status !== "ready") {
      throw artifactError("DOCUMENT_NOT_READY", "论文正文尚未准备完成");
    }
    const base = path.basename(String(imageName || ""));
    const mimeType = READER_IMAGE_MIME_TYPES[path.extname(base).toLowerCase()];
    if (!mimeType || !/^[a-zA-Z0-9._-]+$/.test(base)) {
      throw artifactError("IMAGE_NOT_FOUND", "图片不存在", 404);
    }
    let bytes;
    try {
      bytes = await runStore.readBinaryArtifact(runId, `extraction/${paperId}/images/${base}`);
    } catch {
      throw artifactError("IMAGE_NOT_FOUND", "图片不存在", 404);
    }
    return { bytes, mimeType, name: base };
  }

  function guideArtifactNames(paperId) {
    const name = safeName(paperId);
    return {
      json: `guides/${name}.json`,
      markdown: `guides/${name}.md`,
    };
  }

  function validateGuideArtifact({
    artifact,
    markdown,
    runId,
    paperId,
    revision,
    providerId,
    modelId,
    document,
  }) {
    if (
      !artifact
      || typeof artifact !== "object"
      || Array.isArray(artifact)
      || artifact.schema_version !== 1
      || artifact.run_id !== runId
      || artifact.paper_id !== paperId
      || artifact.revision !== revision
      || artifact.requested_provider_id !== providerId
      || artifact.requested_model_id !== modelId
      || !isNonEmptyString(markdown)
    ) {
      throw artifactError("GUIDE_CORRUPT", "五分钟导读校验失败");
    }
    const guide = artifact.guide;
    if (
      !guide
      || typeof guide !== "object"
      || Array.isArray(guide)
      || guide.paper_id !== paperId
      || !isNonEmptyString(guide.problem)
      || !isNonEmptyString(guide.why_read)
      || !isNonEmptyString(guide.intuition)
      || !isNonEmptyString(guide.evidence)
      || !isNonEmptyString(guide.limitations)
      || !Array.isArray(guide.questions)
      || guide.questions.length < 2
      || guide.questions.length > 3
      || guide.questions.some((question) => !isNonEmptyString(question))
      || !Array.isArray(guide.evidence_refs)
      || guide.evidence_refs.length === 0
      || guide.evidence_refs.length > 8
    ) {
      throw artifactError("GUIDE_CORRUPT", "五分钟导读校验失败");
    }
    const blockIds = new Set(document.blocks.map((block) => block.block_id));
    const referenceIds = new Set();
    for (const blockId of guide.evidence_refs) {
      if (
        !isNonEmptyString(blockId)
        || !blockIds.has(blockId)
        || referenceIds.has(blockId)
      ) {
        throw artifactError("GUIDE_CORRUPT", "五分钟导读的正文引用校验失败");
      }
      referenceIds.add(blockId);
    }
    const provenance = artifact.provenance;
    if (
      !provenance
      || typeof provenance !== "object"
      || Array.isArray(provenance)
      || !isNonEmptyString(provenance.source)
      || !isNonEmptyString(provenance.prompt_id)
      || !isNonEmptyString(provenance.prompt_version)
      || !isNonEmptyString(provenance.input_hash)
    ) {
      throw artifactError("GUIDE_CORRUPT", "五分钟导读的生成记录校验失败");
    }
    return artifact;
  }

  async function readGuideArtifact({
    runId,
    paperId,
    revision,
    providerId,
    modelId,
    document,
  }) {
    const names = guideArtifactNames(paperId);
    let artifact;
    let markdown;
    try {
      [artifact, markdown] = await Promise.all([
        runStore.readArtifact(runId, names.json),
        runStore.readArtifact(runId, names.markdown),
      ]);
    } catch {
      throw artifactError("GUIDE_CORRUPT", "五分钟导读产物缺失或损坏");
    }
    return validateGuideArtifact({
      artifact,
      markdown,
      runId,
      paperId,
      revision,
      providerId,
      modelId,
      document,
    });
  }

  function guidePaperState(artifact, revision) {
    return {
      status: "ready",
      revision,
      artifact_json: guideArtifactNames(artifact.paper_id).json,
      artifact_markdown: guideArtifactNames(artifact.paper_id).markdown,
      source: artifact.provenance.source,
      provider_id: artifact.provenance.provider_id ?? null,
      model_id: artifact.provenance.model_id ?? null,
      prompt_id: artifact.provenance.prompt_id,
      prompt_version: artifact.provenance.prompt_version,
      input_hash: artifact.provenance.input_hash,
      error: null,
    };
  }

  async function reuseGuideArtifact({
    runId,
    paperId,
    document,
    providerId,
    modelId,
  }) {
    try {
      const artifact = await readGuideArtifact({
        runId,
        paperId,
        revision: document.revision,
        providerId,
        modelId,
        document,
      });
      if (
        activeGuidePrompt
        && (
          artifact.provenance.prompt_version !== activeGuidePrompt.version
          || artifact.provenance.prompt_hash !== activeGuidePrompt.prompt_hash
        )
      ) {
        return null;
      }
      return artifact;
    } catch {
      return null;
    }
  }

  async function generatePaperGuide(runId, paperId, providerId, modelId, reasoningEffort = null) {
    const { paper } = await runPaper(runId, paperId);
    const document = await getPaperDocument(runId, paperId);
    const reused = await reuseGuideArtifact({
      runId,
      paperId,
      document,
      providerId,
      modelId,
    });
    if (reused) {
      await update(runId, (current) => {
        const guides = normalizedGuides(current);
        return {
          guides: {
            ...guides,
            papers: {
              ...guides.papers,
              [paperId]: guidePaperState(reused, document.revision),
            },
          },
        };
      }, {
        type: "guide_paper_reused",
        paper_id: paperId,
        revision: document.revision,
      });
      return;
    }

    await update(runId, (current) => {
      const guides = normalizedGuides(current);
      return {
        guides: {
          ...guides,
          papers: {
            ...guides.papers,
            [paperId]: {
              status: "running",
              revision: document.revision,
              error: null,
            },
          },
        },
      };
    }, {
      type: "guide_paper_started",
      paper_id: paperId,
      revision: document.revision,
    });

    const generated = await guideGenerator({
      paper,
      document,
      providerId,
      modelId,
      modelProviders: withReasoningEffort(modelProviders, reasoningEffort),
      modelMode,
    });
    const artifact = {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      revision: document.revision,
      requested_provider_id: providerId,
      requested_model_id: modelId,
      guide: generated.guide,
      provenance: {
        source: generated.source,
        provider_id: generated.provider_id ?? null,
        model_id: generated.model_id ?? null,
        prompt_id: generated.prompt_id,
        prompt_version: generated.prompt_version,
        prompt_hash: generated.prompt_hash ?? null,
        input_hash: generated.input_hash,
        input_block_count: generated.input_block_count ?? null,
        input_chars: generated.input_chars ?? null,
        operation_id: generated.operation_id ?? null,
        upstream_request_id: generated.upstream_request_id ?? null,
        usage: generated.usage ?? null,
      },
      generated_at: new Date().toISOString(),
    };
    const markdown = guideMarkdown(paper, generated.guide);
    validateGuideArtifact({
      artifact,
      markdown,
      runId,
      paperId,
      revision: document.revision,
      providerId,
      modelId,
      document,
    });
    const names = guideArtifactNames(paperId);
    await runStore.writeArtifact(runId, names.json, artifact);
    await runStore.writeArtifact(runId, names.markdown, markdown);
    await update(runId, (current) => {
      const guides = normalizedGuides(current);
      return {
        guides: {
          ...guides,
          papers: {
            ...guides.papers,
            [paperId]: guidePaperState(artifact, document.revision),
          },
        },
      };
    }, {
      type: "guide_paper_completed",
      paper_id: paperId,
      revision: document.revision,
      source: generated.source,
    });
  }

  async function finishGuideJob(runId, job) {
    return update(runId, (current) => {
      const guides = normalizedGuides(current);
      const requested = [...job.requestedIds];
      const states = requested.map((paperId) => guides.papers[paperId]?.status);
      const readyCount = states.filter((status) => status === "ready").length;
      const allReady = requested.length > 0 && readyCount === requested.length;
      const guideStatus = allReady ? "ready" : readyCount > 0 ? "partial" : "failed";
      return {
        status: allReady ? "guide_ready" : "review_ready",
        phase: allReady ? "guide_review" : "candidate_review",
        paused_reason: allReady
          ? "等待决定只收藏或进入精读"
          : readyCount > 0
            ? "部分五分钟导读生成失败；成功结果已保留，可重试失败论文"
            : "五分钟导读生成失败；候选仍可审阅并重试",
        guides: {
          ...guides,
          status: guideStatus,
          requested_paper_ids: requested,
          provider_id: job.providerId,
          model_id: job.modelId,
        },
      };
    }, {
      type: "guide_generation_completed",
      requested_paper_ids: [...job.requestedIds],
    });
  }

  async function executeGuideJob(runId, job) {
    while (true) {
      const paperId = [...job.requestedIds].find((id) => !job.processedIds.has(id));
      if (!paperId) break;
      job.processedIds.add(paperId);
      try {
        await generatePaperGuide(runId, paperId, job.providerId, job.modelId, job.reasoningEffort);
      } catch (error) {
        await update(runId, (current) => {
          const guides = normalizedGuides(current);
          return {
            guides: {
              ...guides,
              papers: {
                ...guides.papers,
                [paperId]: {
                  ...guides.papers[paperId],
                  status: "failed",
                  error: publicError(error),
                },
              },
            },
          };
        }, {
          type: "guide_paper_failed",
          paper_id: paperId,
          error: publicError(error),
        });
      }
    }
    return finishGuideJob(runId, job);
  }

  async function validateGuideRequest(runId, paperIds, providerId, modelId) {
    if (
      !Array.isArray(paperIds)
      || paperIds.length < 1
      || paperIds.length > 2
      || new Set(paperIds).size !== paperIds.length
    ) {
      throw artifactError(
        "GUIDE_SELECTION_INVALID",
        "每次必须选择一至两篇不同论文生成导读",
        400,
      );
    }
    if (
      !isNonEmptyString(providerId)
      || !isNonEmptyString(modelId)
      || typeof modelProviders?.supports !== "function"
      || !modelProviders.supports(providerId, modelId)
    ) {
      throw artifactError(
        "GUIDE_PROVIDER_UNSUPPORTED",
        "服务商或模型不支持五分钟导读",
        400,
      );
    }
    for (const paperId of paperIds) {
      await getPaperDocument(runId, paperId);
    }
  }

  async function withGuideStartLock(runId, operation) {
    const previous = guideStartLocks.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    guideStartLocks.set(runId, current);
    try {
      return await current;
    } finally {
      if (guideStartLocks.get(runId) === current) guideStartLocks.delete(runId);
    }
  }

  function startGuides(runId, {
    paperIds,
    providerId = defaults.providerId,
    modelId = defaults.modelId,
    thinkingLevel = null,
  } = {}) {
    return withGuideStartLock(runId, async () => {
      await validateGuideRequest(runId, paperIds, providerId, modelId);
      const existingJob = guideInFlight.get(runId);
      if (existingJob) {
        if (
          existingJob.providerId !== providerId
          || existingJob.modelId !== modelId
        ) {
          throw artifactError(
            "GUIDE_IN_PROGRESS_CONFLICT",
            "本轮导读正在使用另一个模型生成",
          );
        }
        const merged = new Set([...existingJob.requestedIds, ...paperIds]);
        if (merged.size > 2) {
          throw artifactError(
            "GUIDE_SELECTION_INVALID",
            "本轮导读最多包含两篇论文",
            400,
          );
        }
        paperIds.forEach((paperId) => existingJob.requestedIds.add(paperId));
        return runStore.getRun(runId);
      }

      const job = {
        providerId,
        modelId,
        reasoningEffort: reasoningEffortFor(providerId, thinkingLevel),
        requestedIds: new Set(paperIds),
        processedIds: new Set(),
        promise: null,
      };
      const started = await update(runId, (current) => {
        const guides = normalizedGuides(current);
        const papers = Object.fromEntries(paperIds.map((paperId) => [
          paperId,
          {
            ...(guides.papers[paperId] ?? {}),
            status: "queued",
            error: null,
          },
        ]));
        return {
          status: "preparing_guides",
          phase: "guide_generation",
          paused_reason: null,
          guides: {
            status: "running",
            requested_paper_ids: [...paperIds],
            provider_id: providerId,
            model_id: modelId,
            papers,
          },
        };
      }, {
        type: "guide_generation_started",
        requested_paper_ids: [...paperIds],
        provider_id: providerId,
        model_id: modelId,
      });
      job.promise = executeGuideJob(runId, job)
        .finally(() => guideInFlight.delete(runId));
      guideInFlight.set(runId, job);
      return started;
    });
  }

  async function getPaperGuide(runId, paperId) {
    const { run, paper } = await runPaper(runId, paperId);
    const guides = normalizedGuides(run);
    const state = guides.papers[paperId];
    if (state?.status !== "ready") {
      throw artifactError("GUIDE_NOT_READY", "五分钟导读尚未准备完成");
    }
    const document = await getPaperDocument(runId, paperId);
    if (state.revision !== document.revision) {
      throw artifactError("GUIDE_STALE", "论文正文已变化，需要重新生成五分钟导读");
    }
    const artifact = await readGuideArtifact({
      runId,
      paperId,
      revision: document.revision,
      providerId: guides.provider_id,
      modelId: guides.model_id,
      document,
    });
    const blocks = new Map(document.blocks.map((block) => [block.block_id, block]));
    return {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      document_revision: document.revision,
      paper: {
        title: paper.title,
        authors: paper.authors ?? [],
        venue: paper.venue ?? "",
        published_at: paper.published_at ?? null,
      },
      guide: artifact.guide,
      references: artifact.guide.evidence_refs.map((blockId) => {
        const block = blocks.get(blockId);
        return {
          block_id: block.block_id,
          path: [...block.path],
          ordinal: block.ordinal,
          excerpt: String(block.text || block.markdown)
            .trim()
            .replaceAll(/\s+/g, " ")
            .slice(0, 240),
        };
      }),
      provenance: structuredClone(artifact.provenance),
    };
  }

  function waitForRun(runId) {
    return inFlight.get(runId) ?? Promise.resolve(runStore.getRun(runId));
  }

  function translationArtifactName(paperId) {
    return `translation/${safeName(paperId)}.json`;
  }

  function translationKey(runId, paperId) {
    return `${runId}::${paperId}`;
  }

  async function readTranslationArtifact(runId, paperId) {
    try {
      const artifact = await runStore.readArtifact(runId, translationArtifactName(paperId));
      if (
        !artifact
        || artifact.schema_version !== 1
        || artifact.run_id !== runId
        || artifact.paper_id !== paperId
        || typeof artifact.document_revision !== "string"
        || !artifact.blocks
        || typeof artifact.blocks !== "object"
        || Array.isArray(artifact.blocks)
      ) return null;
      return artifact;
    } catch {
      return null;
    }
  }

  function translationArtifactMatchesProfile(artifact, documentRevision) {
    return Boolean(
      artifact
      && artifact.document_revision === documentRevision
      && artifact.provider_id === translationProfile.providerId
      && artifact.model_id === translationProfile.modelId
      && artifact.reasoning_effort === translationProfile.reasoningEffort
      && artifact.prompt_id === translationProfile.promptId
      && artifact.prompt_version === translationProfile.promptVersion
      && artifact.prompt_hash === translationProfile.promptHash
    );
  }

  function generatedTranslationMatchesProfile(generated) {
    return Boolean(
      generated
      && generated.provider_id === translationProfile.providerId
      && generated.model_id === translationProfile.modelId
      && generated.reasoning_effort === translationProfile.reasoningEffort
      && generated.prompt_id === translationProfile.promptId
      && generated.prompt_version === translationProfile.promptVersion
      && generated.prompt_hash === translationProfile.promptHash
    );
  }

  function translationProgress(document, blocks = {}) {
    let total = 0;
    let translated = 0;
    let passthrough = 0;
    for (const block of document.blocks) {
      if (!isTranslatableBlock(block)) continue;
      if (isMathOnlyBlock(block)) {
        passthrough += 1;
        continue;
      }
      total += 1;
      if (typeof blocks[block.block_id] === "string" && blocks[block.block_id]) {
        translated += 1;
      }
    }
    return { total, translated, passthrough };
  }

  function publicTranslation(runId, paperId, document, artifact, job) {
    const matching = artifact && artifact.document_revision === document.revision
      ? artifact
      : null;
    const blocks = matching ? { ...matching.blocks } : {};
    const { total, translated, passthrough } = translationProgress(document, blocks);
    const running = Boolean(job && job.revision === document.revision);
    const status = running
      ? job.pauseRequested ? "pausing" : "running"
      : !matching
        ? artifact ? "stale" : "not_started"
        : matching.status === "ready" && translated >= total
          ? "ready"
          : matching.status === "paused" || ["running", "pausing"].includes(matching.status)
            ? "paused"
            : translated > 0 || matching.last_error
              ? "partial"
              : "not_started";
    return {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      document_revision: document.revision,
      status,
      provider_id: matching?.provider_id ?? job?.providerId ?? translationProfile.providerId,
      model_id: matching?.model_id ?? job?.modelId ?? translationProfile.modelId,
      reasoning_effort: matching?.reasoning_effort
        ?? job?.reasoningEffort
        ?? translationProfile.reasoningEffort,
      prompt_id: matching?.prompt_id ?? translationProfile.promptId,
      prompt_version: matching?.prompt_version ?? translationProfile.promptVersion,
      total_blocks: total,
      translated_blocks: translated,
      passthrough_blocks: passthrough,
      blocks,
      error: matching?.last_error ?? null,
      updated_at: matching?.updated_at ?? null,
    };
  }

  async function getPaperTranslation(runId, paperId) {
    const document = await getPaperDocument(runId, paperId);
    const key = translationKey(runId, paperId);
    const job = translationInFlight.get(key);
    let artifact = await readTranslationArtifact(runId, paperId);
    if (
      artifact?.document_revision === document.revision
      && !job
      && ["running", "pausing"].includes(artifact.status)
    ) {
      artifact = {
        ...artifact,
        status: "paused",
        updated_at: new Date().toISOString(),
      };
      await runStore.writeArtifact(runId, translationArtifactName(paperId), artifact);
    }
    return publicTranslation(
      runId,
      paperId,
      document,
      artifact,
      job,
    );
  }

  async function generatePaperTranslation(runId, paperId) {
    const document = await getPaperDocument(runId, paperId);
    if (
      typeof modelProviders?.supports !== "function"
      || !modelProviders.supports(
        translationProfile.providerId,
        translationProfile.modelId,
      )
    ) {
      throw artifactError("TRANSLATION_PROVIDER_UNSUPPORTED", "服务商或模型不支持全文翻译", 400);
    }
    const key = translationKey(runId, paperId);
    const existing = translationInFlight.get(key);
    if (existing) {
      return publicTranslation(
        runId,
        paperId,
        document,
        await readTranslationArtifact(runId, paperId),
        existing,
      );
    }
    let artifact = await readTranslationArtifact(runId, paperId);
    // A translation for an older body is discarded; the reader never mixes revisions.
    if (artifact && artifact.document_revision !== document.revision) artifact = null;
    // This POST is the explicit user action that starts the current fixed
    // translation profile. A legacy generated artifact remains readable until
    // this point, then restarts cleanly instead of mixing model provenance.
    if (artifact && !translationArtifactMatchesProfile(artifact, document.revision)) artifact = null;
    const startedAt = new Date().toISOString();
    const nextArtifact = artifact ?? {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      document_revision: document.revision,
      provider_id: translationProfile.providerId,
      model_id: translationProfile.modelId,
      reasoning_effort: translationProfile.reasoningEffort,
      prompt_id: translationProfile.promptId,
      prompt_version: translationProfile.promptVersion,
      prompt_hash: translationProfile.promptHash,
      status: "running",
      blocks: {},
      usage_receipts: [],
      last_error: null,
      generated_at: startedAt,
      updated_at: startedAt,
    };
    // Formula-only blocks pass through unchanged without spending a model call.
    for (const block of document.blocks) {
      if (!isTranslatableBlock(block) || !isMathOnlyBlock(block)) continue;
      if (nextArtifact.blocks[block.block_id]) continue;
      nextArtifact.blocks[block.block_id] = String(block.text ?? block.markdown ?? "").trim();
    }
    const batches = translationBatches(
      document.blocks,
      new Set(Object.keys(nextArtifact.blocks)),
    );
    const total = translationProgress(document, nextArtifact.blocks).total;
    if (batches.length === 0) {
      nextArtifact.status = translationProgress(document, nextArtifact.blocks).translated >= total
        ? "ready"
        : "partial";
      nextArtifact.last_error = null;
      nextArtifact.updated_at = new Date().toISOString();
      await runStore.writeArtifact(runId, translationArtifactName(paperId), nextArtifact);
      return publicTranslation(runId, paperId, document, nextArtifact, null);
    }
    nextArtifact.status = "running";
    nextArtifact.provider_id = translationProfile.providerId;
    nextArtifact.model_id = translationProfile.modelId;
    nextArtifact.reasoning_effort = translationProfile.reasoningEffort;
    nextArtifact.prompt_id = translationProfile.promptId;
    nextArtifact.prompt_version = translationProfile.promptVersion;
    nextArtifact.prompt_hash = translationProfile.promptHash;
    nextArtifact.last_error = null;
    nextArtifact.updated_at = startedAt;
    await runStore.writeArtifact(runId, translationArtifactName(paperId), nextArtifact);
    const job = {
      revision: document.revision,
      providerId: translationProfile.providerId,
      modelId: translationProfile.modelId,
      reasoningEffort: translationProfile.reasoningEffort,
      pauseRequested: false,
      artifact: nextArtifact,
      promise: null,
    };
    job.promise = (async () => {
      let lastError = null;
      for (const batch of batches) {
        let stopAfterBatch = false;
        if (job.pauseRequested) {
          nextArtifact.status = "paused";
          nextArtifact.updated_at = new Date().toISOString();
          await runStore.writeArtifact(runId, translationArtifactName(paperId), nextArtifact);
          return;
        }
        try {
          const generated = await translationGenerator({
            paperId,
            batch,
            providerId: translationProfile.providerId,
            modelId: translationProfile.modelId,
            reasoningEffort: translationProfile.reasoningEffort,
            modelProviders,
            modelMode,
          });
          if (!generatedTranslationMatchesProfile(generated)) {
            throw artifactError(
              "TRANSLATION_PROFILE_MISMATCH",
              "翻译批次返回的模型或提示来源与当前译文档案不一致",
              502,
            );
          }
          if (generated.operation_id && generated.usage) {
            nextArtifact.usage_receipts = [
              ...(Array.isArray(nextArtifact.usage_receipts)
                ? nextArtifact.usage_receipts
                : []),
              {
                schema_version: 1,
                workflow_scope: "paper_reading",
                step: "translation",
                occurred_at: new Date().toISOString(),
                run_id: runId,
                paper_id: paperId,
                provider_id: generated.provider_id,
                model_id: generated.model_id,
                operation_id: generated.operation_id,
                upstream_request_id: generated.upstream_request_id ?? null,
                usage: generated.usage,
              },
            ];
          }
          Object.assign(nextArtifact.blocks, generated.translations);
        } catch (error) {
          // A failed batch is recorded; finished batches stay durable.
          lastError = publicError(error);
          stopAfterBatch = !lastError.retryable;
        }
        nextArtifact.last_error = lastError;
        nextArtifact.updated_at = new Date().toISOString();
        const complete = translationProgress(document, nextArtifact.blocks).translated >= total;
        nextArtifact.status = complete
          ? "ready"
          : job.pauseRequested
            ? "paused"
            : stopAfterBatch
              ? "partial"
              : "running";
        await runStore.writeArtifact(runId, translationArtifactName(paperId), nextArtifact);
        if (job.pauseRequested || complete || stopAfterBatch) return;
      }
      nextArtifact.status = translationProgress(document, nextArtifact.blocks).translated >= total
        ? "ready"
        : "partial";
      nextArtifact.last_error = lastError;
      nextArtifact.updated_at = new Date().toISOString();
      await runStore.writeArtifact(runId, translationArtifactName(paperId), nextArtifact);
    })().finally(() => {
      if (translationInFlight.get(key) === job) translationInFlight.delete(key);
    });
    translationInFlight.set(key, job);
    return publicTranslation(runId, paperId, document, nextArtifact, job);
  }

  async function pausePaperTranslation(runId, paperId) {
    const document = await getPaperDocument(runId, paperId);
    const key = translationKey(runId, paperId);
    const job = translationInFlight.get(key);
    let artifact = job?.artifact ?? await readTranslationArtifact(runId, paperId);
    if (!artifact || artifact.document_revision !== document.revision) {
      return publicTranslation(runId, paperId, document, artifact, null);
    }
    if (job && job.revision === document.revision) {
      job.pauseRequested = true;
      artifact.status = "pausing";
      artifact.updated_at = new Date().toISOString();
      await runStore.writeArtifact(runId, translationArtifactName(paperId), artifact);
      return publicTranslation(runId, paperId, document, artifact, job);
    }
    if (["running", "pausing"].includes(artifact.status)) {
      artifact = {
        ...artifact,
        status: "paused",
        updated_at: new Date().toISOString(),
      };
      await runStore.writeArtifact(runId, translationArtifactName(paperId), artifact);
    }
    return publicTranslation(runId, paperId, document, artifact, null);
  }

  function waitForTranslation(runId, paperId) {
    return translationInFlight.get(translationKey(runId, paperId))?.promise
      ?? Promise.resolve();
  }

  function waitForGuides(runId) {
    return guideInFlight.get(runId)?.promise ?? Promise.resolve(runStore.getRun(runId));
  }

  reading = createReadingService({
    runStore,
    getPaperDocument,
    getRunPaper: async (runId, paperId, { paperOptional = false } = {}) => {
      if (paperOptional && paperId == null) {
        const run = await runStore.getRun(runId);
        if (!run) throw artifactError("RUN_NOT_FOUND", "运行不存在", 404);
        return { run, paper: null };
      }
      return runPaper(runId, paperId);
    },
    getProjectContext: projectContext.read,
    modelProviders,
    modelMode,
    defaultProviderId: defaults.providerId,
    defaultModelId: defaults.modelId,
  });
  obsidianPreview = obsidianPreviewService ?? (env.PI_OBSIDIAN_NOTE_DIR
    ? createObsidianPreviewService({
        runStore,
        getPaperReading: reading.getReading,
        obsidianNoteDir: env.PI_OBSIDIAN_NOTE_DIR,
      })
    : null);
  readingNoteAction = env.PI_OBSIDIAN_NOTE_DIR
    ? createReadingNoteActionService({
        runStore,
        getRunPaper: runPaper,
        getPaperReading: reading.getReading,
        obsidianNoteDir: env.PI_OBSIDIAN_NOTE_DIR,
      })
    : null;
  projectStatePreview = projectStatePreviewService
    ?? (env.PI_PROJECT_ROOT && env.PI_PROJECT_STATE_PATH
    ? createProjectStatePreviewService({
        runStore,
        getPaperReading: reading.getReading,
        projectRoot: env.PI_PROJECT_ROOT,
        projectStatePath: env.PI_PROJECT_STATE_PATH,
      })
    : null);

  async function createObsidianPreview(runId) {
    if (!obsidianPreview) {
      throw artifactError(
        "OBSIDIAN_NOT_CONFIGURED",
        "尚未配置 Obsidian 精读笔记目录",
      );
    }
    await reading.assertCanonicalForArchive(runId);
    return obsidianPreview.createPreview(runId);
  }

  function requireReadingNoteAction() {
    if (!readingNoteAction) {
      throw artifactError(
        "OBSIDIAN_NOT_CONFIGURED",
        "尚未配置 Obsidian 精读笔记目录",
      );
    }
    return readingNoteAction;
  }

  async function createReadingNoteProposal(runId, paperId, turnId, options) {
    return (await requireReadingNoteAction().createProposal(
      runId,
      paperId,
      turnId,
      options,
    )).reading;
  }

  async function commitReadingNoteProposal(runId, paperId, proposalId, options) {
    return (await requireReadingNoteAction().commitProposal(
      runId,
      paperId,
      proposalId,
      options,
    )).reading;
  }

  async function abandonReadingNoteProposal(runId, paperId, proposalId, options) {
    return (await requireReadingNoteAction().abandonProposal(
      runId,
      paperId,
      proposalId,
      options,
    )).reading;
  }

  function getReadingNoteProposal(runId, paperId, proposalId) {
    return requireReadingNoteAction().getProposal(runId, paperId, proposalId);
  }

  function getObsidianPreview(runId) {
    if (!obsidianPreview) {
      throw artifactError(
        "OBSIDIAN_NOT_CONFIGURED",
        "尚未配置 Obsidian 精读笔记目录",
      );
    }
    return obsidianPreview.getPreview(runId);
  }

  async function createProjectStatePreview(runId) {
    if (!projectStatePreview) {
      throw artifactError(
        "PROJECT_STATE_NOT_CONFIGURED",
        "尚未配置项目状态 Markdown",
      );
    }
    await reading.assertCanonicalForArchive(runId);
    return projectStatePreview.createPreview(runId);
  }

  function getProjectStatePreview(runId) {
    if (!projectStatePreview) {
      throw artifactError(
        "PROJECT_STATE_NOT_CONFIGURED",
        "尚未配置项目状态 Markdown",
      );
    }
    return projectStatePreview.getPreview(runId);
  }

  function archiveRequestHash(value) {
    return `sha256:${createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")}`;
  }

  function requireArchiveRequestId(value) {
    const requestId = String(value ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) {
      throw artifactError(
        "ARCHIVE_APPROVAL_REQUEST_INVALID",
        "归档确认请求标识无效",
        400,
      );
    }
    return requestId;
  }

  function archiveRequestIdentity(runId, request) {
    const clientRequestId = requireArchiveRequestId(request?.clientRequestId);
    const selectedTargets = [
      request?.obsidian ? "obsidian" : null,
      request?.zotero ? "zotero" : null,
      request?.projectState ? "project_state" : null,
    ].filter(Boolean);
    if (selectedTargets.length === 0) {
      throw artifactError(
        "ARCHIVE_APPROVAL_EMPTY",
        "至少选择一项归档写入",
        400,
      );
    }
    return {
      clientRequestId,
      selectedTargets,
      fingerprint: archiveRequestHash({
        run_id: runId,
        client_request_id: clientRequestId,
        obsidian: request.obsidian ?? null,
        zotero: request.zotero ?? null,
        project_state: request.projectState ?? null,
      }),
    };
  }

  async function validateArchiveCommit(runId, request) {
    const run = await runStore.getRun(runId);
    if (!run) throw artifactError("RUN_NOT_FOUND", "运行不存在", 404);
    const identity = archiveRequestIdentity(runId, request);
    if (request.obsidian) {
      if (!obsidianPreview) {
        throw artifactError(
          "OBSIDIAN_NOT_CONFIGURED",
          "尚未配置 Obsidian 精读笔记目录",
        );
      }
      await obsidianPreview.validateCommit(runId, request.obsidian);
    }
    if (request.zotero) {
      await zoteroArchival.validateCommit(runId, request.zotero);
    }
    if (request.projectState) {
      if (!projectStatePreview) {
        throw artifactError(
          "PROJECT_STATE_NOT_CONFIGURED",
          "尚未配置项目状态 Markdown",
        );
      }
      await projectStatePreview.validateCommit(runId, request.projectState);
    }
    return {
      ...identity,
    };
  }

  function archiveRequirementState(current) {
    const decisions = current.paper_decisions ?? {};
    const requiresReadingArchive = Object.values(decisions).includes("read");
    const requiresZotero = Object.values(decisions).some(
      (decision) => decision === "collect" || decision === "read",
    );
    const readingPaperIds = Object.entries(decisions)
      .filter(([, decision]) => decision === "read")
      .map(([paperId]) => paperId);
    const zoteroPaperIds = Object.entries(decisions)
      .filter(([, decision]) => decision === "collect" || decision === "read")
      .map(([paperId]) => paperId);
    const obsidianByPaper = new Map((current.obsidian?.proposals ?? []).map(
      (proposal) => [proposal.paper_id, proposal],
    ));
    const zoteroByPaper = new Map((current.zotero?.proposals ?? []).map(
      (proposal) => [proposal.paper_id, proposal],
    ));
    const obsidianCompleted = !requiresReadingArchive
      || readingPaperIds.every(
        (paperId) => obsidianByPaper.get(paperId)?.status === "committed",
      );
    const projectStateRequired = requiresReadingArchive;
    const projectStateCompleted = !projectStateRequired
      || current.project_state?.status === "completed";
    const zoteroCompleted = !requiresZotero
      || zoteroPaperIds.every(
        (paperId) => zoteroByPaper.get(paperId)?.status === "committed",
      );
    const blocked = (
      readingPaperIds.some((paperId) => {
        const proposal = obsidianByPaper.get(paperId);
        return proposal && (
          proposal.actionable === false
          || proposal.status === "blocked"
        );
      })
      || zoteroPaperIds.some((paperId) => {
        const proposal = zoteroByPaper.get(paperId);
        return proposal && (
          proposal.actionable === false
          || proposal.status === "blocked"
        );
      })
      || (
        Boolean(current.project_state?.proposal_id)
        && current.project_state?.actionable === false
      )
    );
    return {
      blocked,
      complete: obsidianCompleted && projectStateCompleted && zoteroCompleted,
      obsidianCompleted,
      projectStateCompleted,
      zoteroCompleted,
    };
  }

  async function finishArchiveBatch(runId, batch, {
    error = null,
  } = {}) {
    const current = await runStore.getRun(runId);
    const {
      blocked,
      complete,
    } = archiveRequirementState(current);
    const anyCommitted = (
      current.obsidian?.status === "completed"
      || current.project_state?.status === "completed"
      || (current.zotero?.proposals ?? []).some(
        (proposal) => proposal.status === "committed",
      )
    );
    const completedAt = new Date().toISOString();
    const status = complete
      ? "completed"
      : blocked
        ? "manual_action_required"
        : anyCommitted
          ? "partial"
          : "awaiting_approval";
    const archiveStatus = complete
      ? "completed"
      : blocked
        ? "manual_action_required"
        : error
          ? "failed"
          : "partial";
    const updated = await runStore.updateRun(runId, {
      status,
      phase: complete
        ? "archive_completed"
        : status === "manual_action_required"
          ? "archive_manual_action"
          : "archive_preview",
      paused_reason: complete
        ? null
        : blocked
          ? "部分归档项需要人工处理；已成功写入不会重复执行"
          : error?.message
            ?? "归档尚未全部完成，可只重试失败项",
      archive_batch: {
        ...batch,
        status: archiveStatus,
        last_error: error ? publicError(error) : null,
        completed_at: completedAt,
        updated_at: completedAt,
      },
    });
    await runStore.appendEvent(runId, {
      type: "archive_batch_completed",
      batch_id: batch.batch_id,
      status: archiveStatus,
      error: error ? publicError(error) : null,
      at: completedAt,
    });
    return updated;
  }

  async function executeArchiveCommit(runId, request, batch) {
    try {
      if (request.simulateObsidianFailure && request.obsidian) {
        throw artifactError(
          "OBSIDIAN_WRITE_SIMULATED_FAILURE",
          "模拟 Obsidian 写入失败",
          500,
        );
      }
      if (request.obsidian) {
        const beforeObsidian = await runStore.getRun(runId);
        const next = archiveRequirementState(beforeObsidian).obsidianCompleted
          ? beforeObsidian
          : await obsidianPreview.commit(runId, {
              clientRequestId: `${batch.client_request_id}:obsidian`,
              ...request.obsidian,
            });
        if (!archiveRequirementState(next).obsidianCompleted) {
          throw artifactError(
            "OBSIDIAN_WRITE_INCOMPLETE",
            next.obsidian?.last_error?.message
              ?? "仍有精读论文未完成 Obsidian 写入与核验",
            409,
          );
        }
      }
      if (request.zotero) {
        const current = await runStore.getRun(runId);
        if (!archiveRequirementState(current).obsidianCompleted) {
          throw artifactError(
            "ARCHIVE_DEPENDENCY_PENDING",
            "请先完成并核验 Obsidian 精读笔记，再写入 Zotero",
            409,
          );
        }
        if (!archiveRequirementState(current).zoteroCompleted) {
          if (current.zotero?.status === "committing") {
            await zoteroArchival.resumeCommit(runId);
          } else {
            await zoteroArchival.startCommit(runId, request.zotero);
          }
          await zoteroArchival.waitForCommit(runId);
        }
        await runStore.updateRun(runId, {
          status: "committing",
          phase: "archive_commit",
          paused_reason: null,
        });
        const next = await runStore.getRun(runId);
        if (!archiveRequirementState(next).zoteroCompleted) {
          const error = artifactError(
            "ZOTERO_WRITE_INCOMPLETE",
            next.zotero?.last_error?.message
              ?? next.paused_reason
              ?? "Zotero 写入尚未全部核验",
            409,
          );
          error.retryable = next.zotero?.status !== "blocked";
          throw error;
        }
      }
      if (request.projectState) {
        const current = await runStore.getRun(runId);
        const requirements = archiveRequirementState(current);
        if (
          !requirements.obsidianCompleted
          || !requirements.zoteroCompleted
        ) {
          throw artifactError(
            "ARCHIVE_DEPENDENCY_PENDING",
            "请先完成并核验 Obsidian 与 Zotero 归档，再更新项目状态",
            409,
          );
        }
        const next = requirements.projectStateCompleted
          ? current
          : await projectStatePreview.commit(runId, {
              clientRequestId: `${batch.client_request_id}:project-state`,
              ...request.projectState,
            });
        if (next.project_state?.status !== "completed") {
          throw artifactError(
            "PROJECT_STATE_WRITE_INCOMPLETE",
            next.project_state?.last_error?.message ?? "项目状态写入尚未核验",
            409,
          );
        }
      }
      return finishArchiveBatch(runId, batch);
    } catch (error) {
      return finishArchiveBatch(runId, batch, { error });
    }
  }

  async function resumeArchiveCommit(runId, currentRun = null) {
    if (archiveCommitJobs.has(runId)) return runStore.getRun(runId);
    const run = currentRun ?? await runStore.getRun(runId);
    const batch = run?.archive_batch;
    if (
      !batch
      || batch.status !== "committing"
      || typeof batch.artifact_path !== "string"
    ) {
      return run;
    }
    let artifact;
    try {
      artifact = await runStore.readArtifact(runId, batch.artifact_path);
    } catch {
      return finishArchiveBatch(runId, batch, {
        error: artifactError(
          "ARCHIVE_BATCH_RECOVERY_CORRUPT",
          "联合归档恢复记录缺失或损坏，需要重新生成精确预览",
          409,
        ),
      });
    }
    const request = {
      obsidian: artifact?.request?.obsidian ?? null,
      zotero: artifact?.request?.zotero ?? null,
      projectState: artifact?.request?.project_state ?? null,
      simulateObsidianFailure: false,
    };
    const fingerprint = archiveRequestHash({
      run_id: runId,
      client_request_id: batch.client_request_id,
      obsidian: request.obsidian,
      zotero: request.zotero,
      project_state: request.projectState,
    });
    if (
      artifact?.batch_id !== batch.batch_id
      || artifact?.request_fingerprint !== batch.request_fingerprint
      || fingerprint !== batch.request_fingerprint
    ) {
      return finishArchiveBatch(runId, batch, {
        error: artifactError(
          "ARCHIVE_BATCH_RECOVERY_CORRUPT",
          "联合归档恢复记录校验失败，需要重新生成精确预览",
          409,
        ),
      });
    }
    await runStore.appendEvent(runId, {
      type: "archive_batch_resumed",
      batch_id: batch.batch_id,
      at: new Date().toISOString(),
    });
    await runStore.updateRun(runId, {
      status: "committing",
      phase: "archive_commit",
      paused_reason: null,
    });
    const job = executeArchiveCommit(runId, request, batch)
      .finally(() => archiveCommitJobs.delete(runId));
    archiveCommitJobs.set(runId, job);
    return runStore.getRun(runId);
  }

  async function getRun(runId) {
    const run = await runStore.getRun(runId);
    if (
      run?.archive_batch?.status === "committing"
      || run?.status === "committing"
    ) return resumeRun(runId);
    return run;
  }

  async function listRuns() {
    const runs = await runStore.listRuns();
    await Promise.all(runs
      .filter((run) => (
        run.archive_batch?.status === "committing"
        || run.status === "committing"
      ))
      .map((run) => resumeRun(run.run_id)));
    return runStore.listRuns();
  }

  async function getUsage({ period = "30d" } = {}) {
    return modelUsageService.getUsage({ period });
  }

  function withArchiveStartLock(runId, task) {
    const previous = archiveStartLocks.get(runId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    archiveStartLocks.set(runId, operation);
    return operation.finally(() => {
      if (archiveStartLocks.get(runId) === operation) {
        archiveStartLocks.delete(runId);
      }
    });
  }

  async function startArchiveCommit(runId, request = {}) {
    return withArchiveStartLock(runId, async () => {
      await reading.assertCanonicalForArchive(runId);
      const identity = archiveRequestIdentity(runId, request);
      const current = await runStore.getRun(runId);
      if (!current) throw artifactError("RUN_NOT_FOUND", "运行不存在", 404);
      if (
        current.archive_batch?.client_request_id === identity.clientRequestId
      ) {
        if (
          current.archive_batch.request_fingerprint
          !== identity.fingerprint
        ) {
          throw artifactError(
            "ARCHIVE_APPROVAL_REQUEST_CONFLICT",
            "同一归档确认请求标识已用于不同预览内容",
            409,
          );
        }
        return current;
      }
      if (
        archiveCommitJobs.has(runId)
        || current.archive_batch?.status === "committing"
      ) {
        throw artifactError(
          "ARCHIVE_APPROVAL_IN_PROGRESS",
          "当前已有联合归档正在执行，请等待完成后再重试",
          409,
        );
      }
      const validated = await validateArchiveCommit(runId, request);
      const approvedAt = new Date().toISOString();
      const batch = {
        schema_version: 1,
        batch_id: `archive-${validated.fingerprint.slice(7, 23)}`,
        client_request_id: validated.clientRequestId,
        request_fingerprint: validated.fingerprint,
        selected_targets: validated.selectedTargets,
        status: "committing",
        approved_at: approvedAt,
        completed_at: null,
        last_error: null,
        updated_at: approvedAt,
      };
      const artifactPath = `archive-batches/${batch.batch_id}.json`;
      await runStore.writeArtifact(runId, artifactPath, {
        ...batch,
        request: {
          obsidian: request.obsidian ?? null,
          zotero: request.zotero ?? null,
          project_state: request.projectState ?? null,
        },
      });
      batch.artifact_path = artifactPath;
      const started = await runStore.updateRun(runId, {
        status: "committing",
        phase: "archive_commit",
        paused_reason: null,
        archive_batch: batch,
      });
      await runStore.appendEvent(runId, {
        type: "archive_batch_approved",
        batch_id: batch.batch_id,
        selected_targets: batch.selected_targets,
        at: approvedAt,
      });
      const job = executeArchiveCommit(runId, request, batch)
        .finally(() => archiveCommitJobs.delete(runId));
      archiveCommitJobs.set(runId, job);
      return started;
    });
  }

  function waitForArchiveCommit(runId) {
    return archiveCommitJobs.get(runId) ?? Promise.resolve(runStore.getRun(runId));
  }

  async function createZoteroProposal(runId, options) {
    await reading.assertCanonicalForArchive(runId);
    return zoteroArchival.createProposal(runId, options);
  }

  async function startZoteroCommit(runId, request) {
    await reading.assertCanonicalForArchive(runId);
    return zoteroArchival.startCommit(runId, request);
  }

  return Object.freeze({
    askReadingQuestion: reading.askQuestion,
    abandonReadingNoteProposal,
    commitReadingNoteProposal,
    createReadingNoteProposal,
    pinReadingConclusion: reading.pinConclusion,
    promoteReadingConversation: reading.promoteConversation,
    generateReadingStage: reading.generateStage,
    getRun,
    getUsage,
    getPaperDocument,
    getPaperGuide,
    getPaperImage,
    getPaperPdf,
    getPaperReading: reading.getReading,
    getPaperTranslation,
    generatePaperTranslation,
    pausePaperTranslation,
    waitForTranslation,
    getProjectContext: projectContext.read,
    getReadingNoteProposal,
    getObsidianPreview,
    getProjectStatePreview,
    getZoteroProposal: zoteroArchival.getProposal,
    getZoteroStatus: zoteroAdapter.status,
    getZoteroTargets: zoteroArchival.getTargets,
    listRuns,
    readEvents: runStore.readEvents,
    resumeRun,
    searchVenues,
    getVenueSearchConversation,
    listVenueSearchConversations,
    createVenueSearchConversation,
    deleteVenueSearchConversation,
    submitVenueSearchTurn,
    getVenueSearchTurnProgress,
    addVenueSearchPapersToWeekly,
    retryPaperDocument,
    restartReadingFromGuide: reading.restartFromGuide,
    resetPaperReading: reading.resetPaperReading,
    createReadingConversation: reading.createConversation,
    switchReadingConversation: reading.switchConversation,
    unpinReadingConclusion: reading.unpinConclusion,
    savePaperDecisions: reading.setDecisions,
    saveReadingPosition: reading.savePosition,
    sendReadingChatMessage: reading.sendChatMessage,
    getReadingChatProgress: reading.getChatProgress,
    startGuides,
    startRun,
    subscribeEvents: runStore.subscribeEvents,
    createZoteroProposal,
    createObsidianPreview,
    createProjectStatePreview,
    startArchiveCommit,
    startZoteroCommit,
    waitForArchiveCommit,
    waitForGuides,
    waitForRun,
    waitForZoteroCommit: zoteroArchival.waitForCommit,
  });
}
