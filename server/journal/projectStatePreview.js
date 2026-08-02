import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { READING_STAGE_ORDER } from "./readingGenerator.js";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_PROJECT_STATE_BYTES = 256 * 1024;
const MAX_READ_PAPERS = 2;
const MAX_IMPACT_CHARS = 3_500;
const MAX_OPEN_QUESTIONS = 6;
const MAX_OPEN_QUESTION_CHARS = 300;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_SUPPORT_CHARS = 300;
const MAX_APPEND_CHARS = 14_000;
const BLOCK_ID_PATTERN = /^block-[a-f0-9]{20}$/;

export class ProjectStatePreviewError extends Error {
  constructor(code, message, status = 409, retryable = false) {
    super(message);
    this.name = "ProjectStatePreviewError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function previewError(code, message, status = 409, retryable = false) {
  return new ProjectStatePreviewError(code, message, status, retryable);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  const source = typeof value === "string" || value instanceof Uint8Array
    ? value
    : JSON.stringify(canonicalize(value));
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function compactLine(value, maxLength = 500) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .slice(0, maxLength);
}

function boundedMarkdown(value, maxLength) {
  const normalized = String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}\n\n> 内容已按项目状态预览上限截断。`;
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function markdownInline(value, fallback = "未命名论文") {
  const normalized = compactLine(value, 300) || fallback;
  return normalized.replaceAll(/([\\[\]`])/g, "\\$1");
}

function runMarker(runId) {
  return `<!-- pi-agent:project-state-run:${runId} -->`;
}

function paperReference(paper) {
  const title = markdownInline(paper.title);
  const canonicalUrl = safeWebUrl(paper.canonical_url ?? paper.official_url);
  if (canonicalUrl) return `[${title}](${canonicalUrl})`;
  const doi = compactLine(paper.doi, 200);
  return doi ? `${title}（DOI: ${doi}）` : title;
}

function noteReference(run, paperId) {
  const proposal = run.obsidian?.proposals?.find((candidate) => (
    candidate?.target === "obsidian"
    && candidate.paper_id === paperId
  ));
  const fileName = compactLine(
    proposal?.target_details?.file_name
      ?? (proposal?.target_locator ? path.basename(proposal.target_locator) : ""),
    240,
  );
  if (
    !fileName
    || path.basename(fileName) !== fileName
    || path.extname(fileName).toLowerCase() !== ".md"
  ) {
    throw previewError(
      "PROJECT_STATE_OBSIDIAN_REFERENCE_MISSING",
      "精读论文尚未形成可引用的 Obsidian 笔记预览",
    );
  }
  return {
    file_name: fileName,
    wikilink: `[[${fileName.slice(0, -3)}]]`,
  };
}

function assertCompleteReading(run, paperId, reading) {
  const summary = run.readings?.papers?.[paperId];
  if (
    summary?.status !== "complete"
    || !reading
    || typeof reading !== "object"
    || Array.isArray(reading)
    || reading.run_id !== run.run_id
    || reading.paper_id !== paperId
    || reading.status !== "complete"
    || JSON.stringify(reading.stage_order) !== JSON.stringify(READING_STAGE_ORDER)
    || !reading.stages
    || typeof reading.stages !== "object"
    || Array.isArray(reading.stages)
  ) {
    throw previewError(
      "PROJECT_STATE_READING_NOT_READY",
      "至少需要一篇归档证据齐全的论文才能生成项目状态预览",
    );
  }
  for (const stageId of READING_STAGE_ORDER) {
    const stage = reading.stages[stageId];
    if (
      !stage
      || typeof stage !== "object"
      || Array.isArray(stage)
      || stage.status !== "ready"
      || !HASH_PATTERN.test(stage.content_hash)
    ) {
      throw previewError(
        "PROJECT_STATE_READING_NOT_READY",
        "至少需要一篇归档证据齐全的论文才能生成项目状态预览",
      );
    }
  }
  const relation = reading.stages["project-relation"]?.result;
  const projectContextRevision = reading.stages["project-relation"]?.provenance
    ?.project_context_revision;
  if (
    !relation
    || typeof relation !== "object"
    || Array.isArray(relation)
    || !boundedMarkdown(relation.answer, MAX_IMPACT_CHARS)
    || !Array.isArray(relation.evidence)
    || relation.evidence.length < 1
    || !Array.isArray(relation.open_questions)
    || !HASH_PATTERN.test(projectContextRevision)
  ) {
    throw previewError(
      "PROJECT_STATE_RELATION_INVALID",
      "项目关系阶段缺少可复用的项目影响或开放问题",
    );
  }
  const evidence = relation.evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || !BLOCK_ID_PATTERN.test(item.block_id)
      || !Array.isArray(item.path)
      || !Number.isInteger(item.ordinal)
      || item.ordinal < 1
      || !compactLine(item.support, MAX_EVIDENCE_SUPPORT_CHARS)
    ) {
      throw previewError(
        "PROJECT_STATE_RELATION_INVALID",
        "项目关系阶段缺少可核验的论文证据",
      );
    }
    return {
      block_id: item.block_id,
      path: item.path.map((part) => compactLine(part, 120)).filter(Boolean),
      ordinal: item.ordinal,
      support: compactLine(item.support, MAX_EVIDENCE_SUPPORT_CHARS),
    };
  });
  return {
    ...relation,
    evidence,
    project_context_revision: projectContextRevision,
  };
}

