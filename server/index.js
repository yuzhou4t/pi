import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { CandidateSummaryError, createCandidateSummaryService } from "./candidateSummaries.js";
import { HttpRangeError, parseByteRange } from "./httpRange.js";
import { createJournalWorkflowService } from "./journal/workflowService.js";
import { combineModelUsageReports } from "./journal/modelUsageService.js";
import { createModelUsageLedger } from "./modelUsageLedger.js";
import {
  createLarkCliNotificationTransport,
  createLifecycleNotificationDispatcher,
  createNotificationService,
} from "./notifications/index.js";
import {
  createNotificationHttpApi,
  sendNotificationHttpError,
} from "./notifications/httpApi.js";
import { SOURCE_REGISTRY, SOURCE_REGISTRY_VERSION } from "./journal/sourceRegistry.js";
import { createMonthlyJournalScheduler } from "./journal/monthlyScheduler.js";
import {
  ProjectWorkError,
  projectWorkError,
  safeProjectWorkError,
} from "./project-work/errors.js";
import { createProjectWorkService } from "./project-work/projectWorkService.js";
import {
  normalizeProjectWorkRuntimeUrl,
  probeProjectWorkRuntime,
  proxyProjectWorkRequest,
} from "./project-work/runtimeProxy.js";
import {
  migrateRuntimeEnvelope,
  RUNTIME_SCHEMA_VERSION,
} from "./runtimeSchema.js";
import { createAllowedLocalWebOrigins } from "./localWebOrigin.js";
import {
  createCliConnectionAdapter,
  createCliDeliveryExecutor,
  createControlledCliRunner,
  createWorkerService,
} from "./worker/index.js";
import {
  createWorkerHttpApi,
  sendWorkerHttpError,
} from "./worker/httpApi.js";

const host = "127.0.0.1";
const port = Number(process.env.PI_API_PORT ?? process.env.PORT ?? 8787);
const allowedOrigins = createAllowedLocalWebOrigins(process.env.PI_LOCAL_WEB_URL);
const projectWorkClientRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const journalClientRequestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const piDataDir = path.resolve(process.env.PI_DATA_DIR || ".pi-agent");
const paperUsageLedger = createModelUsageLedger({ dataDir: piDataDir });
const candidateSummaries = createCandidateSummaryService({
  dataDir: piDataDir,
  usageRecorder: paperUsageLedger.capture,
});
const journalWorkflow = createJournalWorkflowService({
  dataDir: piDataDir,
  usageLedger: paperUsageLedger,
});
const projectWorkRuntimeOnly = process.env.PI_PROJECT_WORK_RUNTIME_ONLY === "1";
const configuredProjectWorkRuntimeUrl = normalizeProjectWorkRuntimeUrl(
  process.env.PI_PROJECT_WORK_RUNTIME_URL,
);
const localRuntimeServicesEnabled = !configuredProjectWorkRuntimeUrl;
const notificationService = localRuntimeServicesEnabled
  ? createNotificationService({
      storageRoot: piDataDir,
      returnEntryBaseUrl: process.env.PI_NOTIFICATION_RETURN_ENTRY_URL,
      transport: createLarkCliNotificationTransport({
        binary: process.env.PI_LARK_CLI_BIN || "lark-cli",
      }),
    })
  : null;
const notificationDispatcher = notificationService
  ? createLifecycleNotificationDispatcher({ notificationService })
  : null;
const workerCliRunner = localRuntimeServicesEnabled
  ? createControlledCliRunner({
      binaries: {
        lark: process.env.PI_LARK_CLI_BIN || "lark-cli",
        agent_mail: process.env.PI_AGENTLY_CLI_BIN || "agently-cli",
        ima: process.env.PI_IMA_NODE_BIN || process.execPath,
      },
      cwd: path.resolve(piDataDir, "worker", "files"),
    })
  : null;
const worker = workerCliRunner
  ? createWorkerService({
      storageRoot: piDataDir,
      executor: createCliDeliveryExecutor({ runner: workerCliRunner }),
      connections: createCliConnectionAdapter({ runner: workerCliRunner }),
    })
  : null;
const projectWork = configuredProjectWorkRuntimeUrl
  ? null
  : createProjectWorkService({
      onLifecycleEvent: notificationDispatcher?.dispatch,
    });

export function shutdownApiServer({
  server,
  dispose = () => undefined,
  timeoutMs = 1_750,
  onExit = () => process.exit(0),
  unrefTimeout = true,
}) {
  let completed = false;
  let disposed = false;
  let serverClosed = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (completed) return;
    completed = true;
    clearTimeout(forceTimer);
    resolveDone();
    onExit();
  };
  const finishWhenReady = () => {
    if (disposed && serverClosed) finish();
  };
  const forceTimer = setTimeout(() => {
    try {
      server.closeAllConnections?.();
    } finally {
      finish();
    }
  }, timeoutMs);
  if (unrefTimeout) forceTimer.unref?.();

  try {
    server.close(() => {
      serverClosed = true;
      finishWhenReady();
    });
    server.closeIdleConnections?.();
  } catch {
    serverClosed = true;
  }
  Promise.resolve()
    .then(dispose)
    .catch(() => undefined)
    .finally(() => {
      disposed = true;
      finishWhenReady();
    });
  return done;
}

function isJournalClientRequestId(value) {
  return typeof value === "string" && journalClientRequestIdPattern.test(value);
}

function publicPaper(paper) {
  if (!paper || typeof paper !== "object") return paper;
  const {
    raw_metadata: _rawMetadata,
    pdf_candidates: _pdfCandidates,
    ...safePaper
  } = paper;
  return safePaper;
}

function publicZoteroTarget(target) {
  if (!target || typeof target !== "object") return null;
  return {
    id: target.id ?? null,
    name: target.name ?? null,
    library_id: target.libraryId ?? target.library_id ?? null,
    library_name: target.libraryName ?? target.library_name ?? null,
    level: target.level ?? 0,
    path: Array.isArray(target.path) ? [...target.path] : [],
    editable: Boolean(target.editable),
    files_editable: Boolean(target.filesEditable ?? target.files_editable),
  };
}

function publicWorkflowError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    code: typeof error.code === "string" ? error.code : "JOURNAL_RESOURCE_FAILED",
    message: typeof error.message === "string" ? error.message : "工作流步骤失败",
    retryable: Boolean(error.retryable),
  };
}

function publicProjectContext(context) {
  const state = context?.state && typeof context.state === "object"
    ? context.state
    : {};
  return {
    schema_version: 1,
    status: state.missing_sections?.length > 0 ? "partial" : "available",
    source_path: context?.source_path ?? null,
    revision: context?.revision ?? null,
    byte_length: context?.byte_length ?? null,
    state: {
      title: state.title ?? "项目状态",
      goal: state.goal ?? "",
      decisions: Array.isArray(state.decisions) ? [...state.decisions] : [],
      open_questions: Array.isArray(state.open_questions)
        ? [...state.open_questions]
        : [],
      next_action: state.next_action ?? "",
      next_actions: Array.isArray(state.next_actions) ? [...state.next_actions] : [],
    },
    missing_sections: Array.isArray(state.missing_sections)
      ? [...state.missing_sections]
      : [],
  };
}

function candidateProjectContext(context) {
  const state = context?.state && typeof context.state === "object"
    ? context.state
    : {};
  return {
    goal: state.goal ?? "",
    decisions: Array.isArray(state.decisions) ? [...state.decisions] : [],
    open_questions: Array.isArray(state.open_questions)
      ? [...state.open_questions]
      : [],
    next_action: state.next_action ?? "",
  };
}

function publicZoteroProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return proposal;
  return {
    proposal_id: proposal.proposal_id ?? null,
    run_id: proposal.run_id ?? null,
    paper_id: proposal.paper_id ?? null,
    target: proposal.target ?? "zotero",
    operation: proposal.operation ?? null,
    write_mode: proposal.write_mode ?? null,
    operation_label: proposal.operation_label ?? null,
    target_locator: proposal.target_locator ?? null,
    target_id: proposal.target_id ?? null,
    preview_or_diff: Array.isArray(proposal.preview_or_diff)
      ? [...proposal.preview_or_diff]
      : [],
    content_hash: proposal.content_hash ?? null,
    target_version_or_hash: proposal.target_version_or_hash ?? null,
    selected: Boolean(proposal.selected),
    status: proposal.status ?? "draft",
    external_id: proposal.external_id ?? null,
    attachment_id: proposal.attachment_id ?? null,
    note_id: proposal.note_id ?? null,
    verification_result: proposal.verification_result ?? null,
    attempt_count: proposal.attempt_count ?? 0,
    blocked_by: proposal.blocked_by ?? null,
    last_verified_at: proposal.last_verified_at ?? null,
    error: publicWorkflowError(proposal.error),
    metadata: proposal.metadata && typeof proposal.metadata === "object"
      ? {
          item_type: proposal.metadata.item_type ?? proposal.metadata.itemType ?? null,
          title: proposal.metadata.title ?? "",
          authors: Array.isArray(proposal.metadata.authors) ? [...proposal.metadata.authors] : [],
          venue: proposal.metadata.venue ?? "",
          date: proposal.metadata.date ?? proposal.metadata.published_at ?? null,
          published_at: proposal.metadata.published_at ?? proposal.metadata.date ?? null,
          doi: proposal.metadata.doi ?? null,
          url: proposal.metadata.url ?? null,
          abstract: proposal.metadata.abstract ?? proposal.metadata.abstract_note
            ?? proposal.metadata.abstractNote ?? "",
          tags: Array.isArray(proposal.metadata.tags)
            ? structuredClone(proposal.metadata.tags)
            : [],
          extra: proposal.metadata.extra ?? "",
        }
      : null,
    pdf: proposal.pdf && typeof proposal.pdf === "object"
      ? {
          file_name: proposal.pdf.file_name ?? null,
          sha256: proposal.pdf.sha256 ?? null,
          byte_length: proposal.pdf.byte_length ?? null,
          source_url: proposal.pdf.source_url ?? null,
        }
      : null,
    guide: proposal.guide && typeof proposal.guide === "object"
      ? {
          document_revision: proposal.guide.document_revision ?? null,
          prompt_version: proposal.guide.prompt_version ?? null,
          note_sha256: proposal.guide.note_sha256 ?? null,
          sections: proposal.guide.sections && typeof proposal.guide.sections === "object"
            ? {
                problem: proposal.guide.sections.problem ?? "",
                why_read: proposal.guide.sections.why_read ?? "",
                intuition: proposal.guide.sections.intuition ?? "",
                evidence: proposal.guide.sections.evidence ?? "",
                limitations: proposal.guide.sections.limitations ?? "",
                questions: Array.isArray(proposal.guide.sections.questions)
                  ? [...proposal.guide.sections.questions]
                  : [],
              }
            : null,
          references: Array.isArray(proposal.guide.references)
            ? proposal.guide.references.map((reference) => ({
                block_id: reference?.block_id ?? null,
                path: Array.isArray(reference?.path) ? [...reference.path] : [],
                excerpt: reference?.excerpt ?? "",
              }))
            : [],
        }
      : null,
  };
}

function publicZoteroState(zotero) {
  if (!zotero || typeof zotero !== "object") return null;
  const approval = zotero.approval && typeof zotero.approval === "object"
    ? {
        approval_id: zotero.approval.approval_id ?? null,
        proposal_id: zotero.approval.proposal_id ?? null,
        proposal_hash: zotero.approval.proposal_hash ?? null,
        operations: Array.isArray(zotero.approval.operations)
          ? zotero.approval.operations.map((operation) => ({
              proposal_id: operation.proposal_id ?? null,
              content_hash: operation.content_hash ?? null,
              target_version_or_hash: operation.target_version_or_hash ?? null,
            }))
          : [],
        approved_at: zotero.approval.approved_at ?? null,
      }
    : null;
  return {
    status: zotero.status ?? "not_started",
    target: publicZoteroTarget(zotero.target),
    decisions: zotero.decisions && typeof zotero.decisions === "object"
      ? { ...zotero.decisions }
      : {},
    proposal_id: zotero.proposal_id ?? null,
    proposal_hash: zotero.proposal_hash ?? null,
    proposals: Array.isArray(zotero.proposals)
      ? zotero.proposals.map(publicZoteroProposal)
      : [],
    approval,
    last_error: publicWorkflowError(zotero.last_error),
  };
}

