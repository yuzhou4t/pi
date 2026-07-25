import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { CandidateSummaryError, createCandidateSummaryService } from "./candidateSummaries.js";
import { HttpRangeError, parseByteRange } from "./httpRange.js";
import { createJournalWorkflowService } from "./journal/workflowService.js";
import { SOURCE_REGISTRY, SOURCE_REGISTRY_VERSION } from "./journal/sourceRegistry.js";
import {
  ProjectWorkError,
  projectWorkError,
  safeProjectWorkError,
} from "./project-work/errors.js";
import { createProjectWorkService } from "./project-work/projectWorkService.js";

const host = "127.0.0.1";
const port = Number(process.env.PI_API_PORT ?? process.env.PORT ?? 8787);
const allowedOrigins = new Set([
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const candidateSummaries = createCandidateSummaryService();
const journalWorkflow = createJournalWorkflowService();
const projectWork = createProjectWorkService();

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
          status: paper?.chat?.status ?? "idle",
          turns: Array.isArray(paper?.chat?.turns)
            ? paper.chat.turns.map((turn) => ({
                id: turn?.id ?? null,
                client_request_id: turn?.client_request_id ?? null,
                question: turn?.question ?? "",
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
    approval: null,
    last_error: publicWorkflowError(obsidian.last_error),
    updated_at: obsidian.updated_at ?? null,
  };
}

function publicObsidianArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  return {
    schema_version: artifact.schema_version ?? 1,
    run_id: artifact.run_id ?? null,
    target_type: "obsidian",
    write_capability: "preview_only",
    external_write_performed: false,
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
    approval: null,
    last_error: publicWorkflowError(projectState.last_error),
    updated_at: projectState.updated_at ?? null,
  };
}

function publicProjectStateArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  return {
    schema_version: artifact.schema_version ?? 1,
    run_id: artifact.run_id ?? null,
    target_type: "project_state",
    write_capability: "preview_only",
    external_write_performed: false,
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
    candidates: Array.isArray(run.candidates) ? run.candidates.map(publicPaper) : [],
    guides,
    paper_decisions: run.paper_decisions && typeof run.paper_decisions === "object"
      ? { ...run.paper_decisions }
      : {},
    readings: publicReadingState(run.readings),
    obsidian: publicObsidianState(run.obsidian),
    project_state: publicProjectStateState(run.project_state),
    zotero: publicZoteroState(run.zotero),
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

function requireJsonRequest(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw projectWorkError(
      "PROJECT_WORK_UNSUPPORTED_MEDIA_TYPE",
      "请求必须使用 application/json",
      415,
    );
  }
}

async function readProjectWorkJson(request) {
  requireJsonRequest(request);
  try {
    return await readJson(request);
  } catch (error) {
    if (error instanceof CandidateSummaryError) {
      throw projectWorkError(error.code, error.message, error.status, error.retryable);
    }
    throw error;
  }
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
    id: conversation?.id ?? null,
    projectId: conversation?.projectId ?? null,
    workspaceKind: conversation?.workspaceKind ?? null,
    scope: conversation?.scope ?? null,
    rootLabel: conversation?.rootLabel ?? null,
    title: conversation?.title ?? "",
    status: conversation?.status ?? "idle",
    providerId: conversation?.providerId ?? null,
    modelId: conversation?.modelId ?? null,
    thinkingLevel: conversation?.thinkingLevel ?? "medium",
    pendingChangeFileCount: conversation?.pendingChangeFileCount ?? 0,
    lastEventSeq: conversation?.lastEventSeq ?? 0,
    createdAt: conversation?.createdAt ?? null,
    updatedAt: conversation?.updatedAt ?? null,
  };
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

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) {
      throw new CandidateSummaryError("REQUEST_TOO_LARGE", "请求正文不能超过 256 KB", 413);
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
} = {}) {
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
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    sendJson(response, 200, {
      status: "ok",
      mode: candidateSummaryService.config.mode,
      default_provider_id: candidateSummaryService.config.defaultProviderId,
      journal_workflow: "available",
      project_work: "available",
      mineru_configured: Boolean(process.env.PI_MINERU_API_TOKEN),
    }, origin);
    return;
  }

  if (url.pathname.startsWith("/api/v1/project-work")) {
    try {
      if (request.method === "GET" && url.pathname === "/api/v1/project-work/models") {
        sendJson(response, 200, await projectWorkService.listModels(), origin);
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
        const conversation = await projectWorkService.createStandaloneConversation({
          title: payload.title,
          providerId: payload.provider_id,
          modelId: payload.model_id,
          thinkingLevel: payload.thinking_level,
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
        const result = await projectWorkService.createConversation(projectId, {
          title: payload.title,
          providerId: payload.provider_id,
          modelId: payload.model_id,
          thinkingLevel: payload.thinking_level,
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
        });
        sendJson(response, 200, tree, origin);
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
        });
        sendJson(response, 200, tree, origin);
        return;
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
        sendJson(response, 200, result, origin);
        return;
      }

      const conversationActionMatch = url.pathname.match(
        /^\/api\/v1\/project-work\/conversations\/([^/]+)\/(messages|steer|abort|compact)$/,
      );
      if (conversationActionMatch && request.method === "POST") {
        requireProjectWorkMutationOrigin(origin);
        const conversationId = decodeProjectWorkSegment(conversationActionMatch[1]);
        const action = conversationActionMatch[2];
        const payload = await readProjectWorkJson(request);
        let result;
        if (action === "messages") {
          result = await projectWorkService.sendMessage(conversationId, {
            text: payload.text,
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
          });
        } else if (action === "steer") {
          result = await projectWorkService.steerConversation(conversationId, {
            text: payload.text,
          });
        } else if (action === "abort") {
          result = await projectWorkService.abortConversation(conversationId);
        } else {
          result = await projectWorkService.compactConversation(conversationId, {
            instructions: payload.instructions,
          });
        }
        sendJson(response, action === "messages" || action === "steer" ? 202 : 200, result, origin);
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
          await projectWorkService.getConversation(conversationId),
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
          await projectWorkService.getConversation(conversationId),
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
      const run = await journalWorkflowService.startRun({
        trigger: "manual",
        providerId: body?.provider_id,
        modelId: body?.model_id,
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

  const journalResumeMatch = url.pathname.match(/^\/api\/v1\/journal-runs\/([a-zA-Z0-9._-]+)\/resume$/);
  if (request.method === "POST" && journalResumeMatch) {
    const run = await journalWorkflowService.resumeRun(journalResumeMatch[1]);
    if (!run) {
      sendJson(response, 404, { error: { code: "RUN_NOT_FOUND", message: "运行不存在", retryable: false } }, origin);
      return;
    }
    sendJson(response, 202, publicRun(run), origin);
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
      if (body?.schema_version !== 1 || body?.from_step !== "guide") {
        throw new CandidateSummaryError("INVALID_REQUEST", "重新研读请求无效", 400);
      }
      sendJson(
        response,
        200,
        publicRun(await journalWorkflowService.restartReadingFromGuide(
          journalReadingRestartMatch[1],
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法从五分钟导读重新开始");
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
      if (body?.schema_version !== 1) {
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
      sendJson(
        response,
        201,
        await journalWorkflowService.createReadingConversation(
          journalReadingConversationsMatch[1],
          journalReadingConversationsMatch[2],
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

  const journalReadingChatMatch = url.pathname.match(
    /^\/api\/v1\/journal-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,159})\/papers\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\/reading\/chat\/messages$/,
  );
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
        "include_project_context",
        "provider_id",
        "model_id",
      ]);
      const allowedReferenceKeys = new Set([
        "document_revision",
        "block_id",
        "block_ids",
        "start_offset",
        "end_offset",
      ]);
      if (
        typeof body?.client_request_id !== "string"
        || !body.client_request_id.trim()
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
            clientRequestId: body.client_request_id ?? null,
            includeProjectContext: body.include_project_context === true,
            providerId: body.provider_id,
            modelId: body.model_id,
          },
        ),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法完成当前论文对话");
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
        || typeof body.client_request_id !== "string"
        || !body.client_request_id.trim()
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
        || typeof body.client_request_id !== "string"
        || !body.client_request_id.trim()
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
    try {
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        throw new CandidateSummaryError("UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json", 415);
      }
      const body = await readJson(request);
      if (body?.schema_version !== 1) {
        throw new CandidateSummaryError("INVALID_REQUEST", "Zotero 确认请求版本无效", 400);
      }
      sendJson(
        response,
        202,
        publicRun(await journalWorkflowService.startZoteroCommit(
          journalZoteroCommitMatch[1],
          {
            proposalHash: body.proposal_hash,
            operations: body.operations,
          },
        )),
        origin,
      );
    } catch (error) {
      sendWorkflowError(response, error, origin, "无法确认 Zotero 写入");
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
  server.listen(port, host, () => {
    console.log(`Pi Agent local API listening on http://${host}:${port} (${candidateSummaries.config.mode})`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      Promise.resolve(projectWork.dispose()).catch(() => undefined).finally(() => {
        server.close(() => process.exit(0));
      });
    });
  }
}