function proposalMarkdown(run, papers) {
  const lines = [
    runMarker(run.run_id),
    `## Pi Agent 阶段更新 · ${run.run_id}`,
    "",
    "> 以下内容来自本轮已完成的“与项目的关系”精读结果，仍需用户确认后才能写入项目状态。",
    "",
    "### 项目影响",
    "",
  ];

  for (const item of papers) {
    lines.push(
      `#### ${markdownInline(item.paper.title)}`,
      "",
      boundedMarkdown(item.relation.answer, MAX_IMPACT_CHARS),
      "",
      `- 论文：${paperReference(item.paper)}`,
      `- Run：\`${run.run_id}\``,
      `- Obsidian 笔记：${item.note.wikilink}`,
      "- 论文证据：",
      ...item.relation.evidence.map((evidence) => (
        `  - \`${evidence.block_id}\` · ${evidence.path.join(" › ") || `第 ${evidence.ordinal} 段`}：${evidence.support}`
      )),
      "",
    );
  }

  lines.push("### 开放问题", "");
  const questions = papers.flatMap((item) => (
    item.relation.open_questions
      .slice(0, MAX_OPEN_QUESTIONS)
      .map((question) => ({
        paperTitle: markdownInline(item.paper.title),
        text: compactLine(question, MAX_OPEN_QUESTION_CHARS),
      }))
      .filter((question) => question.text)
  ));
  if (questions.length === 0) {
    lines.push("- 暂无", "");
  } else {
    for (const question of questions) {
      lines.push(`- [ ] ${question.text}（来源：${question.paperTitle}）`);
    }
    lines.push("");
  }

  const markdown = `${lines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trim()}\n`;
  if (markdown.length > MAX_APPEND_CHARS) {
    throw previewError(
      "PROJECT_STATE_PREVIEW_TOO_LARGE",
      "项目状态预览超过固定输出上限",
    );
  }
  return markdown;
}

function exactAppend(current, markdown) {
  const separator = current.length === 0 || current.endsWith("\n\n")
    ? ""
    : current.endsWith("\n")
      ? "\n"
      : "\n\n";
  const appendText = `${separator}${markdown}`;
  const after = `${current}${appendText}`;
  return {
    mode: "append",
    append_offset_chars: current.length,
    append_offset_bytes: Buffer.byteLength(current, "utf8"),
    append_text: appendText,
    before_hash: sha256(current),
    after_hash: sha256(after),
    before_byte_length: Buffer.byteLength(current, "utf8"),
    after_byte_length: Buffer.byteLength(after, "utf8"),
  };
}