function publicReadingState(readings) {
  if (!readings || typeof readings !== "object" || Array.isArray(readings)) {
    return {
      schema_version: 1,
      status: "not_started",
      paper_ids: [],
      provider_id: null,
      model_id: null,
      papers: {},
      last_error: null,
    };
  }
  const papers = Object.fromEntries(Object.entries(readings.papers ?? {}).map(
    ([paperId, paper]) => [
      paperId,
      {
        status: paper?.status ?? "not_started",
        document_revision: paper?.document_revision ?? null,
        current_stage: paper?.current_stage ?? "research-question",
        position: paper?.position && typeof paper.position === "object"
          ? {
              mode: paper.position.mode ?? "focused",
              block_id: paper.position.block_id ?? null,
              updated_at: paper.position.updated_at ?? null,
            }
          : null,
        stages: Object.fromEntries(Object.entries(paper?.stages ?? {}).map(
          ([stageId, stage]) => [
            stageId,
            {
              status: stage?.status ?? "not_started",
              content_hash: stage?.content_hash ?? null,
              input_hash: stage?.input_hash ?? null,
              prompt_id: stage?.prompt_id ?? null,
              prompt_version: stage?.prompt_version ?? null,
              provider_id: stage?.provider_id ?? null,
              model_id: stage?.model_id ?? null,
              error: publicWorkflowError(stage?.error),
              updated_at: stage?.updated_at ?? null,
            },
          ],
        )),
        questions: Array.isArray(paper?.questions)
          ? paper.questions.map((question) => ({
              id: question?.id ?? null,
              client_request_id: question?.client_request_id ?? null,
              stage: question?.stage ?? null,
              block_id: question?.block_id ?? null,
              text: question?.text ?? "",
              status: question?.status ?? "pending",
              error: publicWorkflowError(question?.error),
              created_at: question?.created_at ?? null,
              answered_at: question?.answered_at ?? null,
            }))
          : [],
        chat: {
          id: paper?.chat?.id ?? "current",
          title: paper?.chat?.title ?? null,
          status: paper?.chat?.status ?? "idle",
          branch_type: paper?.chat?.branch_type ?? "canonical",
          parent_checkpoint: paper?.chat?.parent_checkpoint
            && typeof paper.chat.parent_checkpoint === "object"
            ? {
                conversation_id:
                  paper.chat.parent_checkpoint.conversation_id ?? null,
                turn_id: paper.chat.parent_checkpoint.turn_id ?? null,
                turn_count: paper.chat.parent_checkpoint.turn_count ?? 0,
                checkpoint_hash:
                  paper.chat.parent_checkpoint.checkpoint_hash ?? null,
                created_at: paper.chat.parent_checkpoint.created_at ?? null,
              }
            : null,
          promotion_status: paper?.chat?.promotion_status ?? "canonical",
          promoted_at: paper?.chat?.promoted_at ?? null,
          turns: Array.isArray(paper?.chat?.turns)
            ? paper.chat.turns.map((turn) => ({
                id: turn?.id ?? null,
                client_request_id: turn?.client_request_id ?? null,
                question: turn?.question ?? "",
                round_id: turn?.round_id ?? null,
                status: turn?.status ?? "failed",
                reference: turn?.reference && typeof turn.reference === "object"
                  ? {
                      block_id: turn.reference.block_id ?? null,
                      path: Array.isArray(turn.reference.path)
                        ? [...turn.reference.path]
                        : [],
                      ordinal: turn.reference.ordinal ?? null,
                      start_offset: turn.reference.start_offset ?? null,
                      end_offset: turn.reference.end_offset ?? null,
                      quote: turn.reference.quote ?? "",
                      source_hash: turn.reference.source_hash ?? null,
                    }
                  : null,
                input_hash: turn?.input_hash ?? null,
                provider_id: turn?.provider_id ?? null,
                model_id: turn?.model_id ?? null,
                cache_hit: Boolean(turn?.cache_hit),
                cache_write_failed: Boolean(turn?.cache_write_failed),
                project_context_status:
                  turn?.project_context_status ?? "not_requested",
                project_context_requested:
                  Boolean(turn?.project_context_requested),
                project_context_source_path:
                  turn?.project_context_source_path ?? null,
                error: publicWorkflowError(turn?.error),
                created_at: turn?.created_at ?? null,
                answered_at: turn?.answered_at ?? null,
              }))
            : [],
          updated_at: paper?.chat?.updated_at ?? null,
        },
        active_conversation_id: paper?.chat?.id ?? "current",
        canonical_conversation_id:
          paper?.canonical_conversation_id ?? paper?.chat?.id ?? "current",
        conversations: [
          {
            id: paper?.chat?.id ?? "current",
            title: paper?.chat?.title ?? null,
            turn_count: Array.isArray(paper?.chat?.turns) ? paper.chat.turns.length : 0,
            branch_type: paper?.chat?.branch_type ?? "canonical",
            parent_checkpoint: paper?.chat?.parent_checkpoint
              && typeof paper.chat.parent_checkpoint === "object"
              ? { ...paper.chat.parent_checkpoint }
              : null,
            promotion_status: paper?.chat?.promotion_status ?? "canonical",
            promoted_at: paper?.chat?.promoted_at ?? null,
            canonical: (
              paper?.canonical_conversation_id ?? paper?.chat?.id ?? "current"
            ) === (paper?.chat?.id ?? "current"),
            updated_at: paper?.chat?.updated_at ?? null,
            active: true,
          },
          ...(Array.isArray(paper?.archived_conversations)
            ? paper.archived_conversations.map((conversation) => ({
                id: conversation?.id ?? null,
                title: conversation?.title ?? null,
                turn_count: Array.isArray(conversation?.turns)
                  ? conversation.turns.length
                  : 0,
                branch_type: conversation?.branch_type ?? "scratch",
                parent_checkpoint: conversation?.parent_checkpoint
                  && typeof conversation.parent_checkpoint === "object"
                  ? { ...conversation.parent_checkpoint }
                  : null,
                promotion_status:
                  conversation?.promotion_status ?? "not_promoted",
                promoted_at: conversation?.promoted_at ?? null,
                canonical:
                  conversation?.id === paper?.canonical_conversation_id,
                updated_at: conversation?.updated_at
                  ?? conversation?.created_at
                  ?? null,
                active: false,
              }))
            : []),
        ],
        pinned_conclusions: Array.isArray(paper?.pinned_conclusions)
          ? paper.pinned_conclusions.map((conclusion) => ({
              schema_version: conclusion?.schema_version ?? 1,
              conclusion_id: conclusion?.conclusion_id ?? null,
              source_conversation_id:
                conclusion?.source_conversation_id ?? null,
              source_turn_id: conclusion?.source_turn_id ?? null,
              source_input_hash: conclusion?.source_input_hash ?? null,
              content: conclusion?.content ?? "",
              content_hash: conclusion?.content_hash ?? null,
              citations: Array.isArray(conclusion?.citations)
                ? structuredClone(conclusion.citations)
                : [],
              confirmed_by: conclusion?.confirmed_by ?? null,
              status: conclusion?.status ?? "unpinned",
              pinned_at: conclusion?.pinned_at ?? null,
              unpinned_at: conclusion?.unpinned_at ?? null,
              updated_at: conclusion?.updated_at ?? null,
            }))
          : [],
        agent_actions: {
          status: paper?.agent_actions?.status ?? "idle",
          proposals: Array.isArray(paper?.agent_actions?.proposals)
            ? paper.agent_actions.proposals.map((proposal) => ({
                proposal_id: proposal?.proposal_id ?? null,
                turn_id: proposal?.turn_id ?? null,
                status: proposal?.status ?? "draft",
                content_hash: proposal?.content_hash ?? null,
                target_version_or_hash: proposal?.target_version_or_hash ?? null,
                committed_at: proposal?.committed_at ?? null,
                updated_at: proposal?.updated_at ?? null,
              }))
            : [],
          updated_at: paper?.agent_actions?.updated_at ?? null,
        },
        updated_at: paper?.updated_at ?? null,
      },
    ],
  ));
  return {
    schema_version: 1,
    status: readings.status ?? "not_started",
    paper_ids: Array.isArray(readings.paper_ids) ? [...readings.paper_ids] : [],
    provider_id: readings.provider_id ?? null,
    model_id: readings.model_id ?? null,
    papers,
    last_error: publicWorkflowError(readings.last_error),
  };
}

function publicObsidianProposal(proposal, { includeMarkdown = false } = {}) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return proposal;
  return {
    proposal_id: proposal.proposal_id ?? null,
    run_id: proposal.run_id ?? null,
    paper_id: proposal.paper_id ?? null,
    decision: proposal.decision ?? "read",
    target: "obsidian",
    operation: proposal.operation ?? null,
    write_mode: proposal.write_mode ?? null,
    target_locator: proposal.target_locator ?? null,
    target_details: proposal.target_details && typeof proposal.target_details === "object"
      ? {
          directory: proposal.target_details.directory ?? null,
          file_name: proposal.target_details.file_name ?? null,
          exists: Boolean(proposal.target_details.exists),
          kind: proposal.target_details.kind ?? null,
          byte_length: proposal.target_details.byte_length ?? 0,
          current_content_hash: proposal.target_details.current_content_hash ?? null,
        }
      : null,
    target_hash: proposal.target_hash ?? null,
    target_version_or_hash: proposal.target_version_or_hash ?? null,
    content_hash: proposal.content_hash ?? null,
    actionable: Boolean(proposal.actionable),
    selected: Boolean(proposal.selected),
    status: proposal.status ?? "draft",
    preview_or_diff: Array.isArray(proposal.preview_or_diff)
      ? [...proposal.preview_or_diff]
      : [],
    ...(includeMarkdown
      ? {
          markdown: proposal.markdown ?? "",
          diff: proposal.diff && typeof proposal.diff === "object"
            ? structuredClone(proposal.diff)
            : null,
        }
      : {}),
  };
}

function publicObsidianState(obsidian) {
  if (!obsidian || typeof obsidian !== "object" || Array.isArray(obsidian)) {
    return {
      schema_version: 1,
      status: "not_started",
      proposal_hash: null,
      proposals: [],
      approval: null,
      last_error: null,
      updated_at: null,
    };
  }
  return {
    schema_version: 1,
    status: obsidian.status ?? "not_started",
    proposal_hash: obsidian.proposal_hash ?? null,
    proposals: Array.isArray(obsidian.proposals)
      ? obsidian.proposals.map((proposal) => publicObsidianProposal(proposal))
      : [],
    approval: obsidian.approval && typeof obsidian.approval === "object"
      ? {
          client_request_id: obsidian.approval.client_request_id ?? null,
          proposal_hash: obsidian.approval.proposal_hash ?? null,
          approval_hash: obsidian.approval.approval_hash ?? null,
          operations: Array.isArray(obsidian.approval.operations)
            ? obsidian.approval.operations.map((operation) => ({
                proposal_id: operation.proposal_id ?? null,
                content_hash: operation.content_hash ?? null,
                target_version_or_hash: operation.target_version_or_hash ?? null,
              }))
            : [],
          approved_at: obsidian.approval.approved_at ?? null,
        }
      : null,
    last_error: publicWorkflowError(obsidian.last_error),
    committed_at: obsidian.committed_at ?? null,
    verified_at: obsidian.verified_at ?? null,
    updated_at: obsidian.updated_at ?? null,
  };
}

function publicObsidianArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  return {
    schema_version: artifact.schema_version ?? 1,
    run_id: artifact.run_id ?? null,
    target_type: "obsidian",
    write_capability: "hash_bound_commit",
    external_write_performed: artifact.external_write_performed === true,
    status: artifact.status ?? "preview_ready",
    target_directory: artifact.target_directory ?? null,
    source_hash: artifact.source_hash ?? null,
    proposal_hash: artifact.proposal_hash ?? null,
    proposals: Array.isArray(artifact.proposals)
      ? artifact.proposals.map((proposal) => publicObsidianProposal(
          proposal,
          { includeMarkdown: true },
        ))
      : [],
    generated_at: artifact.generated_at ?? null,
  };
}

function publicProjectStateProposal(proposal, { includeMarkdown = false } = {}) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return proposal;
  return {
    proposal_id: proposal.proposal_id ?? null,
    run_id: proposal.run_id ?? null,
    target: "project_state",
    operation: proposal.operation ?? null,
    write_mode: proposal.write_mode ?? null,
    target_locator: proposal.target_locator ?? null,
    target_details: proposal.target_details && typeof proposal.target_details === "object"
      ? {
          source_path: proposal.target_details.source_path ?? null,
          byte_length: proposal.target_details.byte_length ?? 0,
          current_content_hash: proposal.target_details.current_content_hash ?? null,
        }
      : null,
    content_hash: proposal.content_hash ?? null,
    target_hash: proposal.target_hash ?? null,
    target_version_or_hash: proposal.target_version_or_hash ?? null,
    marker: proposal.marker ?? null,
    actionable: Boolean(proposal.actionable),
    selected: Boolean(proposal.selected),
    status: proposal.status ?? "draft",
    preview_or_diff: Array.isArray(proposal.preview_or_diff)
      ? [...proposal.preview_or_diff]
      : [],
    paper_references: Array.isArray(proposal.paper_references)
      ? proposal.paper_references.map((reference) => ({
          paper_id: reference.paper_id ?? null,
          title: reference.title ?? null,
          obsidian_note: reference.obsidian_note ?? null,
        }))
      : [],
    ...(includeMarkdown
      ? {
          markdown: proposal.markdown ?? "",
          diff: proposal.diff && typeof proposal.diff === "object"
            ? structuredClone(proposal.diff)
            : null,
        }
      : {}),
  };
}

function publicProjectStateState(projectState) {
  if (!projectState || typeof projectState !== "object" || Array.isArray(projectState)) {
    return {
      schema_version: 1,
      status: "not_started",
      proposal_id: null,
      proposal_hash: null,
      target_locator: null,
      target_hash: null,
      content_hash: null,
      actionable: false,
      approval: null,
      last_error: null,
      updated_at: null,
    };
  }
  return {
    schema_version: 1,
    status: projectState.status ?? "not_started",
    proposal_id: projectState.proposal_id ?? null,
    proposal_hash: projectState.proposal_hash ?? null,
    target_locator: projectState.target_locator ?? null,
    target_hash: projectState.target_hash ?? null,
    content_hash: projectState.content_hash ?? null,
    actionable: Boolean(projectState.actionable),
    approval: projectState.approval && typeof projectState.approval === "object"
      ? {
          client_request_id: projectState.approval.client_request_id ?? null,
          proposal_hash: projectState.approval.proposal_hash ?? null,
          approval_hash: projectState.approval.approval_hash ?? null,
          operation: projectState.approval.operation
            ? {
                proposal_id: projectState.approval.operation.proposal_id ?? null,
                content_hash: projectState.approval.operation.content_hash ?? null,
                target_version_or_hash:
                  projectState.approval.operation.target_version_or_hash ?? null,
              }
            : null,
          approved_at: projectState.approval.approved_at ?? null,
        }
      : null,
    last_error: publicWorkflowError(projectState.last_error),
    committed_at: projectState.committed_at ?? null,
    verified_at: projectState.verified_at ?? null,
    updated_at: projectState.updated_at ?? null,
  };
}

function publicProjectStateArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  return {
    schema_version: artifact.schema_version ?? 1,
    run_id: artifact.run_id ?? null,
    target_type: "project_state",
    write_capability: "hash_bound_commit",
    external_write_performed: artifact.external_write_performed === true,
    status: artifact.status ?? "preview_ready",
    source_hash: artifact.source_hash ?? null,
    proposal_hash: artifact.proposal_hash ?? null,
    proposal: publicProjectStateProposal(
      artifact.proposal,
      { includeMarkdown: true },
    ),
    generated_at: artifact.generated_at ?? null,
  };
}

function publicZoteroArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  return {
    schema_version: artifact.schema_version ?? 1,
    run_id: artifact.run_id ?? null,
    proposal_id: artifact.proposal_id ?? null,
    proposal_hash: artifact.proposal_hash ?? null,
    target: publicZoteroTarget(artifact.target),
    decisions: artifact.decisions && typeof artifact.decisions === "object"
      ? { ...artifact.decisions }
      : {},
    proposals: Array.isArray(artifact.proposals)
      ? artifact.proposals.map(publicZoteroProposal)
      : [],
    generated_at: artifact.generated_at ?? null,
  };
}

function publicArchiveBatch(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return null;
  return {
    schema_version: batch.schema_version ?? 1,
    batch_id: batch.batch_id ?? null,
    client_request_id: batch.client_request_id ?? null,
    selected_targets: Array.isArray(batch.selected_targets)
      ? [...batch.selected_targets]
      : [],
    status: batch.status ?? null,
    last_error: publicWorkflowError(batch.last_error),
    approved_at: batch.approved_at ?? null,
    completed_at: batch.completed_at ?? null,
    updated_at: batch.updated_at ?? null,
  };
}

function publicJournalEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const safe = {
    seq: Number.isSafeInteger(event.seq) ? event.seq : null,
    type: typeof event.type === "string" ? event.type : "journal.event",
    at: event.at ?? null,
  };
  for (const key of [
    "status",
    "phase",
    "paper_id",
    "batch_id",
    "proposal_id",
    "source_id",
    "ready_count",
    "failed_count",
    "attempted_count",
    "candidate_count",
    "blocked_count",
    "selected_count",
  ]) {
    const value = event[key];
    if (
      typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  if (event.error) safe.error = publicWorkflowError(event.error);
  return safe;
}

export function publicRun(run) {
  if (!run) return null;
  const guides = run.guides && typeof run.guides === "object"
    ? {
        status: run.guides.status,
        requested_paper_ids: run.guides.requested_paper_ids ?? [],
        provider_id: run.guides.provider_id ?? null,
        model_id: run.guides.model_id ?? null,
        papers: Object.fromEntries(Object.entries(run.guides.papers ?? {}).map(
          ([paperId, state]) => [
            paperId,
            {
              status: state?.status ?? "not_started",
              document_revision: state?.revision ?? null,
              prompt_version: state?.prompt_version ?? null,
              input_hash: state?.input_hash ?? null,
              provider_id: state?.provider_id ?? null,
              model_id: state?.model_id ?? null,
              error: state?.error ?? null,
            },
          ],
        )),
      }
    : null;
  return {
    ...run,
    ...migrateRuntimeEnvelope(run, {
      domain: "journal",
      pendingReview: [
        "review_ready",
        "guide_ready",
        "draft_ready",
      ].includes(run.status),
      recovering: run.archive_batch?.status === "committing"
        && run.status !== "committing",
    }),
    candidates: Array.isArray(run.candidates) ? run.candidates.map(publicPaper) : [],
    recent_classics: run.recent_classics && typeof run.recent_classics === "object"
      ? {
          ...run.recent_classics,
          papers: Array.isArray(run.recent_classics.papers)
            ? run.recent_classics.papers.map(publicPaper)
            : [],
        }
      : null,
    guides,
    paper_decisions: run.paper_decisions && typeof run.paper_decisions === "object"
      ? { ...run.paper_decisions }
      : {},
    readings: publicReadingState(run.readings),
    obsidian: publicObsidianState(run.obsidian),
    project_state: publicProjectStateState(run.project_state),
    zotero: publicZoteroState(run.zotero),
    archive_batch: publicArchiveBatch(run.archive_batch),
  };
}

function corsHeaders(origin) {
  return origin && allowedOrigins.has(origin)
    ? {
        "access-control-allow-origin": origin,
        vary: "Origin",
      }
    : {};
}

function sendJson(response, status, body, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders(origin),
  };
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function sendProjectWorkImage(response, image, origin) {
  const body = Buffer.isBuffer(image.bytes)
    ? image.bytes
    : Buffer.from(image.bytes);
  response.writeHead(200, {
    "content-type": image.mimeType,
    "content-length": String(body.length),
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    ...corsHeaders(origin),
  });
  response.end(body);
}

function sendProjectWorkOfficeArtifact(response, artifact, origin) {
  const body = Buffer.isBuffer(artifact.bytes)
    ? artifact.bytes
    : Buffer.from(artifact.bytes);
  const fileName = path.basename(String(artifact.fileName ?? "download"))
    .replaceAll(/[\u0000-\u001f\u007f"\\]/gu, "_");
  const asciiName = fileName.replaceAll(/[^\x20-\x7e]/gu, "_") || "download";
  const encodedName = encodeURIComponent(fileName)
    .replaceAll("'", "%27");
  response.writeHead(200, {
    "content-type": artifact.mimeType,
    "content-length": String(body.length),
    "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
    ...corsHeaders(origin),
  });
  response.end(body);
}

function sendWorkflowError(response, error, origin, fallback) {
  sendJson(response, Number.isInteger(error?.status) ? error.status : 500, {
    error: {
      code: typeof error?.code === "string" ? error.code : "JOURNAL_RESOURCE_FAILED",
      message: typeof error?.message === "string" ? error.message : fallback,
      retryable: Boolean(error?.retryable),
    },
  }, origin);
}

function requireProjectWorkMutationOrigin(origin) {
  if (!origin || !allowedOrigins.has(origin)) {
    throw projectWorkError(
      "PROJECT_WORK_ORIGIN_REQUIRED",
      "项目修改操作只能从本机 Pi Agent 界面发起",
      403,
    );
  }
}

function requireJournalMutationOrigin(origin, { allowMissing = false } = {}) {
  if ((!origin && !allowMissing) || (origin && !allowedOrigins.has(origin))) {
    const error = new Error("论文工作流写操作只能从本机 Pi Agent 界面发起");
    error.code = "JOURNAL_ORIGIN_REQUIRED";
    error.status = 403;
    error.retryable = false;
    throw error;
  }
}

function requireJsonRequest(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw projectWorkError(
      "PROJECT_WORK_UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 application/json",
      415,
    );
  }
}

async function readProjectWorkJson(request, options) {
  requireJsonRequest(request);
  try {
    return await readJson(request, options);
  } catch (error) {
    if (error instanceof CandidateSummaryError) {
      throw projectWorkError(error.code, error.message, error.status, error.retryable);
    }
    throw error;
  }
}

async function readWorkerBytes(request, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/octet-stream") {
    throw projectWorkError(
      "WORKER_FILE_CONTENT_TYPE_INVALID",
      "Worker 附件内容必须使用 application/octet-stream",
      415,
    );
  }
  const declared = Number(request.headers["content-length"]);
  if (
    request.headers["content-length"] !== undefined
    && (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)
  ) {
    throw projectWorkError("WORKER_FILE_SIZE_INVALID", "Worker 附件大小无效", 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw projectWorkError(
        "WORKER_FILE_TOO_LARGE",
        "单个 Worker 附件不能超过 25 MiB",
        413,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function projectWorkCreationPolicyMode(value) {
  if (value === undefined || value === null) return null;
  if (["manual_review", "auto_review"].includes(value)) return value;
  throw projectWorkError(
    "PROJECT_WORK_EXECUTION_POLICY_INVALID",
    "执行策略无效",
    400,
  );
}

function decodeProjectWorkSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_ROUTE_INVALID",
      "项目工作接口路径无效",
      400,
    );
  }
}

function sendProjectWorkError(response, error, origin) {
  const safe = safeProjectWorkError(error);
  sendJson(
    response,
    error instanceof ProjectWorkError && Number.isInteger(error.status)
      ? error.status
      : 500,
    { error: safe },
    origin,
  );
}

function publicProjectWorkConversationSummary(value) {
  const conversation = value?.conversation ?? value;
  return {
    ...migrateRuntimeEnvelope(conversation, {
      domain: "project_work",
      pendingQuestion: conversation?.status === "awaiting_user",
      pendingReview: conversation?.status === "awaiting_confirmation",
      verifying: conversation?.status === "verifying",
      recovering: conversation?.status === "recovering",
      stopped: ["aborted", "stopped"].includes(conversation?.status),
    }),
    id: conversation?.id ?? null,
    projectId: conversation?.projectId ?? null,
    workType: conversation?.workType === "worker" ? "worker" : "project_work",
    workerId: conversation?.workerId ?? null,
    sourceProjectId: conversation?.sourceProjectId ?? null,
    sourceProjectLabel: conversation?.sourceProjectLabel ?? null,
    workspaceKind: conversation?.workspaceKind ?? null,
    scope: conversation?.scope ?? null,
    rootLabel: conversation?.rootLabel ?? null,
    title: conversation?.title ?? "",
    status: conversation?.status ?? "idle",
    providerId: conversation?.providerId ?? null,
    modelId: conversation?.modelId ?? null,
    thinkingLevel: conversation?.thinkingLevel ?? null,
    ...(conversation?.executionPolicy ? {
      executionPolicy: {
        mode: conversation.executionPolicy.mode === "auto_review"
          ? "auto_review"
          : "manual_review",
        revision: Number.isSafeInteger(conversation.executionPolicy.revision)
          && conversation.executionPolicy.revision > 0
          ? conversation.executionPolicy.revision
          : 1,
        policyVersion: Number.isSafeInteger(
          conversation.executionPolicy.policyVersion,
        ) && conversation.executionPolicy.policyVersion > 0
          ? conversation.executionPolicy.policyVersion
          : 1,
      },
    } : {}),
    pendingChangeFileCount: conversation?.pendingChangeFileCount ?? 0,
    unreadCount: Number.isSafeInteger(conversation?.unreadCount)
      ? conversation.unreadCount
      : 0,
    latestMessageSeq: Number.isSafeInteger(conversation?.latestMessageSeq)
      ? conversation.latestMessageSeq
      : 0,
    lastReadMessageSeq: Number.isSafeInteger(conversation?.lastReadMessageSeq)
      ? conversation.lastReadMessageSeq
      : 0,
    lastEventSeq: conversation?.lastEventSeq ?? 0,
    createdAt: conversation?.createdAt ?? null,
    updatedAt: conversation?.updatedAt ?? null,
  };
}

function publicProjectWorkConversationState(value) {
  if (
    value?.snapshot
    && typeof value.snapshot === "object"
    && !Array.isArray(value.snapshot)
  ) {
    return {
      ...value,
      snapshot: publicProjectWorkConversationState(value.snapshot),
    };
  }
  const conversation = value?.conversation ?? value;
  if (!conversation || typeof conversation !== "object") return value;
  const publicConversation = {
    ...conversation,
    ...migrateRuntimeEnvelope(conversation, {
      domain: "project_work",
      pendingQuestion: conversation.status === "awaiting_user",
      pendingReview: conversation.status === "awaiting_confirmation",
      verifying: conversation.status === "verifying",
      recovering: conversation.status === "recovering",
      stopped: ["aborted", "stopped", "error"].includes(conversation.status),
    }),
  };
  return value?.conversation
    ? { ...value, conversation: publicConversation }
    : publicConversation;
}

async function sendPdf(request, response, pdf, origin) {
  const etag = `"${pdf.sha256}"`;
  const ifRange = request.headers["if-range"];
  const rangeHeader = ifRange && ifRange !== etag ? null : request.headers.range;
  let range;
  try {
    range = parseByteRange(rangeHeader, pdf.byte_length);
  } catch (error) {
    if (!(error instanceof HttpRangeError)) throw error;
    response.writeHead(416, {
      "content-range": `bytes */${pdf.byte_length}`,
      "accept-ranges": "bytes",
      etag,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...corsHeaders(origin),
    });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? pdf.byte_length - 1;
  const status = range ? 206 : 200;
  response.writeHead(status, {
    "content-type": "application/pdf",
    "content-length": String(end - start + 1),
    ...(range ? { "content-range": `bytes ${start}-${end}/${pdf.byte_length}` } : {}),
    "accept-ranges": "bytes",
    "content-disposition": `inline; filename="${pdf.file_name}"`,
    etag,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders(origin),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(pdf.file_path, { start, end });
  request.once("aborted", () => stream.destroy());
  try {
    await pipeline(stream, response);
  } catch (error) {
    if (!request.aborted && !response.destroyed) throw error;
  }
}

async function readJson(request, {
  maxBytes = 256 * 1024,
} = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const limitLabel = maxBytes === 256 * 1024
        ? "256 KB"
        : `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
      throw new CandidateSummaryError(
        "REQUEST_TOO_LARGE",
        `请求正文不能超过 ${limitLabel}`,
        413,
      );
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CandidateSummaryError("INVALID_REQUEST", "请求正文不是有效 JSON", 400);
  }
}

function proposalDecisions(entries) {
  if (!Array.isArray(entries)) {
    throw new CandidateSummaryError("INVALID_REQUEST", "论文决定格式无效", 400);
  }
  const decisions = Object.create(null);
  for (const entry of entries) {
    if (
      !entry
      || typeof entry.paper_id !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(entry.paper_id)
      || !["collect", "read"].includes(entry.decision)
      || Object.hasOwn(decisions, entry.paper_id)
    ) {
      throw new CandidateSummaryError("INVALID_REQUEST", "论文决定格式无效", 400);
    }
    decisions[entry.paper_id] = entry.decision;
  }
  return decisions;
}

export function createApiServer({
  candidateSummaryService = candidateSummaries,
  journalWorkflowService = journalWorkflow,
  projectWorkService = projectWork,
  workerService = worker,
  notificationSubscriptionService = notificationService,
  projectWorkRuntimeUrl = configuredProjectWorkRuntimeUrl,
  projectWorkRuntimeHealthProbe = probeProjectWorkRuntime,
  runtimeOnly = projectWorkRuntimeOnly,
  allowMissingJournalMutationOrigin = false,
} = {}) {
  const localWorkerService = projectWorkRuntimeUrl ? null : workerService;
  const localNotificationService = projectWorkRuntimeUrl
    ? null
    : notificationSubscriptionService;
  const workerHttpApi = projectWorkService && localWorkerService
    ? createWorkerHttpApi({
        workerService: localWorkerService,
        projectWorkService,
        readJson: readProjectWorkJson,
        readBytes: readWorkerBytes,
        sendJson,
        requireMutationOrigin: requireProjectWorkMutationOrigin,
      })
    : null;
  const notificationHttpApi = localNotificationService
    ? createNotificationHttpApi({
        notificationService: localNotificationService,
        readJson: readProjectWorkJson,
        sendJson,
        requireMutationOrigin: requireProjectWorkMutationOrigin,
      })
    : null;
  return http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不在本地允许列表中", retryable: false } });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": origin || "http://127.0.0.1:4173",
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, range, if-range",
      "access-control-expose-headers": "accept-ranges, content-range, content-length, etag",
      vary: "Origin",
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method)
    && (
      url.pathname === "/api/v1/journal-runs"
      || url.pathname.startsWith("/api/v1/journal-runs/")
    )
  ) {
    try {
      requireJournalMutationOrigin(origin, {
        allowMissing: allowMissingJournalMutationOrigin,
      });
    } catch (error) {
      sendWorkflowError(
        response,
        error,
        origin,
        "论文工作流写操作只能从本机 Pi Agent 界面发起",
      );
      return;
    }
  }
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    const runtimeHealth = projectWorkRuntimeUrl
      ? await projectWorkRuntimeHealthProbe(projectWorkRuntimeUrl)
      : {
          reachable: true,
          runtimeRole: runtimeOnly ? "worker" : "embedded",
          runtimeSchemaVersion: RUNTIME_SCHEMA_VERSION,
        };
    const runtimeAvailable = runtimeHealth.reachable === true;
    sendJson(response, 200, {
      status: runtimeAvailable ? "ok" : "degraded",
      mode: candidateSummaryService.config.mode,
      default_provider_id: candidateSummaryService.config.defaultProviderId,
      runtime_schema_version: RUNTIME_SCHEMA_VERSION,
      runtime_role: runtimeOnly
        ? "worker"
        : projectWorkRuntimeUrl
          ? "gateway"
          : "embedded",
      journal_workflow: runtimeOnly ? "unavailable" : "available",
      project_work: runtimeAvailable ? "available" : "recovering",
      worker: runtimeAvailable ? "available" : "recovering",
      notifications: runtimeAvailable ? "available" : "recovering",
      runtime_reachable: runtimeAvailable,
      runtime_worker_role: runtimeHealth.runtimeRole,
      runtime_worker_schema_version: runtimeHealth.runtimeSchemaVersion,
      mineru_configured: Boolean(process.env.PI_MINERU_API_TOKEN),
    }, origin);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/model-usage") {
    const period = url.searchParams.get("period") || "30d";
    const workflow = url.searchParams.get("workflow") || "all";
    if (
      !["today", "7d", "30d", "all"].includes(period)
      || !["all", "project_work", "paper_reading"].includes(workflow)
    ) {
      sendJson(response, 400, {
        error: {
          code: "MODEL_USAGE_FILTER_INVALID",
          message: "模型用量筛选条件无效",
          retryable: false,
        },
      }, origin);
      return;
    }
    const reports = [];
    const accessIssues = [];
    if (workflow !== "paper_reading") {
      try {
        if (projectWorkService?.getUsage) {
          reports.push(await projectWorkService.getUsage({ period }));
        } else if (projectWorkRuntimeUrl) {
          const runtimeUsageUrl = new URL(
            `/api/v1/project-work/usage?period=${encodeURIComponent(period)}`,
            projectWorkRuntimeUrl,
          );
          const runtimeResponse = await fetch(runtimeUsageUrl, {
            headers: { accept: "application/json" },
          });
          const runtimeBody = await runtimeResponse.text();
          if (!runtimeResponse.ok || Buffer.byteLength(runtimeBody) > 2 * 1024 * 1024) {
            throw new Error("PROJECT_WORK_USAGE_UNAVAILABLE");
          }
          reports.push(JSON.parse(runtimeBody));
        } else {
          throw new Error("PROJECT_WORK_USAGE_UNAVAILABLE");
        }
      } catch {
        accessIssues.push({
          workflowScope: "project_work",
          code: "PROJECT_WORK_USAGE_UNAVAILABLE",
          message: "正常工作用量暂时无法读取",
        });
      }
    }
    if (workflow !== "project_work") {
      try {
        if (runtimeOnly || !journalWorkflowService?.getUsage) {
          throw new Error("PAPER_USAGE_UNAVAILABLE");
        }
        reports.push(await journalWorkflowService.getUsage({ period }));
      } catch {
        accessIssues.push({
          workflowScope: "paper_reading",
          code: "PAPER_USAGE_UNAVAILABLE",
          message: "论文精读用量暂时无法读取",
        });
      }
    }
    sendJson(response, 200, combineModelUsageReports({
      reports,
      period,
      workflow,
      accessIssues,
    }), origin);
    return;
  }

  const runtimeRoute = [
    "/api/v1/project-work",
    "/api/v1/worker",
    "/api/v1/connections",
    "/api/v1/notification-subscriptions",
  ].some((prefix) => url.pathname.startsWith(prefix));
  if (runtimeOnly && !runtimeRoute) {
    sendJson(response, 404, {
      error: {
        code: "RUNTIME_ROUTE_NOT_FOUND",
        message: "Pi Runtime 仅提供正常工作、Worker 与提醒接口",
        retryable: false,
      },
    }, origin);
    return;
  }

  const auxiliaryRuntimeRoute = [
    "/api/v1/worker",
    "/api/v1/connections",
    "/api/v1/notification-subscriptions",
  ].some((prefix) => url.pathname.startsWith(prefix));
  if (auxiliaryRuntimeRoute && projectWorkRuntimeUrl) {
    await proxyProjectWorkRequest(
      request,
      response,
      projectWorkRuntimeUrl,
    );
    return;
  }

  if (
    url.pathname.startsWith("/api/v1/worker")
    || url.pathname.startsWith("/api/v1/connections")
  ) {
    try {
      if (await workerHttpApi?.handle(request, response, url, origin)) return;
      sendJson(response, 404, {
        error: {
          code: "WORKER_ROUTE_NOT_FOUND",
          message: "Worker 接口不存在",
          retryable: false,
        },
      }, origin);
    } catch (error) {
      sendWorkerHttpError(response, error, origin, sendJson);
    }
    return;
  }

  if (url.pathname.startsWith("/api/v1/notification-subscriptions")) {
    try {
      if (await notificationHttpApi?.handle(request, response, url, origin)) return;
      sendJson(response, 404, {
        error: {
          code: "NOTIFICATION_ROUTE_NOT_FOUND",
          message: "提醒接口不存在",
          retryable: false,
        },
      }, origin);
    } catch (error) {
      sendNotificationHttpError(response, error, origin, sendJson);
    }
    return;
  }

  if (url.pathname.startsWith("/api/v1/project-work")) {
    if (projectWorkRuntimeUrl) {
      await proxyProjectWorkRequest(
        request,
        response,
        projectWorkRuntimeUrl,
      );
      return;
    }
    try {
      if (
        request.method === "GET"
        && url.pathname === "/api/v1/project-work/skills/installed"
      ) {
        sendJson(
          response,
          200,
          await projectWorkService.listInstalledSkills(),
          origin,
        );
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/api/v1/project-work/skills"
      ) {
        sendJson(
          response,
          200,
          await projectWorkService.listSkillCatalog({
            query: url.searchParams.get("query") || "",
            sort: url.searchParams.get("sort") || "downloads",
          }),
          origin,
        );
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/api/v1/project-work/skill-previews"
      ) {
        requireProjectWorkMutationOrigin(origin);
        const payload = await readProjectWorkJson(request, { maxBytes: 16 * 1024 });
        sendJson(
          response,
          200,
          await projectWorkService.inspectSkillPackage({
            name: payload.name,
            version: payload.version,
          }),
          origin,
        );
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/api/v1/project-work/skills"
      ) {
        requireProjectWorkMutationOrigin(origin);
        const payload = await readProjectWorkJson(request, { maxBytes: 16 * 1024 });
        sendJson(
          response,
          201,
          await projectWorkService.installSkillPackage({
            previewId: payload.preview_id,
            previewHash: payload.preview_hash,
          }),
          origin,
        );
        return;
      }

      const skillPackageMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/skills\/([^/]+)$/,
      );
      if (skillPackageMatch && request.method === "PATCH") {
        requireProjectWorkMutationOrigin(origin);
        const payload = await readProjectWorkJson(request, { maxBytes: 8 * 1024 });
        sendJson(
          response,
          200,
          await projectWorkService.setSkillPackageEnabled({
            name: decodeProjectWorkSegment(skillPackageMatch[1]),
            enabled: payload.enabled === true,
          }),
          origin,
        );
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/api/v1/project-work/provider-connections"
      ) {
        sendJson(
          response,
          200,
          await projectWorkService.listProviderConnections(),
          origin,
        );
        return;
      }

      const providerConnectionMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/provider-connections\/([^/]+)$/,
      );
      if (providerConnectionMatch && request.method === "PUT") {
        requireProjectWorkMutationOrigin(origin);
        const providerId = decodeProjectWorkSegment(providerConnectionMatch[1]);
        const payload = await readProjectWorkJson(request, { maxBytes: 24 * 1024 });
        sendJson(
          response,
          200,
          await projectWorkService.saveProviderApiKey({
            providerId,
            apiKey: payload.api_key,
          }),
          origin,
        );
        return;
      }

      if (providerConnectionMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        sendJson(
          response,
          200,
          await projectWorkService.removeProviderCredential(
            decodeProjectWorkSegment(providerConnectionMatch[1]),
          ),
          origin,
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/project-work/models") {
        sendJson(response, 200, await projectWorkService.listModels(), origin);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/project-work/usage") {
        sendJson(response, 200, await projectWorkService.getUsage({
          period: url.searchParams.get("period") || "30d",
        }), origin);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/project-work/projects") {
        sendJson(response, 200, {
          schemaVersion: 1,
          projects: await projectWorkService.listProjects(),
        }, origin);
        return;
      }

      if (
        request.method === "GET"
        && url.pathname === "/api/v1/project-work/conversations"
      ) {
        sendJson(response, 200, {
          schemaVersion: 1,
          conversations: (
            await projectWorkService.listStandaloneConversations()
          ).map(publicProjectWorkConversationSummary),
        }, origin);
        return;
      }

      if (
        request.method === "POST"
        && url.pathname === "/api/v1/project-work/conversations"
      ) {
        requireProjectWorkMutationOrigin(origin);
        const payload = await readProjectWorkJson(request);
        const requestedPolicyMode = projectWorkCreationPolicyMode(
          payload.execution_policy_mode,
        );
        const conversation = await projectWorkService.createStandaloneConversation({
          title: payload.title,
          providerId: payload.provider_id,
          modelId: payload.model_id,
          thinkingLevel: payload.thinking_level,
          executionPolicyMode: requestedPolicyMode ?? undefined,
        });
        sendJson(
          response,
          201,
          publicProjectWorkConversationSummary(conversation),
          origin,
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/project-work/project-roots/pick") {
        requireProjectWorkMutationOrigin(origin);
        const payload = await readProjectWorkJson(request);
        const selection = await projectWorkService.pickProjectRoot({
          mode: payload.purpose === "create" ? "create" : "existing",
        });
        sendJson(response, 200, {
          schemaVersion: 1,
          selectionId: selection.selectionId,
          mode: selection.mode,
          name: selection.name,
          rootLabel: selection.rootLabel,
          expiresAt: selection.expiresAt,
        }, origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/v1/project-work/projects") {
        requireProjectWorkMutationOrigin(origin);
        const payload = await readProjectWorkJson(request);
        const project = await projectWorkService.registerProject({
          selectionId: payload.root_token,
          name: payload.new_folder_name ?? payload.name,
        });
        sendJson(response, 201, { schemaVersion: 1, project }, origin);
        return;
      }

      const projectMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/projects\/([^/]+)$/,
      );
      if (projectMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const projectId = decodeProjectWorkSegment(projectMatch[1]);
        await projectWorkService.removeProject(projectId);
        sendJson(response, 200, {
          schemaVersion: 1,
          projectId,
          removed: true,
          localFilesDeleted: false,
        }, origin);
        return;
      }

      const projectConversationsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/projects\/([^/]+)\/conversations$/,
      );
      if (projectConversationsMatch && request.method === "GET") {
        const projectId = decodeProjectWorkSegment(projectConversationsMatch[1]);
        const conversations = await projectWorkService.listConversations(projectId);
        sendJson(response, 200, {
          schemaVersion: 1,
          conversations: conversations.map(publicProjectWorkConversationSummary),
        }, origin);
        return;
      }
      if (projectConversationsMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const projectId = decodeProjectWorkSegment(projectConversationsMatch[1]);
        const payload = await readProjectWorkJson(request);
        const requestedPolicyMode = projectWorkCreationPolicyMode(
          payload.execution_policy_mode,
        );
        const result = await projectWorkService.createConversation(projectId, {
          title: payload.title,
          providerId: payload.provider_id,
          modelId: payload.model_id,
          thinkingLevel: payload.thinking_level,
          executionPolicyMode: requestedPolicyMode ?? undefined,
        });
        sendJson(
          response,
          201,
          publicProjectWorkConversationSummary(result),
          origin,
        );
        return;
      }

      const projectConversationMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/projects\/([^/]+)\/conversations\/([^/]+)$/,
      );
      if (projectConversationMatch && request.method === "PATCH") {
        requireProjectWorkMutationOrigin(origin);
        const projectId = decodeProjectWorkSegment(projectConversationMatch[1]);
        const conversationId = decodeProjectWorkSegment(projectConversationMatch[2]);
        const payload = await readProjectWorkJson(request);
        const conversation = await projectWorkService.renameConversation(
          projectId,
          conversationId,
          { title: payload.title },
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          conversation: publicProjectWorkConversationSummary(conversation),
        }, origin);
        return;
      }
      if (projectConversationMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const projectId = decodeProjectWorkSegment(projectConversationMatch[1]);
        const conversationId = decodeProjectWorkSegment(projectConversationMatch[2]);
        const result = await projectWorkService.removeConversation(
          projectId,
          conversationId,
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          projectId: result.projectId,
          conversationId: result.id,
          removed: result.removed === true,
          conversationCount: result.conversationCount,
        }, origin);
        return;
      }

      const projectTreeMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/projects\/([^/]+)\/tree$/,
      );
      if (projectTreeMatch && request.method === "GET") {
        const projectId = decodeProjectWorkSegment(projectTreeMatch[1]);
        const tree = await projectWorkService.getProjectTree(projectId, {
          directory: url.searchParams.get("path") ?? "",
          depth: Number(url.searchParams.get("depth") ?? 3),
          query: url.searchParams.get("query") ?? "",
          limit: url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        sendJson(response, 200, tree, origin);
        return;
      }

      const projectImageMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/projects\/([^/]+)\/image$/,
      );
      if (projectImageMatch && request.method === "GET") {
        const projectId = decodeProjectWorkSegment(projectImageMatch[1]);
        sendProjectWorkImage(
          response,
          await projectWorkService.readProjectImage(projectId, {
            filePath: url.searchParams.get("path"),
          }),
          origin,
        );
        return;
      }

      const projectFileMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/projects\/([^/]+)\/file$/,
      );
      if (projectFileMatch && request.method === "GET") {
        const projectId = decodeProjectWorkSegment(projectFileMatch[1]);
        const file = await projectWorkService.readProjectFile(projectId, {
          filePath: url.searchParams.get("path"),
          startLine: Number(url.searchParams.get("start_line") ?? 1),
          endLine: url.searchParams.has("end_line")
            ? Number(url.searchParams.get("end_line"))
            : undefined,
        });
        sendJson(response, 200, file, origin);
        return;
      }

      const conversationImageMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/image$/,
      );
      if (conversationImageMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          conversationImageMatch[1],
        );
        sendProjectWorkImage(
          response,
          await projectWorkService.readConversationImage(conversationId, {
            filePath: url.searchParams.get("path"),
          }),
          origin,
        );
        return;
      }

      const generatedImageMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/generated-images\/([^/]+)\/content$/,
      );
      if (generatedImageMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          generatedImageMatch[1],
        );
        const imageId = decodeProjectWorkSegment(generatedImageMatch[2]);
        sendProjectWorkImage(
          response,
          await projectWorkService.readGeneratedImage(
            conversationId,
            imageId,
          ),
          origin,
        );
        return;
      }

      const generatedOfficeMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/generated-office\/([^/]+)\/download$/,
      );
      if (generatedOfficeMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          generatedOfficeMatch[1],
        );
        const artifactId = decodeProjectWorkSegment(generatedOfficeMatch[2]);
        sendProjectWorkOfficeArtifact(
          response,
          await projectWorkService.readGeneratedOfficeArtifact(
            conversationId,
            artifactId,
          ),
          origin,
        );
        return;
      }

      const conversationFileMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/file$/,
      );
      if (conversationFileMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(conversationFileMatch[1]);
        const file = await projectWorkService.readConversationFile(conversationId, {
          filePath: url.searchParams.get("path"),
          startLine: Number(url.searchParams.get("start_line") ?? 1),
          endLine: url.searchParams.has("end_line")
            ? Number(url.searchParams.get("end_line"))
            : undefined,
          expectedContentHash: url.searchParams.get("content_hash") ?? undefined,
        });
        sendJson(response, 200, file, origin);
        return;
      }

      const conversationTreeMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/tree$/,
      );
      if (conversationTreeMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(conversationTreeMatch[1]);
        const tree = await projectWorkService.getConversationTree(conversationId, {
          directory: url.searchParams.get("path") ?? "",
          depth: Number(url.searchParams.get("depth") ?? 3),
          query: url.searchParams.get("query") ?? "",
          limit: url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        sendJson(response, 200, tree, origin);
        return;
      }

      const conversationDocumentsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/documents$/,
      );
      if (conversationDocumentsMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationDocumentsMatch[1],
        );
        const payload = await readProjectWorkJson(request);
        const result = await projectWorkService.createConversationDocument(
          conversationId,
          {
            fileName: payload.file_name,
            byteLength: payload.byte_length,
          },
        );
        sendJson(response, 201, {
          schemaVersion: 1,
          document: result.document,
          snapshot: result.snapshot,
        }, origin);
        return;
      }

      const conversationAttachmentsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/attachments$/,
      );
      if (conversationAttachmentsMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationAttachmentsMatch[1],
        );
        const payload = await readProjectWorkJson(request);
        const attachment = await projectWorkService.createConversationAttachment(
          conversationId,
          {
            fileName: payload.file_name,
            mimeType: payload.mime_type,
            byteLength: payload.byte_length,
          },
        );
        sendJson(response, 201, {
          schemaVersion: 1,
          attachment,
        }, origin);
        return;
      }

      const conversationAttachmentMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/attachments\/([^/]+)$/,
      );
      if (conversationAttachmentMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationAttachmentMatch[1],
        );
        const attachmentId = decodeProjectWorkSegment(
          conversationAttachmentMatch[2],
        );
        const result = await projectWorkService.removeConversationAttachment(
          conversationId,
          attachmentId,
        );
        sendJson(response, 200, result, origin);
        return;
      }

      const conversationAttachmentContentMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/attachments\/([^/]+)\/content$/,
      );
      if (conversationAttachmentContentMatch && request.method === "PUT") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationAttachmentContentMatch[1],
        );
        const attachmentId = decodeProjectWorkSegment(
          conversationAttachmentContentMatch[2],
        );
        const attachment = await projectWorkService.uploadConversationAttachment(
          conversationId,
          attachmentId,
          request,
          {
            contentType: request.headers["content-type"],
            declaredLength: request.headers["content-length"],
          },
        );
        sendJson(response, 201, {
          schemaVersion: 1,
          attachment,
        }, origin);
        return;
      }

      const conversationDocumentMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/documents\/([^/]+)$/,
      );
      if (conversationDocumentMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationDocumentMatch[1],
        );
        const documentId = decodeProjectWorkSegment(
          conversationDocumentMatch[2],
        );
        const result = await projectWorkService.removeConversationDocument(
          conversationId,
          documentId,
        );
        sendJson(response, 200, result, origin);
        return;
      }

      const conversationDocumentActionMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/documents\/([^/]+)\/(content|retry)$/,
      );
      if (conversationDocumentActionMatch) {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationDocumentActionMatch[1],
        );
        const documentId = decodeProjectWorkSegment(
          conversationDocumentActionMatch[2],
        );
        const action = conversationDocumentActionMatch[3];
        if (action === "content" && request.method === "PUT") {
          const result = await projectWorkService.uploadConversationDocument(
            conversationId,
            documentId,
            request,
            {
              contentType: request.headers["content-type"],
              declaredLength: request.headers["content-length"],
            },
          );
          sendJson(response, 202, result, origin);
          return;
        }
        if (action === "retry" && request.method === "POST") {
          await readProjectWorkJson(request);
          const result = await projectWorkService.retryConversationDocument(
            conversationId,
            documentId,
          );
          sendJson(response, 202, result, origin);
          return;
        }
      }

      const conversationMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)$/,
      );
      if (conversationMatch && request.method === "PATCH") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(conversationMatch[1]);
        const payload = await readProjectWorkJson(request);
        const conversation = await projectWorkService.renameStandaloneConversation(
          conversationId,
          { title: payload.title },
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          conversation: publicProjectWorkConversationSummary(conversation),
        }, origin);
        return;
      }
      if (conversationMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(conversationMatch[1]);
        const result = await projectWorkService.removeStandaloneConversation(
          conversationId,
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          projectId: null,
          conversationId: result.id,
          removed: result.removed === true,
          conversationCount: result.conversationCount,
        }, origin);
        return;
      }
      if (conversationMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(conversationMatch[1]);
        const result = await projectWorkService.getConversation(conversationId, {
          afterSeq: Number(url.searchParams.get("after_seq") ?? 0),
          eventLimit: Number(url.searchParams.get("event_limit") ?? 500),
        });
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(result),
          origin,
        );
        return;
      }

      const conversationEventsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/events$/,
      );
      if (conversationEventsMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          conversationEventsMatch[1],
        );
        const headerAfterSeq = Number(request.headers["last-event-id"]);
        const queryAfterSeq = Number(url.searchParams.get("after_seq"));
        const afterSeq = Number.isSafeInteger(headerAfterSeq) && headerAfterSeq >= 0
          ? headerAfterSeq
          : Number.isSafeInteger(queryAfterSeq) && queryAfterSeq >= 0
            ? queryAfterSeq
            : 0;
        const wantsStream = String(request.headers.accept ?? "")
          .includes("text/event-stream");
        const initialSnapshot = await projectWorkService.getConversation(
          conversationId,
          {
            afterSeq,
            eventLimit: Number(url.searchParams.get("limit") ?? 500),
          },
        );
        if (!wantsStream) {
          const publicSnapshot = publicProjectWorkConversationState(
            initialSnapshot,
          );
          sendJson(response, 200, {
            schema_version: 1,
            snapshot_watermark:
              publicSnapshot.conversation?.lastEventSeq ?? afterSeq,
            conversation: publicSnapshot.conversation,
            events: publicSnapshot.events,
            has_more: publicSnapshot.hasMoreEvents,
            last_seq: publicSnapshot.events?.at(-1)?.seq ?? afterSeq,
          }, origin);
          return;
        }
        if (typeof projectWorkService.subscribeEvents !== "function") {
          throw projectWorkError(
            "PROJECT_WORK_EVENT_STREAM_UNAVAILABLE",
            "项目工作事件流当前不可用",
            503,
            true,
          );
        }

        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
          ...corsHeaders(origin),
        });
        response.write("retry: 1500\n\n");
        let closed = false;
        let lastSentSeq = afterSeq;
        let pump = Promise.resolve();
        const pushSnapshot = async () => {
          if (closed) return;
          let hasMore = true;
          while (hasMore && !closed) {
            const nextSnapshot = await projectWorkService.getConversation(
              conversationId,
              {
                afterSeq: lastSentSeq,
                eventLimit: 500,
              },
            );
            const publicSnapshot = publicProjectWorkConversationState(
              nextSnapshot,
            );
            const events = Array.isArray(publicSnapshot.events)
              ? publicSnapshot.events
              : [];
            if (events.length > 0) {
              lastSentSeq = events.at(-1).seq;
            } else if (lastSentSeq === 0) {
              lastSentSeq = publicSnapshot.conversation?.lastEventSeq ?? 0;
            }
            response.write(`id: ${lastSentSeq}\n`);
            response.write("event: snapshot\n");
            response.write(`data: ${JSON.stringify({
              schema_version: 1,
              snapshot_watermark:
                publicSnapshot.conversation?.lastEventSeq ?? lastSentSeq,
              conversation: publicSnapshot.conversation,
              events,
              has_more: Boolean(publicSnapshot.hasMoreEvents),
              last_seq: lastSentSeq,
            })}\n\n`);
            hasMore = Boolean(publicSnapshot.hasMoreEvents);
          }
        };
        const scheduleSnapshot = () => {
          pump = pump.then(pushSnapshot).catch((error) => {
            if (closed) return;
            response.write("event: stream_error\n");
            response.write(`data: ${JSON.stringify({
              code: error?.code ?? "PROJECT_WORK_EVENT_STREAM_FAILED",
              message: error?.message ?? "项目工作事件流暂时中断",
            })}\n\n`);
          });
        };
        const unsubscribe = projectWorkService.subscribeEvents(
          conversationId,
          scheduleSnapshot,
        );
        const heartbeat = setInterval(() => {
          if (!closed) response.write(": keep-alive\n\n");
        }, 15_000);
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
        };
        request.once("close", close);
        response.once("close", close);
        scheduleSnapshot();
        return;
      }

      const followUpsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/follow-ups$/,
      );
      if (followUpsMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(followUpsMatch[1]);
        sendJson(response, 200, {
          schemaVersion: 1,
          items: await projectWorkService.listFollowUps(conversationId, {
            includeHistory: url.searchParams.get("include_history") === "true",
          }),
        }, origin);
        return;
      }
      if (followUpsMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(followUpsMatch[1]);
        const payload = await readProjectWorkJson(request);
        sendJson(
          response,
          202,
          publicProjectWorkConversationState(
            await projectWorkService.enqueueFollowUp(conversationId, {
              text: payload.text,
            }),
          ),
          origin,
        );
        return;
      }
      if (followUpsMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(followUpsMatch[1]);
        sendJson(
          response,
          200,
          await projectWorkService.clearFollowUps(conversationId),
          origin,
        );
        return;
      }

      const followUpMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/follow-ups\/([^/]+)$/,
      );
      if (followUpMatch && request.method === "DELETE") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(followUpMatch[1]);
        const itemId = decodeProjectWorkSegment(followUpMatch[2]);
        sendJson(
          response,
          200,
          await projectWorkService.removeFollowUp(conversationId, itemId),
          origin,
        );
        return;
      }

      const askUserRequestsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/questions$/,
      );
      if (askUserRequestsMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          askUserRequestsMatch[1],
        );
        sendJson(response, 200, {
          schemaVersion: 1,
          requests: await projectWorkService.listAskUserRequests(
            conversationId,
            {
              includeHistory: url.searchParams.get("include_history") === "true",
            },
          ),
        }, origin);
        return;
      }
      if (askUserRequestsMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          askUserRequestsMatch[1],
        );
        const payload = await readProjectWorkJson(request);
        const questions = Array.isArray(payload.questions)
          ? payload.questions.map((question) => ({
              id: question?.id,
              label: question?.label,
              prompt: question?.prompt,
              kind: question?.kind,
              required: question?.required,
              options: Array.isArray(question?.options)
                ? question.options.map((option) => ({
                    id: option?.id,
                    label: option?.label,
                    description: option?.description,
                  }))
                : [],
            }))
          : payload.questions;
        sendJson(
          response,
          201,
          await projectWorkService.createAskUserRequest(conversationId, {
            questions,
          }),
          origin,
        );
        return;
      }

      const askUserRequestActionMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/questions\/([^/]+)\/(answer|cancel)$/,
      );
      if (askUserRequestActionMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          askUserRequestActionMatch[1],
        );
        const requestId = decodeProjectWorkSegment(
          askUserRequestActionMatch[2],
        );
        const action = askUserRequestActionMatch[3];
        const payload = await readProjectWorkJson(request);
        const result = action === "answer"
          ? await projectWorkService.answerAskUserRequest(
              conversationId,
              requestId,
              {
                answers: Array.isArray(payload.answers)
                  ? payload.answers.map((answer) => ({
                      questionId: answer?.question_id ?? answer?.questionId,
                      value: answer?.value,
                    }))
                  : payload.answers,
              },
            )
          : await projectWorkService.cancelAskUserRequest(
              conversationId,
              requestId,
            );
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(result),
          origin,
        );
        return;
      }

      const conversationTurnsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/turns$/,
      );
      if (conversationTurnsMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          conversationTurnsMatch[1],
        );
        const beforeTurnSeq = url.searchParams.has("before_turn_seq")
          ? Number(url.searchParams.get("before_turn_seq"))
          : undefined;
        const limit = url.searchParams.has("limit")
          ? Number(url.searchParams.get("limit"))
          : 20;
        sendJson(
          response,
          200,
          await projectWorkService.getConversationTurns(conversationId, {
            beforeTurnSeq,
            limit,
          }),
          origin,
        );
        return;
      }

      const conversationReadMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/read$/,
      );
      if (conversationReadMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationReadMatch[1],
        );
        const payload = await readProjectWorkJson(request);
        if (
          payload?.schema_version !== 1
          || !projectWorkClientRequestIdPattern.test(
            String(payload?.client_request_id ?? ""),
          )
          || Object.keys(payload).some(
            (key) => ![
              "schema_version",
              "client_request_id",
              "through_message_seq",
            ].includes(key),
          )
          || (
            payload.through_message_seq !== undefined
            && (
              !Number.isSafeInteger(payload.through_message_seq)
              || payload.through_message_seq < 0
            )
          )
        ) {
          throw projectWorkError(
            "PROJECT_WORK_READ_REQUEST_INVALID",
            "会话已读请求无效",
            400,
          );
        }
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(
            await projectWorkService.markConversationRead(conversationId, {
              throughMessageSeq: payload.through_message_seq,
              clientRequestId: payload.client_request_id,
            }),
          ),
          origin,
        );
        return;
      }

      const conversationRetryMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/retry-last-turn$/,
      );
      if (conversationRetryMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationRetryMatch[1],
        );
        const payload = await readProjectWorkJson(request);
        if (
          payload?.schema_version !== 1
          || !projectWorkClientRequestIdPattern.test(
            String(payload?.client_request_id ?? ""),
          )
          || (
            payload?.checkpoint_id !== undefined
            && !projectWorkClientRequestIdPattern.test(
              String(payload.checkpoint_id),
            )
          )
          || Object.keys(payload).some(
            (key) => ![
              "schema_version",
              "client_request_id",
              "checkpoint_id",
            ].includes(key),
          )
        ) {
          throw projectWorkError(
            "PROJECT_WORK_RETRY_REQUEST_INVALID",
            "重试上一轮的请求无效",
            400,
          );
        }
        sendJson(
          response,
          202,
          publicProjectWorkConversationState(
            await projectWorkService.retryLastTurn(conversationId, {
              clientRequestId: payload.client_request_id,
              ...(payload.checkpoint_id
                ? { checkpointId: payload.checkpoint_id }
                : {}),
            }),
          ),
          origin,
        );
        return;
      }

      const conversationForkMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/forks$/,
      );
      if (conversationForkMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          conversationForkMatch[1],
        );
        const payload = await readProjectWorkJson(request);
        if (
          payload?.schema_version !== 1
          || !projectWorkClientRequestIdPattern.test(
            String(payload?.client_request_id ?? ""),
          )
          || !projectWorkClientRequestIdPattern.test(
            String(payload?.checkpoint_id ?? ""),
          )
          || Object.keys(payload).some(
            (key) => ![
              "schema_version",
              "client_request_id",
              "checkpoint_id",
            ].includes(key),
          )
        ) {
          throw projectWorkError(
            "PROJECT_WORK_FORK_REQUEST_INVALID",
            "从检查点新建会话的请求无效",
            400,
          );
        }
        sendJson(
          response,
          201,
          publicProjectWorkConversationState(
            await projectWorkService.forkConversationFromCheckpoint(
              conversationId,
              {
                clientRequestId: payload.client_request_id,
                checkpointId: payload.checkpoint_id,
              },
            ),
          ),
          origin,
        );
        return;
      }

      const conversationActionMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/(messages|steer|abort|compact|configuration|execution-policy)$/,
      );
      if (conversationActionMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(conversationActionMatch[1]);
        const action = conversationActionMatch[2];
        const payload = await readProjectWorkJson(
          request,
          action === "messages"
            ? { maxBytes: 8 * 1024 * 1024 }
            : undefined,
        );
        let result;
        if (action === "messages") {
          if (
            payload?.checkpoint_message_id !== undefined
            && !projectWorkClientRequestIdPattern.test(
              String(payload.checkpoint_message_id),
            )
          ) {
            throw projectWorkError(
              "PROJECT_WORK_MESSAGE_REQUEST_INVALID",
              "消息检查点无效",
              400,
            );
          }
          result = await projectWorkService.sendMessage(conversationId, {
            text: payload.text,
            ...(payload.checkpoint_message_id
              ? { checkpointId: payload.checkpoint_message_id }
              : {}),
            context: Array.isArray(payload.contexts)
              ? payload.contexts.map((context) => ({
                  path: context?.path,
                  contentHash: context?.content_hash ?? context?.contentHash,
                  startLine: context?.start_line ?? context?.startLine,
                  endLine: context?.end_line ?? context?.endLine,
                }))
              : [],
            providerId: payload.provider_id,
            modelId: payload.model_id,
            thinkingLevel: payload.thinking_level,
            workflowId: payload.workflow_id,
            capabilities: payload.capabilities,
            images: payload.images,
            attachments: payload.attachments,
            clientRequestId: payload.client_request_id,
          });
        } else if (action === "steer") {
          result = await projectWorkService.steerConversation(conversationId, {
            text: payload.text,
          });
        } else if (action === "abort") {
          result = await projectWorkService.abortConversation(conversationId);
        } else if (action === "configuration") {
          result = await projectWorkService.configureConversation(conversationId, {
            providerId: payload.provider_id,
            modelId: payload.model_id,
            thinkingLevel: payload.thinking_level,
          });
        } else if (action === "execution-policy") {
          result = await projectWorkService.configureExecutionPolicy(
            conversationId,
            {
              mode: payload.mode,
              expectedRevision: payload.expected_revision,
            },
          );
        } else {
          result = await projectWorkService.compactConversation(conversationId, {
            instructions: payload.instructions,
          });
        }
        sendJson(
          response,
          action === "messages" || action === "steer" ? 202 : 200,
          publicProjectWorkConversationState(result),
          origin,
        );
        return;
      }

      const workspaceRecordMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/workspace$/,
      );
      if (workspaceRecordMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(workspaceRecordMatch[1]);
        sendJson(response, 200, {
          schemaVersion: 1,
          workspace: await projectWorkService.getWorkspace(conversationId),
        }, origin);
        return;
      }

      const gitEvidenceMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/git-evidence$/,
      );
      if (gitEvidenceMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(gitEvidenceMatch[1]);
        sendJson(response, 200, {
          schemaVersion: 1,
          git: await projectWorkService.getGitEvidence(conversationId),
        }, origin);
        return;
      }

      const gitCloseoutsMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/git-closeouts$/,
      );
      if (gitCloseoutsMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(gitCloseoutsMatch[1]);
        sendJson(response, 200, {
          schemaVersion: 1,
          gitCloseouts: await projectWorkService.listGitCloseouts(
            conversationId,
          ),
        }, origin);
        return;
      }

      const gitCloseoutConfirmMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/git-closeouts\/([^/]+)\/confirm$/,
      );
      if (gitCloseoutConfirmMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          gitCloseoutConfirmMatch[1],
        );
        const proposalId = decodeProjectWorkSegment(
          gitCloseoutConfirmMatch[2],
        );
        const payload = await readProjectWorkJson(request);
        if (
          payload?.schema_version !== 1
          || payload?.proposal_id !== proposalId
          || Object.keys(payload).some((key) => ![
            "schema_version",
            "proposal_id",
            "proposal_hash",
            "conversation_id",
            "turn_id",
            "change_set_id",
            "change_set_hash",
            "branch",
            "head",
            "commit_message",
            "files",
            "verification_evidence",
          ].includes(key))
        ) {
          throw projectWorkError(
            "GIT_CLOSEOUT_CONFIRMATION_INVALID",
            "Git 收尾确认请求无效",
            400,
          );
        }
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(
            await projectWorkService.confirmGitCloseout(
              conversationId,
              {
                proposalId,
                proposalHash: payload.proposal_hash,
                conversationId: payload.conversation_id,
                turnId: payload.turn_id,
                changeSetId: payload.change_set_id,
                changeSetHash: payload.change_set_hash,
                branch: payload.branch,
                head: payload.head,
                commitMessage: payload.commit_message,
                files: Array.isArray(payload.files)
                  ? payload.files.map((file) => ({
                      path: file.path,
                      hash: file.hash,
                      exists: file.exists === true,
                      mode: file.mode,
                      baseHash: file.base_hash,
                      baseExists: file.base_exists === true,
                      baseMode: file.base_mode,
                    }))
                  : payload.files,
                verificationEvidence: Array.isArray(
                  payload.verification_evidence,
                )
                  ? payload.verification_evidence.map((evidence) => ({
                      id: evidence.id,
                      commandId: evidence.command_id,
                      status: evidence.status,
                      exitCode: evidence.exit_code,
                      changeSetId: evidence.change_set_id,
                      changeSetHash: evidence.change_set_hash,
                      commandBindingHash: evidence.command_binding_hash,
                      completedAt: evidence.completed_at,
                    }))
                  : payload.verification_evidence,
              },
            ),
          ),
          origin,
        );
        return;
      }

      const applyJournalMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/applies$/,
      );
      if (applyJournalMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(applyJournalMatch[1]);
        sendJson(response, 200, {
          schemaVersion: 1,
          applies: await projectWorkService.listApplyJournal(conversationId),
        }, origin);
        return;
      }

      const undoApplyMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/applies\/([^/]+)\/undo$/,
      );
      if (undoApplyMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(undoApplyMatch[1]);
        const applyId = decodeProjectWorkSegment(undoApplyMatch[2]);
        const payload = await readProjectWorkJson(request);
        sendJson(
          response,
          200,
          await projectWorkService.undoApply(conversationId, applyId, {
            undoHash: payload.undo_hash ?? payload.undoHash,
          }),
          origin,
        );
        return;
      }

      const changeSetMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/change-sets\/([^/]+)\/apply$/,
      );
      if (changeSetMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(changeSetMatch[1]);
        const changeSetId = decodeProjectWorkSegment(changeSetMatch[2]);
        const payload = await readProjectWorkJson(request);
        await projectWorkService.applyChangeSet(conversationId, {
          changeSetId,
          changeSetHash: payload.proposal_hash,
          files: Array.isArray(payload.selected_files)
            ? payload.selected_files.map((file) => ({
                fileId: file.file_id,
                baseHash: file.base_hash ?? null,
                afterHash: file.after_hash ?? null,
              }))
            : payload.selected_files,
        });
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(
            await projectWorkService.getConversation(conversationId),
          ),
          origin,
        );
        return;
      }

      const previewStartMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/previews\/([^/]+)\/start$/,
      );
      if (previewStartMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(previewStartMatch[1]);
        const previewId = decodeProjectWorkSegment(previewStartMatch[2]);
        const payload = await readProjectWorkJson(request);
        if (
          typeof payload?.client_request_id !== "string"
          || !projectWorkClientRequestIdPattern.test(payload.client_request_id)
        ) {
          throw projectWorkError(
            "PROJECT_WORK_CLIENT_REQUEST_ID_INVALID",
            "启动本机预览必须提供稳定的请求标识",
            400,
          );
        }
        if (
          payload?.schema_version !== 1
          || !sha256Pattern.test(String(payload.request_hash ?? ""))
          || Object.keys(payload).some(
            (key) => ![
              "schema_version",
              "client_request_id",
              "request_hash",
            ].includes(key),
          )
        ) {
          throw projectWorkError(
            "PROJECT_WORK_PREVIEW_START_REQUEST_INVALID",
            "本机预览确认请求无效",
            400,
          );
        }
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(
            await projectWorkService.startPreview(conversationId, {
              previewId,
              requestHash: payload.request_hash,
            }),
          ),
          origin,
        );
        return;
      }

      const browserQaMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/browser-qa$/,
      );
      if (browserQaMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(browserQaMatch[1]);
        const payload = await readProjectWorkJson(request);
        if (
          typeof payload?.client_request_id !== "string"
          || !projectWorkClientRequestIdPattern.test(payload.client_request_id)
        ) {
          throw projectWorkError(
            "PROJECT_WORK_CLIENT_REQUEST_ID_INVALID",
            "页面验收必须提供稳定的请求标识",
            400,
          );
        }
        if (
          payload.schema_version !== 1
          || Object.keys(payload).some(
            (key) => !["schema_version", "client_request_id"].includes(key),
          )
        ) {
          throw projectWorkError(
            "PROJECT_BROWSER_QA_REQUEST_INVALID",
            "页面验收请求无效",
            400,
          );
        }
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(
            await projectWorkService.runBrowserQa(conversationId, {
              clientRequestId: payload.client_request_id,
            }),
          ),
          origin,
        );
        return;
      }

      const browserQaScreenshotMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/browser-qa\/([^/]+)\/(desktop|mobile)\/screenshot$/,
      );
      if (browserQaScreenshotMatch && request.method === "GET") {
        const conversationId = decodeProjectWorkSegment(
          browserQaScreenshotMatch[1],
        );
        const runId = decodeProjectWorkSegment(
          browserQaScreenshotMatch[2],
        );
        sendProjectWorkImage(
          response,
          await projectWorkService.readBrowserQaScreenshot(
            conversationId,
            runId,
            browserQaScreenshotMatch[3],
          ),
          origin,
        );
        return;
      }

      const verificationMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/verifications$/,
      );
      if (verificationMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(verificationMatch[1]);
        const payload = await readProjectWorkJson(request);
        await projectWorkService.runVerification(conversationId, {
          requestId: payload.command_id,
        });
        sendJson(
          response,
          200,
          publicProjectWorkConversationState(
            await projectWorkService.getConversation(conversationId),
          ),
          origin,
        );
        return;
      }

      const verificationRepairResumeMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/verification-repairs\/([^/]+)\/resume$/,
      );
      if (
        verificationRepairResumeMatch
        && request.method === "POST"
      ) {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(
          verificationRepairResumeMatch[1],
        );
        const operationId = decodeProjectWorkSegment(
          verificationRepairResumeMatch[2],
        );
        const payload = await readProjectWorkJson(request);
        if (
          payload?.schema_version !== 1
          || !projectWorkClientRequestIdPattern.test(
            String(payload?.client_request_id ?? ""),
          )
          || Object.keys(payload).some(
            (key) => !["schema_version", "client_request_id"].includes(key),
          )
        ) {
          throw projectWorkError(
            "PROJECT_WORK_VERIFICATION_REPAIR_REQUEST_INVALID",
            "恢复验证修复的请求无效",
            400,
          );
        }
        await projectWorkService.resumeVerificationRepair(conversationId, {
          operationId,
          clientRequestId: payload.client_request_id,
        });
        sendJson(
          response,
          202,
          publicProjectWorkConversationState(
            await projectWorkService.getConversation(conversationId),
          ),
          origin,
        );
        return;
      }

      sendJson(response, 404, {
        error: {
          code: "PROJECT_WORK_ROUTE_NOT_FOUND",
          message: "项目工作接口不存在",
          retryable: false,
        },
      }, origin);
    } catch (error) {
      sendProjectWorkError(response, error, origin);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/model-providers") {
    sendJson(response, 200, await candidateSummaryService.listProviders(), origin);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/journal-sources") {
    sendJson(response, 200, {
      schema_version: SOURCE_REGISTRY_VERSION,
      sources: SOURCE_REGISTRY.map((source) => ({
        source_id: source.source_id,
        short_name: source.short_name,
        venue: source.venue,
        source_type: source.source_type,
        adapter: source.adapter,
        primary: source.primary,
        fallback: source.fallback,
      })),
    }, origin);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/zotero/status") {
    try {
      const status = await journalWorkflowService.getZoteroStatus();
      sendJson(response, 200, {
        schema_version: 1,
        available: Boolean(status.available),
        api_version: status.apiVersion ?? null,
        connector_available: Boolean(status.connectorAvailable),
      }, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法连接本机 Zotero");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/zotero/targets") {
    try {
      const bundle = await journalWorkflowService.getZoteroTargets();
      sendJson(response, 200, {
        schema_version: 1,
        selected_target_id: bundle.selectedTargetId ?? null,
        targets: Array.isArray(bundle.targets)
          ? bundle.targets.map(publicZoteroTarget)
          : [],
      }, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取 Zotero 写入目标");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/journal-runs") {
    sendJson(response, 200, {
      schema_version: 1,
      runs: (await journalWorkflowService.listRuns()).map(publicRun),
    }, origin);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/journal-venue-search") {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = ["schema_version", "query", "limit", "from_year"];
      if (
        body?.schema_version !== 1
        || typeof body?.query !== "string"
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "期刊检索请求版本或字段无效", 400);
      }
      const limit = Number.isInteger(body?.limit)
        ? Math.min(Math.max(body.limit, 1), 50)
        : undefined;
      const fromYear = Number.isInteger(body?.from_year) ? body.from_year : null;
      const result = await journalWorkflowService.searchVenues({
        query: body.query,
        limit,
        fromYear,
      });
      sendJson(response, 200, result, origin);
    } catch (error) {
      if (error instanceof CandidateSummaryError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message, retryable: error.retryable },
        }, origin);
        return;
      }
      const retryable = Boolean(error?.retryable);
      sendJson(response, retryable ? 502 : 400, {
        error: {
          code: typeof error?.code === "string" ? error.code : "JOURNAL_VENUE_SEARCH_FAILED",
          message: typeof error?.message === "string" ? error.message : "期刊检索失败",
          retryable,
        },
      }, origin);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/venue-search") {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.getVenueSearchConversation(
          url.searchParams.get("conversation_id") || null,
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取主题检索记录");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/venue-search/conversations") {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.listVenueSearchConversations(),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取主题检索会话列表");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/venue-search/conversations") {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = ["schema_version", "title"];
      if (
        body?.schema_version !== 1
        || (body.title != null && typeof body.title !== "string")
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "新建检索会话的请求无效", 400);
      }
      sendJson(
        response,
        200,
        await journalWorkflowService.createVenueSearchConversation({ title: body.title ?? null }),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法新建主题检索会话");
    }
    return;
  }

  const venueConversationMatch = url.pathname.match(
    /^\/api\/v1\/venue-search\/conversations\/([^/]+)$/,
  );
  if (request.method === "DELETE" && venueConversationMatch) {
    try {
      requireJournalMutationOrigin(origin);
      sendJson(
        response,
        200,
        await journalWorkflowService.deleteVenueSearchConversation(
          decodeURIComponent(venueConversationMatch[1]),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法删除主题检索会话");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/venue-search/turn-progress") {
    try {
      const clientRequestId = url.searchParams.get("client_request_id") || "";
      if (!clientRequestId.trim()) {
        throw new CandidateSummaryError("INVALID_REQUEST", "进度查询必须提供稳定的请求标识", 400);
      }
      sendJson(
        response,
        200,
        { schema_version: 1, ...journalWorkflowService.getVenueSearchTurnProgress(clientRequestId) },
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取主题检索进度");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/venue-search/turns") {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = [
        "schema_version",
        "conversation_id",
        "question",
        "provider_id",
        "model_id",
        "thinking_level",
        "client_request_id",
      ];
      if (
        body?.schema_version !== 1
        || typeof body?.question !== "string"
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "主题检索请求版本或字段无效", 400);
      }
      const conversation = await journalWorkflowService.submitVenueSearchTurn({
        conversationId: body.conversation_id ?? null,
        question: body.question,
        providerId: body.provider_id,
        modelId: body.model_id,
        thinkingLevel: body.thinking_level ?? null,
        clientRequestId: body.client_request_id,
      });
      sendJson(response, 200, conversation, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "主题检索失败");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/venue-search/add-to-weekly") {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = ["schema_version", "conversation_id", "turn_id", "paper_ids", "client_request_id"];
      if (
        body?.schema_version !== 1
        || typeof body?.turn_id !== "string"
        || !Array.isArray(body?.paper_ids)
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "加入本月推荐的请求无效", 400);
      }
      const result = await journalWorkflowService.addVenueSearchPapersToWeekly({
        conversationId: body.conversation_id ?? null,
        turnId: body.turn_id,
        paperIds: body.paper_ids,
      });
      sendJson(response, 200, {
        run: publicRun(result.run),
        conversation: result.conversation,
      }, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法加入本月推荐");
    }
    return;
  }

  const journalRecentClassicsAddMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/recent-classics\/add$/,
  );
  if (request.method === "POST" && journalRecentClassicsAddMatch) {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = ["schema_version", "paper_ids"];
      if (
        body?.schema_version !== 1
        || !Array.isArray(body?.paper_ids)
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "加入本月推荐的请求无效", 400);
      }
      const run = await journalWorkflowService.addRecentClassicsToWeekly({
        runId: journalRecentClassicsAddMatch[1],
        paperIds: body.paper_ids,
      });
      sendJson(response, 200, publicRun(run), origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法加入本月推荐");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/journal/past-papers/add") {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = ["schema_version", "source_run_id", "paper_ids"];
      if (
        body?.schema_version !== 1
        || typeof body?.source_run_id !== "string"
        || !body.source_run_id.trim()
        || !Array.isArray(body?.paper_ids)
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "加入本月推荐的请求无效", 400);
      }
      const run = await journalWorkflowService.addPastRunPapersToWeekly({
        sourceRunId: body.source_run_id,
        paperIds: body.paper_ids,
      });
      sendJson(response, 200, publicRun(run), origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法加入本月推荐");
    }
    return;
  }

  const journalRefreshCandidatesMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/refresh-candidates$/,
  );
  if (request.method === "POST" && journalRefreshCandidatesMatch) {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || Object.keys(body).some((key) => key !== "schema_version")
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "刷新本月推荐的请求无效", 400);
      }
      const run = await journalWorkflowService.refreshRunCandidates(
        journalRefreshCandidatesMatch[1],
      );
      sendJson(response, 200, publicRun(run), origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法刷新本月推荐");
    }
    return;
  }

  const journalTranslateLibraryMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/translate-library$/,
  );
  if (request.method === "POST" && journalTranslateLibraryMatch) {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || Object.keys(body).some((key) => key !== "schema_version")
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "翻译请求无效", 400);
      }
      const run = await journalWorkflowService.translateJournalRunLibrary(
        journalTranslateLibraryMatch[1],
      );
      sendJson(response, 200, publicRun(run), origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法完成翻译");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/journal/dismissed-papers") {
    try {
      requireJournalMutationOrigin(origin);
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = ["schema_version", "run_id", "dedupe_key", "title"];
      if (
        body?.schema_version !== 1
        || typeof body?.dedupe_key !== "string"
        || !body.dedupe_key.trim()
        || Object.keys(body).some((key) => !allowedKeys.includes(key))
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "不感兴趣的请求无效", 400);
      }
      const result = await journalWorkflowService.dismissJournalPaper({
        runId: typeof body.run_id === "string" && body.run_id ? body.run_id : null,
        dedupeKey: body.dedupe_key,
        title: typeof body.title === "string" ? body.title : "",
      });
      sendJson(response, 200, {
        schema_version: 1,
        papers: result.papers,
        run: result.run ? publicRun(result.run) : null,
      }, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法标记不感兴趣");
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/project-context") {
    try {
      sendJson(
        response,
        200,
        publicProjectContext(await journalWorkflowService.getProjectContext()),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取项目状态");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/journal-runs") {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || Object.keys(body).some(
          (key) => !["schema_version", "provider_id", "model_id", "thinking_level"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "期刊扫描请求版本或字段无效", 400);
      }
      const run = await journalWorkflowService.startRun({
        trigger: "manual",
        providerId: body?.provider_id,
        modelId: body?.model_id,
        thinkingLevel: body?.thinking_level ?? null,
      });
      sendJson(response, 202, publicRun(run), origin);
    } catch (error) {
      const normalized = error instanceof CandidateSummaryError
        ? error
        : new CandidateSummaryError("JOURNAL_RUN_START_FAILED", "无法启动期刊扫描", 500, true);
      sendJson(response, normalized.status, {
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        },
      }, origin);
    }
    return;
  }

  const journalRunMatch = url.pathname.match(/^\/api\/v1\/journal-runs\/([a-zA-Z0-9._-]+)$/);
  if (request.method === "GET" && journalRunMatch) {
    const run = await journalWorkflowService.getRun(journalRunMatch[1]);
    if (!run) {
      sendJson(response, 404, { error: { code: "RUN_NOT_FOUND", message: "运行不存在", retryable: false } }, origin);
      return;
    }
    sendJson(response, 200, publicRun(run), origin);
    return;
  }

  const journalEventsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9._-]+)\/events$/,
  );
  if (request.method === "GET" && journalEventsMatch) {
    const runId = journalEventsMatch[1];
    const headerAfterSeq = Number(request.headers["last-event-id"]);
    const queryAfterSeq = Number(url.searchParams.get("after_seq"));
    const afterSeq = Number.isSafeInteger(headerAfterSeq) && headerAfterSeq >= 0
      ? headerAfterSeq
      : Number.isSafeInteger(queryAfterSeq) && queryAfterSeq >= 0
        ? queryAfterSeq
        : 0;
    const wantsStream = String(request.headers.accept ?? "")
      .includes("text/event-stream");
    try {
      const run = await journalWorkflowService.getRun(runId);
      if (!run) {
        sendJson(response, 404, {
          error: {
            code: "RUN_NOT_FOUND",
            message: "运行不存在",
            retryable: false,
          },
        }, origin);
        return;
      }
      if (!wantsStream) {
        const page = await journalWorkflowService.readEvents(runId, {
          afterSeq,
          limit: Number(url.searchParams.get("limit") ?? 500),
        });
        const deliveredLastSeq = page.events.at(-1)?.seq ?? afterSeq;
        sendJson(response, 200, {
          schema_version: 1,
          snapshot_watermark: run.snapshot_watermark ?? page.lastSeq,
          run: publicRun(run),
          events: page.events.map(publicJournalEvent).filter(Boolean),
          has_more: page.hasMore,
          last_seq: deliveredLastSeq,
        }, origin);
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
        ...corsHeaders(origin),
      });
      response.write("retry: 1500\n\n");
      let closed = false;
      let lastSentSeq = afterSeq;
      let pump = Promise.resolve();
      const pushSnapshot = async () => {
        if (closed) return;
        let hasMore = true;
        while (hasMore && !closed) {
          const [nextRun, page] = await Promise.all([
            journalWorkflowService.getRun(runId),
            journalWorkflowService.readEvents(runId, {
              afterSeq: lastSentSeq,
              limit: 500,
            }),
          ]);
          const publicEvents = page.events
            .map(publicJournalEvent)
            .filter(Boolean);
          const deliveredLastSeq = page.events.at(-1)?.seq;
          if (
            Number.isSafeInteger(deliveredLastSeq)
            && deliveredLastSeq > lastSentSeq
          ) {
            lastSentSeq = deliveredLastSeq;
          }
          response.write(`id: ${lastSentSeq}\n`);
          response.write("event: snapshot\n");
          response.write(`data: ${JSON.stringify({
            schema_version: 1,
            snapshot_watermark:
              nextRun?.snapshot_watermark ?? page.lastSeq,
            run: publicRun(nextRun),
            events: publicEvents,
            has_more: page.hasMore,
            last_seq: lastSentSeq,
          })}\n\n`);
          hasMore = page.hasMore;
        }
      };
      const scheduleSnapshot = () => {
        pump = pump.then(pushSnapshot).catch((error) => {
          if (closed) return;
          response.write("event: error\n");
          response.write(`data: ${JSON.stringify({
            code: error?.code ?? "JOURNAL_EVENT_STREAM_FAILED",
            message: error?.message ?? "论文运行事件流暂时中断",
          })}\n\n`);
        });
      };
      const unsubscribe = journalWorkflowService.subscribeEvents(
        runId,
        scheduleSnapshot,
      );
      const heartbeat = setInterval(() => {
        if (!closed) response.write(": keep-alive\n\n");
      }, 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.once("aborted", close);
      request.once("close", close);
      response.once("close", close);
      scheduleSnapshot();
    } catch (error) {
      if (!response.headersSent) {
        sendWorkflowError(
          response,
          error,
          origin,
          "无法读取论文运行事件",
        );
      }
    }
    return;
  }

  const journalResumeMatch = url.pathname.match(/^\/api\/v1\/journal-runs\/([a-zA-Z0-9._-]+)\/resume$/);
  if (request.method === "POST" && journalResumeMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || Object.keys(body).some((key) => key !== "schema_version")
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "恢复论文运行请求无效", 400);
      }
      const run = await journalWorkflowService.resumeRun(journalResumeMatch[1]);
      if (!run) {
        sendJson(response, 404, { error: { code: "RUN_NOT_FOUND", message: "运行不存在", retryable: false } }, origin);
        return;
      }
      sendJson(response, 202, publicRun(run), origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法恢复论文运行");
    }
    return;
  }

  const journalDecisionsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/paper-decisions$/,
  );
  if (request.method === "PUT" && journalDecisionsMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "论文决定请求版本无效", 400);
      }
      sendJson(
        response,
        200,
        publicRun(await journalWorkflowService.savePaperDecisions(
          journalDecisionsMatch[1],
          proposalDecisions(body.decisions),
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法保存论文决定");
    }
    return;
  }

  const journalReadingRestartMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/reading\/restart$/,
  );
  if (request.method === "POST" && journalReadingRestartMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || body?.from_step !== "guide"
        || !isJournalClientRequestId(body.client_request_id)
        || Object.keys(body).some(
          (key) => !["schema_version", "from_step", "client_request_id"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "重新研读请求无效", 400);
      }
      sendJson(
        response,
        200,
        publicRun(await journalWorkflowService.restartReadingFromGuide(
          journalReadingRestartMatch[1],
          { clientRequestId: body.client_request_id },
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法从五分钟导读重新开始");
    }
    return;
  }

  const journalReadingResetMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/reset$/,
  );
  if (request.method === "POST" && journalReadingResetMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "清空研读进度请求无效", 400);
      }
      sendJson(
        response,
        200,
        publicRun(await journalWorkflowService.resetPaperReading(
          journalReadingResetMatch[1],
          journalReadingResetMatch[2],
          { clientRequestId: body.client_request_id },
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法清空这篇论文的研读进度");
    }
    return;
  }

  const journalReadingMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading$/,
  );
  if (request.method === "GET" && journalReadingMatch) {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.getPaperReading(
          journalReadingMatch[1],
          journalReadingMatch[2],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取分阶段精读");
    }
    return;
  }

  const journalReadingStageMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/stages\/(research-question|method|evidence|project-relation)$/,
  );
  if (request.method === "POST" && journalReadingStageMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "精读阶段请求版本无效", 400);
      }
      sendJson(
        response,
        201,
        await journalWorkflowService.generateReadingStage(
          journalReadingStageMatch[1],
          journalReadingStageMatch[2],
          journalReadingStageMatch[3],
          {
            providerId: body.provider_id,
            modelId: body.model_id,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法生成当前精读阶段");
    }
    return;
  }

  const journalReadingQuestionsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/questions$/,
  );
  if (request.method === "POST" && journalReadingQuestionsMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "精读追问请求版本无效", 400);
      }
      sendJson(
        response,
        201,
        await journalWorkflowService.askReadingQuestion(
          journalReadingQuestionsMatch[1],
          journalReadingQuestionsMatch[2],
          {
            stage: body.stage,
            text: body.text,
            blockId: body.block_id ?? null,
            clientRequestId: body.client_request_id ?? null,
            providerId: body.provider_id,
            modelId: body.model_id,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法回答当前精读追问");
    }
    return;
  }

  const journalReadingConversationsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/conversations$/,
  );
  if (request.method === "POST" && journalReadingConversationsMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "新建研读会话请求无效", 400);
      }
      sendJson(
        response,
        201,
        await journalWorkflowService.createReadingConversation(
          journalReadingConversationsMatch[1],
          journalReadingConversationsMatch[2],
          { clientRequestId: body.client_request_id },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法新建研读会话");
    }
    return;
  }

  const journalReadingConversationActivateMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/conversations\/activate$/,
  );
  if (request.method === "POST" && journalReadingConversationActivateMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1 || typeof body?.conversation_id !== "string") {
        throw new CandidateSummaryError("INVALID_REQUEST", "切换会话请求无效", 400);
      }
      sendJson(
        response,
        200,
        await journalWorkflowService.switchReadingConversation(
          journalReadingConversationActivateMatch[1],
          journalReadingConversationActivateMatch[2],
          body.conversation_id,
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法切换研读会话");
    }
    return;
  }

  const journalReadingConversationPromoteMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/conversations\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})\/promote$/,
  );
  if (request.method === "POST" && journalReadingConversationPromoteMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || typeof body.confirmed_by !== "string"
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id", "confirmed_by"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "提升研读分支请求无效", 400);
      }
      sendJson(
        response,
        200,
        await journalWorkflowService.promoteReadingConversation(
          journalReadingConversationPromoteMatch[1],
          journalReadingConversationPromoteMatch[2],
          journalReadingConversationPromoteMatch[3],
          {
            clientRequestId: body.client_request_id,
            confirmedBy: body.confirmed_by,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法提升研读分支");
    }
    return;
  }

  const journalReadingChatMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/chat\/messages$/,
  );
  const journalReadingChatProgressMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/chat\/progress$/,
  );
  if (request.method === "GET" && journalReadingChatProgressMatch) {
    try {
      const clientRequestId = url.searchParams.get("client_request_id") || "";
      if (!isJournalClientRequestId(clientRequestId)) {
        throw new CandidateSummaryError("INVALID_REQUEST", "进度查询必须提供稳定的请求标识", 400);
      }
      const progress = journalWorkflowService.getReadingChatProgress(
        journalReadingChatProgressMatch[1],
        journalReadingChatProgressMatch[2],
        clientRequestId,
      );
      sendJson(response, 200, { schema_version: 1, ...progress }, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取对话进度");
    }
    return;
  }
  if (request.method === "POST" && journalReadingChatMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const allowedKeys = new Set([
        "schema_version",
        "client_request_id",
        "text",
        "reference",
        "round_id",
        "include_project_context",
        "provider_id",
        "model_id",
        "thinking_level",
      ]);
      const allowedReferenceKeys = new Set([
        "document_revision",
        "block_id",
        "block_ids",
        "start_offset",
        "end_offset",
      ]);
      if (
        !isJournalClientRequestId(body?.client_request_id)
      ) {
        throw new CandidateSummaryError(
          "READING_CHAT_CLIENT_REQUEST_ID_REQUIRED",
          "论文对话必须提供稳定的请求标识",
          400,
        );
      }
      if (
        body?.schema_version !== 1
        || Object.keys(body).some((key) => !allowedKeys.has(key))
        || (
          body.round_id != null
          && (
            typeof body.round_id !== "string"
            || !/^[a-z][a-z0-9-]{0,79}$/.test(body.round_id)
          )
        )
        || (
          body.include_project_context != null
          && typeof body.include_project_context !== "boolean"
        )
        || (
          body.reference != null
          && (
            typeof body.reference !== "object"
            || Array.isArray(body.reference)
            || Object.keys(body.reference).some((key) => !allowedReferenceKeys.has(key))
          )
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "论文对话请求版本或字段无效", 400);
      }
      sendJson(
        response,
        201,
        await journalWorkflowService.sendReadingChatMessage(
          journalReadingChatMatch[1],
          journalReadingChatMatch[2],
          {
            text: body.text,
            reference: body.reference ?? null,
            ...(body.round_id ? { roundId: body.round_id } : {}),
            clientRequestId: body.client_request_id ?? null,
            includeProjectContext: body.include_project_context === true,
            providerId: body.provider_id,
            modelId: body.model_id,
            thinkingLevel: body.thinking_level ?? null,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法完成当前论文对话");
    }
    return;
  }

  const journalReadingConclusionPinMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/chat\/turns\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})\/pin$/,
  );
  if (request.method === "POST" && journalReadingConclusionPinMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || typeof body.confirmed_by !== "string"
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id", "confirmed_by"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "固定论文结论请求无效", 400);
      }
      sendJson(
        response,
        201,
        await journalWorkflowService.pinReadingConclusion(
          journalReadingConclusionPinMatch[1],
          journalReadingConclusionPinMatch[2],
          journalReadingConclusionPinMatch[3],
          {
            clientRequestId: body.client_request_id,
            confirmedBy: body.confirmed_by,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法固定论文结论");
    }
    return;
  }

  const journalReadingConclusionUnpinMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/pinned-conclusions\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})\/unpin$/,
  );
  if (request.method === "POST" && journalReadingConclusionUnpinMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || typeof body.confirmed_by !== "string"
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id", "confirmed_by"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "取消固定论文结论请求无效", 400);
      }
      sendJson(
        response,
        200,
        await journalWorkflowService.unpinReadingConclusion(
          journalReadingConclusionUnpinMatch[1],
          journalReadingConclusionUnpinMatch[2],
          journalReadingConclusionUnpinMatch[3],
          {
            clientRequestId: body.client_request_id,
            confirmedBy: body.confirmed_by,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法取消固定论文结论");
    }
    return;
  }

  const journalReadingNoteCreateMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/chat\/turns\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})\/obsidian-note-proposals$/,
  );
  if (request.method === "POST" && journalReadingNoteCreateMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "Obsidian 修改预览请求无效", 400);
      }
      sendJson(
        response,
        201,
        await journalWorkflowService.createReadingNoteProposal(
          journalReadingNoteCreateMatch[1],
          journalReadingNoteCreateMatch[2],
          journalReadingNoteCreateMatch[3],
          { clientRequestId: body.client_request_id },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法生成 Obsidian 修改预览");
    }
    return;
  }

  const journalReadingNoteActionMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/agent-actions\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})(?:\/(commit|abandon))?$/,
  );
  if (request.method === "GET" && journalReadingNoteActionMatch && !journalReadingNoteActionMatch[4]) {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.getReadingNoteProposal(
          journalReadingNoteActionMatch[1],
          journalReadingNoteActionMatch[2],
          journalReadingNoteActionMatch[3],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取 Obsidian 修改预览");
    }
    return;
  }

  if (
    request.method === "POST"
    && journalReadingNoteActionMatch
    && ["commit", "abandon"].includes(journalReadingNoteActionMatch[4])
  ) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      const action = journalReadingNoteActionMatch[4];
      const allowedKeys = action === "commit"
        ? new Set([
            "schema_version",
            "client_request_id",
            "proposal_hash",
            "content_hash",
            "target_version_or_hash",
          ])
        : new Set(["schema_version", "client_request_id"]);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || Object.keys(body).some((key) => !allowedKeys.has(key))
        || (
          action === "commit"
          && ["proposal_hash", "content_hash", "target_version_or_hash"].some(
            (key) => typeof body[key] !== "string" || !body[key].trim(),
          )
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "Obsidian 修改确认请求无效", 400);
      }
      const runId = journalReadingNoteActionMatch[1];
      const paperId = journalReadingNoteActionMatch[2];
      const proposalId = journalReadingNoteActionMatch[3];
      const reading = action === "commit"
        ? await journalWorkflowService.commitReadingNoteProposal(
            runId,
            paperId,
            proposalId,
            {
              clientRequestId: body.client_request_id,
              proposalHash: body.proposal_hash,
              contentHash: body.content_hash,
              targetVersionOrHash: body.target_version_or_hash,
            },
          )
        : await journalWorkflowService.abandonReadingNoteProposal(
            runId,
            paperId,
            proposalId,
            { clientRequestId: body.client_request_id },
          );
      sendJson(response, 200, reading, origin);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法完成 Obsidian 修改操作");
    }
    return;
  }

  const journalReadingPositionMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/position$/,
  );
  if (request.method === "POST" && journalReadingPositionMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "阅读位置请求版本无效", 400);
      }
      sendJson(
        response,
        200,
        publicRun(await journalWorkflowService.saveReadingPosition(
          journalReadingPositionMatch[1],
          journalReadingPositionMatch[2],
          {
            mode: body.mode,
            blockId: body.block_id ?? null,
          },
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法保存阅读位置");
    }
    return;
  }

  const journalObsidianProposalsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/obsidian\/proposals$/,
  );
  if (request.method === "GET" && journalObsidianProposalsMatch) {
    try {
      sendJson(
        response,
        200,
        publicObsidianArtifact(
          await journalWorkflowService.getObsidianPreview(
            journalObsidianProposalsMatch[1],
          ),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取 Obsidian 精确预览");
    }
    return;
  }
  if (request.method === "POST" && journalObsidianProposalsMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "Obsidian 预览请求版本无效", 400);
      }
      sendJson(
        response,
        201,
        publicObsidianArtifact(
          await journalWorkflowService.createObsidianPreview(
            journalObsidianProposalsMatch[1],
          ),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法生成 Obsidian 精确预览");
    }
    return;
  }

  const journalProjectStateProposalsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/project-state\/proposals$/,
  );
  if (request.method === "GET" && journalProjectStateProposalsMatch) {
    try {
      sendJson(
        response,
        200,
        publicProjectStateArtifact(
          await journalWorkflowService.getProjectStatePreview(
            journalProjectStateProposalsMatch[1],
          ),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取项目状态精确预览");
    }
    return;
  }
  if (request.method === "POST" && journalProjectStateProposalsMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "项目状态预览请求版本无效", 400);
      }
      sendJson(
        response,
        201,
        publicProjectStateArtifact(
          await journalWorkflowService.createProjectStatePreview(
            journalProjectStateProposalsMatch[1],
          ),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法生成项目状态精确预览");
    }
    return;
  }

  const journalZoteroProposalsMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/zotero\/proposals$/,
  );
  if (request.method === "POST" && journalZoteroProposalsMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "Zotero 预览请求版本无效", 400);
      }
      await journalWorkflowService.createZoteroProposal(
        journalZoteroProposalsMatch[1],
        {
          decisions: proposalDecisions(body.decisions),
          targetId: body.target_id,
        },
      );
      sendJson(
        response,
        201,
        publicZoteroArtifact(
          await journalWorkflowService.getZoteroProposal(journalZoteroProposalsMatch[1]),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法生成 Zotero 精确预览");
    }
    return;
  }

  if (request.method === "GET" && journalZoteroProposalsMatch) {
    try {
      sendJson(
        response,
        200,
        publicZoteroArtifact(
          await journalWorkflowService.getZoteroProposal(journalZoteroProposalsMatch[1]),
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取 Zotero 精确预览");
    }
    return;
  }

  const journalZoteroCommitMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/zotero\/commit$/,
  );
  if (request.method === "POST" && journalZoteroCommitMatch) {
    sendJson(response, 410, {
      error: {
        code: "ZOTERO_COMMIT_DEPRECATED",
        message: "旧版 Zotero 单独确认入口已停用，请通过联合归档预览确认写入",
        retryable: false,
      },
    }, origin);
    return;
  }

  const journalArchiveCommitMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/archive\/commit$/,
  );
  if (request.method === "POST" && journalArchiveCommitMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "联合归档确认请求版本无效", 400);
      }
      sendJson(
        response,
        202,
        publicRun(await journalWorkflowService.startArchiveCommit(
          journalArchiveCommitMatch[1],
          {
            clientRequestId: body.client_request_id,
            obsidian: body.obsidian
              ? {
                  proposalHash: body.obsidian.proposal_hash,
                  operations: body.obsidian.operations,
                }
              : null,
            zotero: body.zotero
              ? {
                  proposalHash: body.zotero.proposal_hash,
                  operations: body.zotero.operations,
                }
              : null,
            projectState: body.project_state
              ? {
                  proposalHash: body.project_state.proposal_hash,
                  operation: body.project_state.operation,
                }
              : null,
            simulateObsidianFailure: body.simulate_obsidian_failure === true,
          },
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法确认联合归档写入");
    }
    return;
  }

  const journalGuidesMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/guides$/,
  );
  if (request.method === "POST" && journalGuidesMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "导读请求版本无效", 400);
      }
      sendJson(
        response,
        202,
        publicRun(await journalWorkflowService.startGuides(journalGuidesMatch[1], {
          paperIds: body.paper_ids,
          providerId: body.provider_id,
          modelId: body.model_id,
          thinkingLevel: body.thinking_level ?? null,
        })),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法准备五分钟导读");
    }
    return;
  }

  const journalGuideMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/guide$/,
  );
  if (request.method === "GET" && journalGuideMatch) {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.getPaperGuide(
          journalGuideMatch[1],
          journalGuideMatch[2],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取五分钟导读");
    }
    return;
  }

  const journalDocumentMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/document$/,
  );
  if (request.method === "GET" && journalDocumentMatch) {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.getPaperDocument(
          journalDocumentMatch[1],
          journalDocumentMatch[2],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取论文正文");
    }
    return;
  }

  const journalDocumentRetryMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/document\/retry$/,
  );
  if (request.method === "POST" && journalDocumentRetryMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (
        body?.schema_version !== 1
        || !isJournalClientRequestId(body.client_request_id)
        || Object.keys(body).some(
          (key) => !["schema_version", "client_request_id"].includes(key),
        )
      ) {
        throw new CandidateSummaryError("INVALID_REQUEST", "逐篇重试请求无效", 400);
      }
      sendJson(
        response,
        202,
        publicRun(await journalWorkflowService.retryPaperDocument(
          journalDocumentRetryMatch[1],
          journalDocumentRetryMatch[2],
          { clientRequestId: body.client_request_id },
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法重试该篇候选全文");
    }
    return;
  }

  const journalTranslationMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/translation$/,
  );
  if (request.method === "GET" && journalTranslationMatch) {
    try {
      sendJson(
        response,
        200,
        await journalWorkflowService.getPaperTranslation(
          journalTranslationMatch[1],
          journalTranslationMatch[2],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取全文翻译");
    }
    return;
  }
  const journalTranslationPauseMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/translation\/pause$/,
  );
  if (request.method === "POST" && journalTranslationPauseMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "暂停全文翻译请求版本无效", 400);
      }
      sendJson(
        response,
        200,
        await journalWorkflowService.pausePaperTranslation(
          journalTranslationPauseMatch[1],
          journalTranslationPauseMatch[2],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法暂停全文翻译");
    }
    return;
  }
  if (request.method === "POST" && journalTranslationMatch) {
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "全文翻译请求版本无效", 400);
      }
      sendJson(
        response,
        202,
        await journalWorkflowService.generatePaperTranslation(
          journalTranslationMatch[1],
          journalTranslationMatch[2],
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法启动全文翻译");
    }
    return;
  }

  const journalPdfMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/pdf$/,
  );
  if (["GET", "HEAD"].includes(request.method) && journalPdfMatch) {
    try {
      await sendPdf(
        request,
        response,
        await journalWorkflowService.getPaperPdf(journalPdfMatch[1], journalPdfMatch[2]),
        origin,
      );
    } catch (error) {
      if (!response.headersSent) {
        sendWorkflowError(response, error, origin, "无法读取论文原版");
      } else {
        response.destroy();
      }
    }
    return;
  }

  const journalImageMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/images\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.(?:png|jpg|jpeg|gif|webp))$/i,
  );
  if (request.method === "GET" && journalImageMatch) {
    try {
      const image = await journalWorkflowService.getPaperImage(
        journalImageMatch[1],
        journalImageMatch[2],
        journalImageMatch[3],
      );
      const body = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes);
      response.writeHead(200, {
        "content-type": image.mimeType,
        "content-length": String(body.length),
        "cache-control": "private, max-age=3600",
        "x-content-type-options": "nosniff",
        ...corsHeaders(origin),
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法读取论文图片");
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/candidate-summaries") {
    const httpRequestId = randomUUID();
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const payload = await readJson(request);
      payload.project_context = candidateProjectContext(
        await journalWorkflowService.getProjectContext(),
      );
      const result = await candidateSummaryService.summarize(payload);
      sendJson(response, 200, result, origin);
    } catch (error) {
      const normalized = error instanceof CandidateSummaryError
        ? error
        : new CandidateSummaryError("INTERNAL_ERROR", "本地服务处理失败", 500, true);
      sendJson(response, normalized.status, {
        error: {
          request_id: normalized.requestId || httpRequestId,
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
        },
      }, origin);
    }
    return;
  }

  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在", retryable: false } }, origin);
  });
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const server = createApiServer();
  let shuttingDown = false;
  let notificationTimer = null;
  const monthlyScheduler = (
    !projectWorkRuntimeOnly
    && process.env.PI_JOURNAL_SCHEDULER_ENABLED !== "0"
  )
    ? createMonthlyJournalScheduler({
        workflowService: journalWorkflow,
        dataDir: piDataDir,
      })
    : null;
  server.listen(port, host, () => {
    console.log(`Pi Agent local API listening on http://${host}:${port} (${candidateSummaries.config.mode})`);
    if (projectWork && notificationService) {
      const processNotifications = () => notificationService.processDue()
        .catch((error) => {
          console.warn(`Pi Agent notification delivery paused: ${error.message}`);
        });
      void processNotifications();
      notificationTimer = setInterval(processNotifications, 3_000);
      notificationTimer.unref?.();
    }
    monthlyScheduler?.start().catch((error) => {
      console.warn(`Pi Agent monthly scheduler could not start: ${error.message}`);
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (notificationTimer) clearInterval(notificationTimer);
      monthlyScheduler?.dispose();
      void shutdownApiServer({
        server,
        dispose: () => projectWork?.dispose?.(),
      });
    });
  }
}