function relevantRunHash(run, paperIds) {
  return sha256({
    decisions: run.paper_decisions ?? null,
    papers: paperIds.map((paperId) => ({
      candidate: (() => {
        const paper = run.candidates?.find((item) => item.paper_id === paperId);
        return paper ? {
          paper_id: paper.paper_id,
          title: paper.title,
          doi: paper.doi ?? null,
          canonical_url: paper.canonical_url ?? paper.official_url ?? null,
        } : null;
      })(),
      reading: (() => {
        const reading = run.readings?.papers?.[paperId];
        return reading ? {
          status: reading.status,
          document_revision: reading.document_revision ?? null,
          stages: Object.fromEntries(READING_STAGE_ORDER.map((stageId) => [
            stageId,
            {
              status: reading.stages?.[stageId]?.status ?? null,
              content_hash: reading.stages?.[stageId]?.content_hash ?? null,
            },
          ])),
        } : null;
      })(),
      obsidian: (() => {
        const proposal = run.obsidian?.proposals?.find((item) => (
          item?.target === "obsidian"
          && item.paper_id === paperId
        ));
        return proposal ? {
          proposal_id: proposal.proposal_id ?? null,
          target_locator: proposal.target_locator ?? null,
          target_hash: proposal.target_hash ?? null,
          content_hash: proposal.content_hash ?? null,
        } : null;
      })(),
    })),
  });
}

function proposalCore(proposal) {
  return {
    proposal_id: proposal.proposal_id,
    run_id: proposal.run_id,
    target: proposal.target,
    operation: proposal.operation,
    write_mode: proposal.write_mode,
    target_locator: proposal.target_locator,
    content_hash: proposal.content_hash,
    target_hash: proposal.target_hash,
    actionable: proposal.actionable,
    selected: proposal.selected,
    status: proposal.status,
  };
}

function proposalIntegrityCore(proposal) {
  return {
    ...proposalCore(proposal),
    target_details: proposal.target_details,
    target_version_or_hash: proposal.target_version_or_hash,
    marker: proposal.marker,
    markdown: proposal.markdown,
    diff: proposal.diff,
    paper_references: proposal.paper_references,
  };
}

function assertProposalIntegrity(proposal) {
  const expectedId = `project-state-preview-${sha256({
    run_id: proposal.run_id,
    target_locator: proposal.target_locator,
    content_hash: proposal.content_hash,
    target_hash: proposal.target_hash,
  }).slice(7, 23)}`;
  const basicValid = (
    proposal.proposal_id === expectedId
    && proposal.content_hash === sha256(proposal.markdown)
    && proposal.target_hash === proposal.target_version_or_hash
    && typeof proposal.marker === "string"
    && proposal.markdown.includes(proposal.marker)
  );
  const diffValid = proposal.write_mode === "append_after_approval"
    ? (
        proposal.diff?.mode === "append"
        && proposal.diff.before_hash
          === proposal.target_details?.current_content_hash
        && proposal.diff.append_text?.endsWith(proposal.markdown)
      )
    : proposal.write_mode === "blocked_existing_run"
      && proposal.diff?.mode === "blocked_existing_run_marker"
      && proposal.diff.before_hash
        === proposal.target_details?.current_content_hash
      && proposal.diff.after_hash
        === proposal.target_details?.current_content_hash
      && proposal.diff.append_text === null;
  if (!basicValid || !diffValid) {
    throw previewError(
      "PROJECT_STATE_PREVIEW_CORRUPT",
      "项目状态精确预览缺失或损坏，请重新生成",
      409,
      true,
    );
  }
}

function safeCommitError(error) {
  return {
    code: compactLine(error?.code, 120) || "PROJECT_STATE_WRITE_FAILED",
    message: compactLine(error?.message, 500) || "项目状态写入失败",
    retryable: error?.retryable !== false,
  };
}

export function createProjectStatePreviewService({
  runStore,
  getPaperReading,
  projectRoot = path.resolve("."),
  projectStatePath = "project_state.md",
  now = () => new Date(),
} = {}) {
  if (!runStore || typeof getPaperReading !== "function") {
    throw new Error("Project state preview service dependencies are required");
  }
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    throw new Error("projectRoot is required");
  }
  if (typeof projectStatePath !== "string" || !projectStatePath.trim()) {
    throw new Error("projectStatePath is required");
  }
  const configuredRoot = path.resolve(projectRoot);
  const configuredTarget = path.resolve(configuredRoot, projectStatePath);
  let commitQueue = Promise.resolve();

  function withCommitLock(operation) {
    const current = commitQueue.catch(() => undefined).then(operation);
    commitQueue = current;
    return current;
  }

  async function readTarget() {
    const configuredRelative = path.relative(configuredRoot, configuredTarget);
    if (
      !configuredRelative
      || configuredRelative.startsWith("..")
      || path.isAbsolute(configuredRelative)
      || path.extname(configuredTarget).toLowerCase() !== ".md"
    ) {
      throw previewError(
        "PROJECT_STATE_TARGET_OUT_OF_SCOPE",
        "项目状态目标必须是项目目录内的普通 Markdown 文件",
      );
    }
    let rootStat;
    let targetStat;
    let root;
    let target;
    try {
      [rootStat, targetStat, root, target] = await Promise.all([
        lstat(configuredRoot),
        lstat(configuredTarget),
        realpath(configuredRoot),
        realpath(configuredTarget),
      ]);
    } catch {
      throw previewError(
        "PROJECT_STATE_TARGET_NOT_FOUND",
        "配置的项目状态 Markdown 不存在",
      );
    }
    const relative = path.relative(root, target);
    if (
      !rootStat.isDirectory()
      || targetStat.isSymbolicLink()
      || !targetStat.isFile()
      || !relative
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || path.extname(target).toLowerCase() !== ".md"
      || targetStat.size > MAX_PROJECT_STATE_BYTES
    ) {
      throw previewError(
        "PROJECT_STATE_TARGET_OUT_OF_SCOPE",
        "项目状态目标必须是项目目录内的普通 Markdown 文件",
      );
    }
    const content = await readFile(target, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_PROJECT_STATE_BYTES) {
      throw previewError(
        "PROJECT_STATE_TARGET_OUT_OF_SCOPE",
        "项目状态目标必须是项目目录内的普通 Markdown 文件",
      );
    }
    const sourcePath = relative.split(path.sep).join("/");
    const contentHash = sha256(content);
    return {
      root,
      target,
      source_path: sourcePath,
      content,
      content_hash: contentHash,
      byte_length: Buffer.byteLength(content, "utf8"),
      mode: targetStat.mode & 0o777,
      target_hash: sha256({
        source_path: sourcePath,
        content_hash: contentHash,
        byte_length: Buffer.byteLength(content, "utf8"),
        mode: targetStat.mode & 0o777,
      }),
    };
  }

  async function createPreview(runId) {
    const run = await runStore.getRun(runId);
    if (!run) throw previewError("RUN_NOT_FOUND", "运行不存在", 404);
    if (run.status !== "draft_ready") {
      throw previewError(
        "PROJECT_STATE_PREVIEW_NOT_ALLOWED",
        "只有归档所需证据齐全后才能生成项目状态预览",
      );
    }
    const decisions = run.paper_decisions;
    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
      throw previewError("PROJECT_STATE_DECISIONS_INVALID", "论文决定缺失或无效");
    }
    if (Object.values(decisions).some((decision) => !["collect", "read"].includes(decision))) {
      throw previewError("PROJECT_STATE_DECISIONS_INVALID", "论文决定包含未知值");
    }
    const paperIds = Object.entries(decisions)
      .filter(([, decision]) => decision === "read")
      .map(([paperId]) => paperId)
      .sort();
    if (paperIds.length === 0) {
      throw previewError(
        "PROJECT_STATE_NOT_REQUIRED",
        "本轮没有完成精读的论文，不需要生成项目状态预览",
      );
    }
    if (paperIds.length > MAX_READ_PAPERS) {
      throw previewError(
        "PROJECT_STATE_DECISIONS_INVALID",
        "项目状态预览最多接收两篇精读论文",
      );
    }

    const sourceHash = relevantRunHash(run, paperIds);
    const papers = [];
    for (const paperId of paperIds) {
      const paper = run.candidates?.find((candidate) => candidate.paper_id === paperId);
      if (!paper) {
        throw previewError(
          "PROJECT_STATE_PAPER_NOT_FOUND",
          "精读论文已不在本轮候选中",
        );
      }
      const reading = await getPaperReading(runId, paperId);
      papers.push({
        paper,
        relation: assertCompleteReading(run, paperId, reading),
        note: noteReference(run, paperId),
      });
    }

    const target = await readTarget();
    if (papers.some((item) => (
      item.relation.project_context_revision !== target.content_hash
    ))) {
      throw previewError(
        "PROJECT_STATE_CONTEXT_STALE",
        "项目状态文件已在精读后变化，请重新生成“与项目的关系”阶段",
      );
    }
    const markdown = proposalMarkdown(run, papers);
    const contentHash = sha256(markdown);
    const marker = runMarker(runId);
    const alreadyPresent = target.content.includes(marker);
    const appendDiff = exactAppend(target.content, markdown);
    const diff = alreadyPresent
      ? {
          mode: "blocked_existing_run_marker",
          marker,
          append_offset_chars: target.content.length,
          append_offset_bytes: target.byte_length,
          append_text: null,
          before_hash: target.content_hash,
          after_hash: target.content_hash,
          before_byte_length: target.byte_length,
          after_byte_length: target.byte_length,
        }
      : appendDiff;
    const proposalSeed = {
      run_id: runId,
      target_locator: target.target,
      content_hash: contentHash,
      target_hash: target.target_hash,
    };
    const proposalId = `project-state-preview-${sha256(proposalSeed).slice(7, 23)}`;
    const proposal = {
      proposal_id: proposalId,
      run_id: runId,
      target: "project_state",
      operation: "append",
      write_mode: alreadyPresent ? "blocked_existing_run" : "append_after_approval",
      target_locator: target.target,
      target_details: {
        project_root: target.root,
        source_path: target.source_path,
        byte_length: target.byte_length,
        current_content_hash: target.content_hash,
      },
      content_hash: contentHash,
      target_hash: target.target_hash,
      target_version_or_hash: target.target_hash,
      marker,
      markdown,
      actionable: !alreadyPresent,
      selected: !alreadyPresent,
      status: alreadyPresent ? "blocked" : "draft",
      preview_or_diff: alreadyPresent
        ? [
            `本 Run 标记已存在：${marker}`,
            "不会再次追加同一 Run 的项目状态更新。",
          ]
        : [
            `追加到：${target.target}`,
            "精确追加内容见 diff.append_text；尚未写入目标文件。",
          ],
      diff,
      paper_references: papers.map((item) => ({
        paper_id: item.paper.paper_id,
        title: compactLine(item.paper.title, 300),
        obsidian_note: item.note.file_name,
      })),
    };
    const proposalHash = sha256(proposalIntegrityCore(proposal));
    const generatedAt = now().toISOString();
    const status = alreadyPresent ? "blocked" : "preview_ready";
    const markdownArtifactPath = [
      "project-state/previews",
      `${proposalId}-${contentHash.slice(7, 15)}.md`,
    ].join("/");
    await runStore.writeArtifact(runId, markdownArtifactPath, markdown);
    const artifact = {
      schema_version: 1,
      run_id: runId,
      target_type: "project_state",
      write_capability: "hash_bound_commit",
      external_write_performed: false,
      status,
      source_hash: sourceHash,
      proposal_hash: proposalHash,
      proposal: {
        ...proposal,
        markdown_artifact_path: markdownArtifactPath,
      },
      generated_at: generatedAt,
    };
    const artifactPath = `project-state/previews/${proposalHash.slice(7)}.json`;
    await runStore.writeArtifact(runId, artifactPath, artifact);

    const updated = await runStore.updateRun(runId, (current) => {
      if (
        current.status !== "draft_ready"
        || relevantRunHash(current, paperIds) !== sourceHash
      ) {
        throw previewError(
          "PROJECT_STATE_PREVIEW_STALE",
          "精读结果、论文决定或 Obsidian 引用已变化，请重新生成项目状态预览",
        );
      }
      return {
        project_state: {
          schema_version: 1,
          status,
          proposal_id: proposalId,
          proposal_hash: proposalHash,
          artifact_path: artifactPath,
          markdown_artifact_path: markdownArtifactPath,
          target_locator: target.target,
          target_hash: target.target_hash,
          content_hash: contentHash,
          actionable: !alreadyPresent,
          approval: null,
          last_error: null,
          updated_at: generatedAt,
        },
      };
    });

    return {
      ...artifact,
      artifact_path: artifactPath,
      run_status: updated.status,
    };
  }

  async function getPreview(runId) {
    const run = await runStore.getRun(runId);
    if (!run) throw previewError("RUN_NOT_FOUND", "运行不存在", 404);
    const artifactPath = run.project_state?.artifact_path;
    const proposalHash = run.project_state?.proposal_hash;
    if (!artifactPath || !proposalHash) {
      throw previewError(
        "PROJECT_STATE_PREVIEW_NOT_FOUND",
        "当前运行还没有项目状态精确预览",
        404,
      );
    }
    const artifact = await runStore.readArtifact(runId, artifactPath);
    let artifactIntegrityValid = false;
    try {
      assertProposalIntegrity(artifact?.proposal);
      artifactIntegrityValid = (
        sha256(proposalIntegrityCore(artifact.proposal)) === proposalHash
      );
    } catch {
      artifactIntegrityValid = false;
    }
    if (
      !artifact
      || artifact.run_id !== runId
      || artifact.proposal_hash !== proposalHash
      || artifact.source_hash !== relevantRunHash(
        run,
        (artifact.proposal?.paper_references ?? [])
          .map((reference) => reference.paper_id)
          .filter(Boolean)
          .sort(),
      )
      || !artifactIntegrityValid
    ) {
      throw previewError(
        "PROJECT_STATE_PREVIEW_STALE",
        "项目状态精确预览与当前运行状态不一致，请重新生成",
      );
    }
    return artifact;
  }

  async function validateCommit(runId, {
    proposalHash,
    operation,
  } = {}) {
    const artifact = await getPreview(runId);
    const proposal = artifact.proposal;
    if (
      artifact.proposal_hash !== proposalHash
      || !operation
      || operation.proposal_id !== proposal.proposal_id
      || operation.content_hash !== proposal.content_hash
      || operation.target_version_or_hash !== proposal.target_version_or_hash
      || proposal.actionable !== true
      || proposal.write_mode !== "append_after_approval"
    ) {
      throw previewError(
        "PROJECT_STATE_APPROVAL_INVALID",
        "项目状态确认内容与当前预览不一致",
        409,
        true,
      );
    }
    const target = await readTarget();
    const alreadyCommitted = (
      target.content_hash === proposal.diff.after_hash
      && target.content.includes(proposal.marker)
    );
    if (!alreadyCommitted && target.target_hash !== proposal.target_version_or_hash) {
      throw previewError(
        "PROJECT_STATE_PREVIEW_STALE",
        "项目状态文件在预览后发生变化，请重新生成预览",
        409,
        true,
      );
    }
    const beforeContent = alreadyCommitted
      ? target.content.slice(0, -proposal.diff.append_text.length)
      : target.content;
    const expectedDiff = exactAppend(beforeContent, proposal.markdown);
    if (sha256(expectedDiff) !== sha256(proposal.diff)) {
      throw previewError(
        "PROJECT_STATE_PREVIEW_CORRUPT",
        "项目状态精确预览的追加内容校验失败，请重新生成",
        409,
        true,
      );
    }
    return { artifact, proposal, target, alreadyCommitted };
  }

  async function commit(runId, {
    clientRequestId,
    proposalHash,
    operation,
  } = {}) {
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw previewError(
        "PROJECT_STATE_APPROVAL_REQUEST_INVALID",
        "项目状态确认请求标识无效",
        400,
      );
    }
    return withCommitLock(async () => {
      const {
        artifact,
        proposal,
        target,
        alreadyCommitted,
      } = await validateCommit(runId, { proposalHash, operation });
      const approvedAt = now().toISOString();
      const approval = {
        schema_version: 1,
        run_id: runId,
        client_request_id: clientRequestId.trim(),
        proposal_hash: proposalHash,
        operation: {
          proposal_id: proposal.proposal_id,
          content_hash: proposal.content_hash,
          target_version_or_hash: proposal.target_version_or_hash,
        },
        approved_at: approvedAt,
      };
      approval.approval_hash = sha256(approval);
      const approvalPath =
        `project-state/approvals/${approval.approval_hash.slice(7)}.json`;
      await runStore.writeArtifact(runId, approvalPath, approval);
      await runStore.updateRun(runId, (current) => ({
        project_state: {
          ...current.project_state,
          status: "committing",
          approval: {
            ...approval,
            artifact_path: approvalPath,
          },
          last_error: null,
          updated_at: approvedAt,
        },
      }));
      const ledgerPath = `writes/project-state/${proposal.proposal_id}.json`;
      const startedAt = now().toISOString();
      try {
        await runStore.writeArtifact(runId, ledgerPath, {
          schema_version: 1,
          run_id: runId,
          proposal_id: proposal.proposal_id,
          approval_hash: approval.approval_hash,
          status: "committing",
          started_at: startedAt,
        });
        if (!alreadyCommitted) {
          const temporaryPath = `${target.target}.${randomUUID()}.tmp`;
          const afterContent = `${target.content}${proposal.diff.append_text}`;
          await writeFile(temporaryPath, afterContent, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          try {
            const immediatelyBeforeWrite = await readTarget();
            if (
              immediatelyBeforeWrite.target_hash
              !== proposal.target_version_or_hash
            ) {
              throw previewError(
                "PROJECT_STATE_PREVIEW_STALE",
                "项目状态文件在确认前发生变化，未执行写入",
                409,
                true,
              );
            }
            await chmod(temporaryPath, immediatelyBeforeWrite.mode);
            await rename(temporaryPath, target.target);
          } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw error;
          }
        }
        const verified = await readTarget();
        if (
          verified.content_hash !== proposal.diff.after_hash
          || !verified.content.includes(proposal.marker)
        ) {
          throw previewError(
            "PROJECT_STATE_WRITE_VERIFICATION_FAILED",
            "项目状态写入后的读回核验失败",
            500,
            true,
          );
        }
        const completedAt = now().toISOString();
        await runStore.writeArtifact(runId, ledgerPath, {
          schema_version: 1,
          run_id: runId,
          proposal_id: proposal.proposal_id,
          approval_hash: approval.approval_hash,
          status: "committed",
          started_at: startedAt,
          completed_at: completedAt,
          verified: true,
          after_hash: verified.content_hash,
        });
        const updated = await runStore.updateRun(runId, (current) => ({
          project_state: {
            ...current.project_state,
            status: "completed",
            committed_at: completedAt,
            verified_at: completedAt,
            last_error: null,
            updated_at: completedAt,
          },
        }));
        await runStore.appendEvent(runId, {
          type: "project_state_commit_completed",
          proposal_id: proposal.proposal_id,
          proposal_hash: artifact.proposal_hash,
          at: completedAt,
        });
        return updated;
      } catch (error) {
        const failedAt = now().toISOString();
        const lastError = safeCommitError(error);
        await runStore.writeArtifact(runId, ledgerPath, {
          schema_version: 1,
          run_id: runId,
          proposal_id: proposal.proposal_id,
          approval_hash: approval.approval_hash,
          status: "failed",
          started_at: startedAt,
          completed_at: failedAt,
          verified: false,
          error: lastError,
        }).catch(() => undefined);
        await runStore.updateRun(runId, (current) => ({
          project_state: {
            ...current.project_state,
            status: "failed",
            last_error: lastError,
            updated_at: failedAt,
          },
        }));
        throw error;
      }
    });
  }

  return Object.freeze({
    commit,
    createPreview,
    getPreview,
    validateCommit,
  });
}

export const __test = {
  exactAppend,
  proposalMarkdown,
  relevantRunHash,
  runMarker,
  sha256,
};
