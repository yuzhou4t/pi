import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { READING_STAGE_ORDER } from "./readingGenerator.js";
import {
  noteFileName,
  parseManagedNote,
  renderManagedNote,
} from "./obsidianNoteFormat.js";

const BLOCK_ID_PATTERN = /^block-[a-f0-9]{20}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PAPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const STAGE_LABELS = Object.freeze({
  "research-question": "研究问题",
  method: "方法与机制",
  evidence: "实验证据",
  "project-relation": "与项目的关系",
});

export class ObsidianPreviewError extends Error {
  constructor(code, message, status = 409, retryable = false) {
    super(message);
    this.name = "ObsidianPreviewError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function previewError(code, message, status = 409, retryable = false) {
  return new ObsidianPreviewError(code, message, status, retryable);
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

function compactLine(value, fallback = "") {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ");
  return normalized || fallback;
}

function markdownText(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function assertPaperId(paperId) {
  if (!PAPER_ID_PATTERN.test(paperId)) {
    throw previewError("OBSIDIAN_READING_INVALID", "精读论文标识无效");
  }
}

function assertCitation(citation) {
  const excerpt = citation?.excerpt ?? citation?.quote;
  if (
    !citation
    || typeof citation !== "object"
    || Array.isArray(citation)
    || !BLOCK_ID_PATTERN.test(citation.block_id)
    || !Array.isArray(citation.path)
    || citation.path.some((part) => !compactLine(part))
    || !Number.isInteger(citation.ordinal)
    || citation.ordinal < 1
    || !compactLine(excerpt)
    || !compactLine(citation.support)
  ) {
    throw previewError(
      "OBSIDIAN_READING_INVALID",
      "精读引用缺少可核验的段落锚点或原文信息",
    );
  }
}

function canonicalPinnedConclusions(reading) {
  const canonicalConversationId = reading.canonical_conversation_id
    ?? reading.active_conversation_id
    ?? reading.chat?.id
    ?? "current";
  const conclusions = Array.isArray(reading.pinned_conclusions)
    ? reading.pinned_conclusions.filter((conclusion) => (
        conclusion?.status === "pinned"
        && conclusion.source_conversation_id === canonicalConversationId
      ))
    : [];
  conclusions.forEach((conclusion) => {
    if (
      !compactLine(conclusion.conclusion_id)
      || !compactLine(conclusion.source_turn_id)
      || !markdownText(conclusion.content)
      || !HASH_PATTERN.test(conclusion.content_hash)
      || conclusion.content_hash !== sha256(conclusion.content)
      || !compactLine(conclusion.confirmed_by)
      || !Array.isArray(conclusion.citations)
      || conclusion.citations.length < 1
      || (
        conclusion.coverage_stages != null
        && (
          !Array.isArray(conclusion.coverage_stages)
          || conclusion.coverage_stages.some(
            (stage) => !READING_STAGE_ORDER.includes(stage),
          )
        )
      )
    ) {
      throw previewError(
        "OBSIDIAN_READING_INVALID",
        "已确认结论缺少来源、内容哈希、确认人或可核验引用",
      );
    }
    conclusion.citations.forEach(assertCitation);
  });
  return conclusions;
}

function assertStage(stageId, stage) {
  if (
    !stage
    || typeof stage !== "object"
    || Array.isArray(stage)
    || stage.status !== "ready"
    || !HASH_PATTERN.test(stage.content_hash)
    || !stage.result
    || typeof stage.result !== "object"
    || Array.isArray(stage.result)
    || !markdownText(stage.result.answer)
    || !Array.isArray(stage.result.evidence)
    || stage.result.evidence.length < 1
    || !Array.isArray(stage.result.open_questions)
  ) {
    throw previewError(
      "OBSIDIAN_READING_NOT_READY",
      `${STAGE_LABELS[stageId]}阶段尚未形成可归档结果`,
    );
  }
  stage.result.evidence.forEach(assertCitation);
}

function assertQuestion(question) {
  if (
    !question
    || typeof question !== "object"
    || Array.isArray(question)
    || !compactLine(question.id)
    || !READING_STAGE_ORDER.includes(question.stage)
    || !markdownText(question.text)
    || !["answered", "failed"].includes(question.status)
    || (
      question.block_id != null
      && !BLOCK_ID_PATTERN.test(question.block_id)
    )
  ) {
    throw previewError(
      question?.status === "running"
        ? "OBSIDIAN_READING_NOT_READY"
        : "OBSIDIAN_READING_INVALID",
      "精读追问尚未完成或结构无效",
    );
  }
  if (question.status === "answered") {
    if (
      !markdownText(question.answer)
      || !Array.isArray(question.evidence)
      || question.evidence.length < 1
      || !Array.isArray(question.open_questions)
    ) {
      throw previewError("OBSIDIAN_READING_INVALID", "精读追问缺少回答或引用");
    }
    question.evidence.forEach(assertCitation);
  }
}

function assertReading(run, paperId, reading) {
  const summary = run.readings?.papers?.[paperId];
  if (
    summary?.status !== "complete"
    || !reading
    || typeof reading !== "object"
    || Array.isArray(reading)
    || reading.run_id !== run.run_id
    || reading.paper_id !== paperId
    || reading.status !== "complete"
    || !compactLine(reading.document_revision)
    || (
      summary.document_revision
      && summary.document_revision !== reading.document_revision
    )
    || JSON.stringify(reading.stage_order) !== JSON.stringify(READING_STAGE_ORDER)
    || !reading.stages
    || typeof reading.stages !== "object"
    || Array.isArray(reading.stages)
    || !Array.isArray(reading.questions)
  ) {
    throw previewError(
      "OBSIDIAN_READING_NOT_READY",
      "归档所需的阅读证据尚未齐全，不能生成 Obsidian 写入预览",
    );
  }
  for (const stageId of READING_STAGE_ORDER) {
    assertStage(stageId, reading.stages[stageId]);
  }
  reading.questions.forEach(assertQuestion);
}

function citationMarkdown(citations, headingLevel = 3) {
  const heading = "#".repeat(headingLevel);
  return [
    `${heading} 引用`,
    "",
    ...citations.flatMap((citation, index) => [
      `${index + 1}. \`${citation.block_id}\``,
      `   - 位置：${citation.path.length > 0 ? citation.path.map(compactLine).join(" › ") : "未提供章节路径"}`,
      `   - 段落序号：${citation.ordinal}`,
      `   - 原文摘录：${compactLine(citation.excerpt ?? citation.quote)}`,
      `   - 支持关系：${compactLine(citation.support)}`,
    ]),
  ];
}

function openQuestionsMarkdown(openQuestions, headingLevel = 3) {
  const heading = "#".repeat(headingLevel);
  return [
    "",
    `${heading} 尚待核验`,
    "",
    ...(openQuestions.length > 0
      ? openQuestions.map((question) => `- ${compactLine(question)}`)
      : ["- 暂无"]),
  ];
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function workflowMarkdown(run, paper, reading) {
  const authors = (paper.authors ?? []).map((author) => compactLine(author)).filter(Boolean);
  const sourceUrl = safeWebUrl(
    paper.canonical_url
      ?? paper.official_url
      ?? reading.paper?.canonical_url,
  );
  const lines = [
    `# ${compactLine(paper.title, "未命名论文")}`,
    "",
    "## 论文信息",
    "",
    `- 作者：${authors.length > 0 ? authors.join("；") : "未提供"}`,
    `- 发表信息：${[compactLine(paper.venue), compactLine(paper.published_at)].filter(Boolean).join(" · ") || "未提供"}`,
    `- DOI：${compactLine(paper.doi, "未提供")}`,
    `- 原文：${sourceUrl ? `[打开原文](${sourceUrl})` : "未提供"}`,
    `- Pi Agent Run：\`${run.run_id}\``,
    `- Paper ID：\`${paper.paper_id}\``,
    `- 正文版本：\`${reading.document_revision}\``,
    "",
  ];

  const pinnedConclusions = canonicalPinnedConclusions(reading);
  const pinnedCoverage = new Set(
    pinnedConclusions.flatMap((conclusion) => conclusion.coverage_stages ?? []),
  );
  if (pinnedConclusions.length > 0) {
    lines.push(
      "## 已确认结论",
      "",
      "> 以下结论由用户在正式研读会话中固定；它们优先进入归档，固定操作本身不构成任何外部写入批准。",
      "",
    );
    pinnedConclusions.forEach((conclusion, index) => {
      lines.push(
        `### 结论 ${index + 1}`,
        "",
        markdownText(conclusion.content),
        "",
        `- 确认人：${compactLine(conclusion.confirmed_by)}`,
        `- 来源会话：\`${compactLine(conclusion.source_conversation_id)}\``,
        `- 来源 Turn：\`${compactLine(conclusion.source_turn_id)}\``,
        "",
        ...citationMarkdown(conclusion.citations, 4),
        "",
      );
    });
    lines.push(
      "## 四镜头覆盖补充",
      "",
      "> 以下阶段结果只用于补足已确认结论尚未覆盖的归档镜头。",
      "",
    );
  }

  READING_STAGE_ORDER.forEach((stageId, index) => {
    if (pinnedCoverage.has(stageId)) return;
    const stage = reading.stages[stageId];
    const heading = pinnedConclusions.length > 0 ? "###" : "##";
    const detailHeadingLevel = pinnedConclusions.length > 0 ? 4 : 3;
    lines.push(
      `${heading} ${index + 1}. ${STAGE_LABELS[stageId]}`,
      "",
      ...(stageId === "project-relation"
        ? ["> 本节是待用户确认的项目关系判断，不会自动写入项目状态。", ""]
        : []),
      markdownText(stage.result.answer),
      "",
      ...citationMarkdown(stage.result.evidence, detailHeadingLevel),
      ...openQuestionsMarkdown(stage.result.open_questions, detailHeadingLevel),
      "",
    );
  });

  lines.push("## 精读追问", "");
  if (reading.questions.length === 0) {
    lines.push("- 暂无", "");
  } else {
    reading.questions.forEach((question, index) => {
      lines.push(
        `### 追问 ${index + 1}`,
        "",
        `- 所属阶段：${STAGE_LABELS[question.stage]}`,
        `- 段落锚点：${question.block_id ? `\`${question.block_id}\`` : "未绑定单一段落"}`,
        `- 状态：${question.status === "answered" ? "已回答" : "生成失败，未形成归档回答"}`,
        "",
        "**问题**",
        "",
        markdownText(question.text),
        "",
      );
      if (question.status === "answered") {
        lines.push(
          "**回答**",
          "",
          markdownText(question.answer),
          "",
          ...citationMarkdown(question.evidence, 4),
          ...openQuestionsMarkdown(question.open_questions, 4),
          "",
        );
      }
    });
  }

  return `${lines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trim()}\n`;
}

function noteMarkdown(run, paper, reading, { agentMarkdown = "" } = {}) {
  return renderManagedNote({
    paper,
    workflowMarkdown: workflowMarkdown(run, paper, reading),
    agentMarkdown,
  });
}

async function inspectTarget(targetPath, targetDirectory, fileName) {
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const state = {
      target_directory: targetDirectory,
      file_name: fileName,
      exists: false,
      kind: null,
      byte_length: 0,
      current_content_hash: null,
    };
    return {
      ...state,
      target_hash: sha256(state),
    };
  }

  const kind = targetStat.isSymbolicLink()
    ? "symbolic_link"
    : targetStat.isFile()
      ? "file"
      : targetStat.isDirectory()
        ? "directory"
        : "other";
  const currentContent = targetStat.isFile()
    ? await readFile(targetPath, "utf8")
    : null;
  const currentContentHash = targetStat.isFile()
    ? sha256(currentContent)
    : null;
  const state = {
    target_directory: targetDirectory,
    file_name: fileName,
    exists: true,
    kind,
    byte_length: targetStat.size,
    modified_at_ms: targetStat.mtimeMs,
    mode: targetStat.mode & 0o777,
    current_content_hash: currentContentHash,
  };
  return {
    ...state,
    target_hash: sha256(state),
    current_content: currentContent,
  };
}

function relevantRunHash(run) {
  const decisions = run.paper_decisions
    && typeof run.paper_decisions === "object"
    && !Array.isArray(run.paper_decisions)
    ? run.paper_decisions
    : {};
  const paperIds = Object.entries(decisions)
    .filter(([, decision]) => decision === "read")
    .map(([paperId]) => paperId)
    .sort();
  return sha256({
    decisions,
    candidates: paperIds.map((paperId) => {
      const paper = run.candidates?.find((candidate) => candidate.paper_id === paperId);
      return paper ? {
        paper_id: paper.paper_id,
        dedupe_key: paper.dedupe_key ?? null,
        official_id: paper.official_id ?? null,
        title: paper.title,
        authors: paper.authors ?? [],
        venue: paper.venue ?? null,
        published_at: paper.published_at ?? null,
        doi: paper.doi ?? null,
        canonical_url: paper.canonical_url ?? paper.official_url ?? null,
      } : null;
    }),
    readings: paperIds.map((paperId) => {
      const reading = run.readings?.papers?.[paperId];
      return reading ? {
        status: reading.status ?? null,
        document_revision: reading.document_revision ?? null,
        current_stage: reading.current_stage ?? null,
        canonical_conversation_id: reading.canonical_conversation_id ?? null,
        stages: reading.stages ?? null,
        questions: reading.questions ?? null,
        pinned_conclusions: (reading.pinned_conclusions ?? [])
          .map((conclusion) => ({
            conclusion_id: conclusion.conclusion_id ?? null,
            source_conversation_id:
              conclusion.source_conversation_id ?? null,
            source_turn_id: conclusion.source_turn_id ?? null,
            content_hash: conclusion.content_hash ?? null,
            citations: conclusion.citations ?? [],
            coverage_stages: conclusion.coverage_stages ?? [],
            confirmed_by: conclusion.confirmed_by ?? null,
            status: conclusion.status ?? null,
            updated_at: conclusion.updated_at ?? null,
          }))
          .sort((left, right) => (
            String(left.conclusion_id).localeCompare(String(right.conclusion_id))
          )),
        agent_actions: {
          status: reading.agent_actions?.status ?? null,
          proposals: (reading.agent_actions?.proposals ?? [])
            .map((proposal) => ({
              proposal_id: proposal.proposal_id ?? null,
              turn_id: proposal.turn_id ?? null,
              status: proposal.status ?? null,
              content_hash: proposal.content_hash ?? null,
              target_version_or_hash: proposal.target_version_or_hash ?? null,
              committed_at: proposal.committed_at ?? null,
            }))
            .sort((left, right) => (
              String(left.proposal_id).localeCompare(String(right.proposal_id))
            )),
        },
      } : null;
    }),
  });
}

function proposalCore(proposal) {
  return {
    proposal_id: proposal.proposal_id,
    run_id: proposal.run_id,
    paper_id: proposal.paper_id,
    target: proposal.target,
    operation: proposal.operation,
    write_mode: proposal.write_mode,
    target_locator: proposal.target_locator,
    content_hash: proposal.content_hash,
    target_version_or_hash: proposal.target_version_or_hash,
    actionable: proposal.actionable,
    selected: proposal.selected,
    status: proposal.status,
  };
}

function proposalIntegrityCore(proposal) {
  return {
    ...proposalCore(proposal),
    decision: proposal.decision,
    target_details: proposal.target_details,
    target_hash: proposal.target_hash,
    markdown: proposal.markdown,
    diff: proposal.diff,
  };
}

function assertProposalIntegrity(proposal) {
  const expectedId = `obsidian-preview-${sha256({
    run_id: proposal.run_id,
    paper_id: proposal.paper_id,
    target_locator: proposal.target_locator,
    content_hash: proposal.content_hash,
    target_hash: proposal.target_hash,
  }).slice(7, 23)}`;
  const baseValid = (
    proposal.proposal_id === expectedId
    && proposal.content_hash === sha256(proposal.markdown)
    && proposal.target_hash === proposal.target_version_or_hash
  );
  const diffValid = proposal.write_mode === "create_only"
    ? (
        proposal.diff?.mode === "create"
        && proposal.diff.before === null
        && proposal.diff.after === proposal.markdown
      )
    : proposal.write_mode === "managed_update"
      ? (
          proposal.diff?.mode === "replace_managed_workflow"
          && proposal.diff.before_hash
            === proposal.target_details?.current_content_hash
          && proposal.diff.after_hash === proposal.content_hash
          && proposal.diff.after === proposal.markdown
        )
      : proposal.write_mode === "manual_update_required"
        && proposal.diff?.mode === "blocked_existing"
        && proposal.diff.before_hash
          === proposal.target_details?.current_content_hash
        && proposal.diff.after_hash
          === proposal.target_details?.current_content_hash;
  if (!baseValid || !diffValid) {
    throw previewError(
      "OBSIDIAN_PREVIEW_CORRUPT",
      "Obsidian 精确预览缺失或损坏，请重新生成",
      409,
      true,
    );
  }
}

function safeCommitError(error) {
  return {
    code: compactLine(error?.code, "OBSIDIAN_WRITE_FAILED"),
    message: compactLine(error?.message, "Obsidian 笔记写入失败"),
    retryable: error?.retryable !== false,
  };
}

async function atomicWriteTarget(targetPath, markdown, expectedTargetHash) {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, markdown, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    const current = await inspectTarget(
      targetPath,
      path.dirname(targetPath),
      path.basename(targetPath),
    );
    if (current.target_hash !== expectedTargetHash) {
      throw previewError(
        "OBSIDIAN_PREVIEW_STALE",
        "Obsidian 目标在确认前发生变化，未执行写入",
        409,
        true,
      );
    }
    if (current.exists) {
      await chmod(temporaryPath, current.mode);
      await rename(temporaryPath, targetPath);
    } else {
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function createObsidianPreviewService({
  runStore,
  getPaperReading,
  obsidianNoteDir,
  now = () => new Date(),
} = {}) {
  if (!runStore || typeof getPaperReading !== "function") {
    throw new Error("Obsidian preview service dependencies are required");
  }
  if (typeof obsidianNoteDir !== "string" || !obsidianNoteDir.trim()) {
    throw new Error("obsidianNoteDir is required");
  }
  const configuredDirectory = path.resolve(obsidianNoteDir);
  const targetQueues = new Map();

  function withTargetLock(targetPath, operation) {
    const previous = targetQueues.get(targetPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    targetQueues.set(targetPath, current);
    return current.finally(() => {
      if (targetQueues.get(targetPath) === current) targetQueues.delete(targetPath);
    });
  }

  async function targetDirectory() {
    let directoryStat;
    try {
      directoryStat = await stat(configuredDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw previewError(
          "OBSIDIAN_DIRECTORY_NOT_FOUND",
          "配置的 Obsidian 笔记目录不存在",
          409,
          false,
        );
      }
      throw error;
    }
    if (!directoryStat.isDirectory()) {
      throw previewError(
        "OBSIDIAN_DIRECTORY_INVALID",
        "配置的 Obsidian 笔记目标不是目录",
      );
    }
    return realpath(configuredDirectory);
  }

  async function createPreview(runId) {
    const run = await runStore.getRun(runId);
    if (!run) throw previewError("RUN_NOT_FOUND", "运行不存在", 404);
    if (run.status !== "draft_ready") {
      throw previewError(
        "OBSIDIAN_PREVIEW_NOT_ALLOWED",
        "只有精读完成并进入写入草稿阶段后才能生成 Obsidian 预览",
      );
    }
    const decisions = run.paper_decisions;
    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
      throw previewError("OBSIDIAN_DECISIONS_INVALID", "论文决定缺失或无效");
    }
    const paperIds = Object.entries(decisions)
      .filter(([, decision]) => decision === "read")
      .map(([paperId]) => paperId)
      .sort();
    if (paperIds.length === 0) {
      throw previewError(
        "OBSIDIAN_NOT_REQUIRED",
        "本轮没有选择精读的论文，不需要生成 Obsidian 笔记预览",
      );
    }
    if (Object.values(decisions).some((decision) => !["collect", "read"].includes(decision))) {
      throw previewError("OBSIDIAN_DECISIONS_INVALID", "论文决定包含未知值");
    }
    paperIds.forEach(assertPaperId);

    const directory = await targetDirectory();
    const sourceHash = relevantRunHash(run);
    const proposals = [];
    for (const paperId of paperIds) {
      const paper = run.candidates?.find((candidate) => candidate.paper_id === paperId);
      if (!paper) {
        throw previewError(
          "OBSIDIAN_PAPER_NOT_FOUND",
          "精读论文已不在本轮候选中",
        );
      }
      const reading = await getPaperReading(runId, paperId);
      assertReading(run, paperId, reading);

      const fileName = noteFileName(paper);
      const targetPath = path.resolve(directory, fileName);
      const relative = path.relative(directory, targetPath);
      if (
        !relative
        || relative.startsWith("..")
        || path.isAbsolute(relative)
        || relative !== fileName
      ) {
        throw previewError(
          "OBSIDIAN_TARGET_INVALID",
          "Obsidian 目标文件必须位于配置的笔记目录内",
        );
      }
      const targetState = await inspectTarget(targetPath, directory, fileName);
      const parsedTarget = targetState.kind === "file"
        ? parseManagedNote(targetState.current_content, paper)
        : null;
      const managedUpdate = parsedTarget?.status === "managed";
      const markdown = noteMarkdown(run, paper, reading, {
        agentMarkdown: managedUpdate ? parsedTarget.agent_markdown : "",
      });
      const contentHash = sha256(markdown);
      const actionable = !targetState.exists || managedUpdate;
      const proposalSeed = {
        run_id: runId,
        paper_id: paperId,
        target_locator: targetPath,
        content_hash: contentHash,
        target_hash: targetState.target_hash,
      };
      const proposalId = `obsidian-preview-${sha256(proposalSeed).slice(7, 23)}`;
      const markdownArtifactPath = [
        "obsidian/previews",
        `${sha256(paperId).slice(7, 23)}-${contentHash.slice(7, 15)}.md`,
      ].join("/");
      await runStore.writeArtifact(runId, markdownArtifactPath, markdown);
      proposals.push({
        proposal_id: proposalId,
        run_id: runId,
        paper_id: paperId,
        decision: "read",
        target: "obsidian",
        operation: targetState.exists ? "update" : "create",
        write_mode: !targetState.exists
          ? "create_only"
          : managedUpdate
            ? "managed_update"
            : "manual_update_required",
        target_locator: targetPath,
        target_details: {
          directory,
          file_name: fileName,
          exists: targetState.exists,
          kind: targetState.kind,
          byte_length: targetState.byte_length,
          current_content_hash: targetState.current_content_hash,
        },
        target_hash: targetState.target_hash,
        target_version_or_hash: targetState.target_hash,
        content_hash: contentHash,
        markdown,
        markdown_artifact_path: markdownArtifactPath,
        actionable,
        selected: actionable,
        status: actionable ? "draft" : "blocked",
        preview_or_diff: !targetState.exists
          ? [
              `新建文件：${targetPath}`,
              "写入内容：以下 Markdown 全文",
            ]
          : managedUpdate
            ? [
                `更新受管笔记：${targetPath}`,
                "替换分阶段精读区，并原样保留已确认的 Agent 补充笔记。",
              ]
          : [
              `目标已存在：${targetPath}`,
              parsedTarget?.status === "identity_mismatch"
                ? "论文身份标记不匹配；当前版本不会覆盖、追加或改名。"
                : "现有文件不是结构完整的 Pi Agent 受管笔记；当前版本不会覆盖、追加或改名。",
            ],
        diff: !targetState.exists
          ? {
              mode: "create",
              before: null,
              after: markdown,
            }
          : managedUpdate
            ? {
                mode: "replace_managed_workflow",
                before_hash: targetState.current_content_hash,
                after_hash: contentHash,
                preserved_region: "agent-notes",
                preserved_content_hash: sha256(parsedTarget.agent_markdown),
                after: markdown,
              }
          : {
              mode: "blocked_existing",
              before_hash: targetState.current_content_hash,
              after_hash: targetState.current_content_hash,
              changes: [],
            },
      });
    }

    const proposalHash = sha256(proposals.map(proposalIntegrityCore));
    const generatedAt = now().toISOString();
    const status = proposals.every((proposal) => proposal.actionable)
      ? "preview_ready"
      : proposals.some((proposal) => proposal.actionable)
        ? "partially_blocked"
        : "blocked";
    const artifact = {
      schema_version: 1,
      run_id: runId,
      target_type: "obsidian",
      write_capability: "hash_bound_commit",
      external_write_performed: false,
      status,
      configured_directory: configuredDirectory,
      target_directory: directory,
      source_hash: sourceHash,
      proposal_hash: proposalHash,
      proposals,
      generated_at: generatedAt,
    };
    const artifactPath = `obsidian/previews/${proposalHash.slice(7)}.json`;
    await runStore.writeArtifact(runId, artifactPath, artifact);

    const updated = await runStore.updateRun(runId, (current) => {
      if (
        current.status !== "draft_ready"
        || relevantRunHash(current) !== sourceHash
      ) {
        throw previewError(
          "OBSIDIAN_PREVIEW_STALE",
          "精读结果或论文决定已变化，请重新生成 Obsidian 预览",
        );
      }
      return {
        obsidian: {
          schema_version: 1,
          status,
          proposal_hash: proposalHash,
          artifact_path: artifactPath,
          proposals: proposals.map((proposal) => ({
            ...proposalCore(proposal),
            target_hash: proposal.target_hash,
            markdown_artifact_path: proposal.markdown_artifact_path,
          })),
          approval: null,
          last_error: null,
          updated_at: generatedAt,
        },
      };
    });
    await runStore.appendEvent(runId, {
      type: "obsidian_preview_created",
      status,
      proposal_hash: proposalHash,
      proposal_count: proposals.length,
      blocked_count: proposals.filter((proposal) => !proposal.actionable).length,
      at: updated.updated_at,
    });
    return {
      ...artifact,
      artifact_path: artifactPath,
    };
  }

  async function getPreview(runId) {
    const run = await runStore.getRun(runId);
    if (!run) throw previewError("RUN_NOT_FOUND", "运行不存在", 404);
    const artifactPath = run.obsidian?.artifact_path;
    const proposalHash = run.obsidian?.proposal_hash;
    if (!artifactPath || !proposalHash) {
      throw previewError(
        "OBSIDIAN_PREVIEW_NOT_FOUND",
        "当前运行还没有 Obsidian 精确预览",
        404,
      );
    }
    const artifact = await runStore.readArtifact(runId, artifactPath);
    let artifactIntegrityValid = false;
    try {
      artifactIntegrityValid = (
        Array.isArray(artifact?.proposals)
        && artifact.proposals.every((proposal) => {
          assertProposalIntegrity(proposal);
          return true;
        })
        && sha256(artifact.proposals.map(proposalIntegrityCore)) === proposalHash
      );
    } catch {
      artifactIntegrityValid = false;
    }
    if (
      !artifact
      || artifact.run_id !== runId
      || artifact.proposal_hash !== proposalHash
      || artifact.source_hash !== relevantRunHash(run)
      || !artifactIntegrityValid
    ) {
      throw previewError(
        "OBSIDIAN_PREVIEW_STALE",
        "Obsidian 精确预览与当前运行状态不一致，请重新生成",
      );
    }
    return artifact;
  }

  async function validateCommit(runId, {
    proposalHash,
    operations,
  } = {}) {
    const artifact = await getPreview(runId);
    const run = await runStore.getRun(runId);
    if (artifact.proposal_hash !== proposalHash) {
      throw previewError(
        "OBSIDIAN_PREVIEW_STALE",
        "Obsidian 预览内容已变化，请重新检查后确认",
        409,
        true,
      );
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      throw previewError(
        "OBSIDIAN_APPROVAL_EMPTY",
        "至少选择一篇 Obsidian 笔记写入",
        400,
      );
    }
    const selected = [];
    const seen = new Set();
    for (const binding of operations) {
      const proposal = artifact.proposals.find(
        (candidate) => candidate.proposal_id === binding?.proposal_id,
      );
      if (
        !proposal
        || seen.has(proposal.proposal_id)
        || proposal.actionable !== true
        || !["create_only", "managed_update"].includes(proposal.write_mode)
        || binding.content_hash !== proposal.content_hash
        || binding.target_version_or_hash !== proposal.target_version_or_hash
      ) {
        throw previewError(
          "OBSIDIAN_APPROVAL_INVALID",
          "Obsidian 确认内容与当前预览不一致",
          409,
          true,
        );
      }
      seen.add(proposal.proposal_id);
      const current = await inspectTarget(
        proposal.target_locator,
        artifact.target_directory,
        proposal.target_details.file_name,
      );
      const paper = run?.candidates?.find(
        (candidate) => candidate.paper_id === proposal.paper_id,
      );
      if (
        current.current_content_hash === proposal.content_hash
        && paper
        && parseManagedNote(current.current_content, paper)?.status === "managed"
      ) {
        selected.push({ ...proposal, already_committed: true });
        continue;
      }
      if (current.target_hash !== proposal.target_version_or_hash) {
        throw previewError(
          "OBSIDIAN_PREVIEW_STALE",
          "Obsidian 目标在预览后发生变化，请重新生成预览",
          409,
          true,
        );
      }
      selected.push({ ...proposal, already_committed: false });
    }
    return { artifact, selected };
  }

  async function commit(runId, {
    clientRequestId,
    proposalHash,
    operations,
  } = {}) {
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw previewError(
        "OBSIDIAN_APPROVAL_REQUEST_INVALID",
        "Obsidian 确认请求标识无效",
        400,
      );
    }
    const { artifact, selected } = await validateCommit(runId, {
      proposalHash,
      operations,
    });
    const approvedAt = now().toISOString();
    const approval = {
      schema_version: 1,
      run_id: runId,
      client_request_id: clientRequestId.trim(),
      proposal_hash: proposalHash,
      operations: selected.map((proposal) => ({
        proposal_id: proposal.proposal_id,
        content_hash: proposal.content_hash,
        target_version_or_hash: proposal.target_version_or_hash,
      })),
      approved_at: approvedAt,
    };
    approval.approval_hash = sha256(approval);
    const approvalPath =
      `obsidian/approvals/${approval.approval_hash.slice(7)}.json`;
    await runStore.writeArtifact(runId, approvalPath, approval);
    await runStore.updateRun(runId, (current) => ({
      obsidian: {
        ...current.obsidian,
        status: "committing",
        approval: {
          ...approval,
          artifact_path: approvalPath,
        },
        last_error: null,
        proposals: (current.obsidian?.proposals ?? []).map((proposal) => (
          selected.some((item) => item.proposal_id === proposal.proposal_id)
            ? { ...proposal, selected: true, status: "committing" }
            : proposal
        )),
        updated_at: approvedAt,
      },
    }));

    for (const proposal of selected) {
      const startedAt = now().toISOString();
      const ledgerPath = `writes/obsidian/${proposal.proposal_id}.json`;
      try {
        await runStore.writeArtifact(runId, ledgerPath, {
          schema_version: 1,
          run_id: runId,
          proposal_id: proposal.proposal_id,
          approval_hash: approval.approval_hash,
          status: "committing",
          started_at: startedAt,
        });
        await withTargetLock(proposal.target_locator, async () => {
          if (!proposal.already_committed) {
            await atomicWriteTarget(
              proposal.target_locator,
              proposal.markdown,
              proposal.target_version_or_hash,
            );
          }
          const verified = await inspectTarget(
            proposal.target_locator,
            artifact.target_directory,
            proposal.target_details.file_name,
          );
          const paper = (await runStore.getRun(runId))?.candidates?.find(
            (candidate) => candidate.paper_id === proposal.paper_id,
          );
          if (
            verified.current_content_hash !== proposal.content_hash
            || !paper
            || parseManagedNote(verified.current_content, paper)?.status !== "managed"
          ) {
            throw previewError(
              "OBSIDIAN_WRITE_VERIFICATION_FAILED",
              "Obsidian 笔记写入后的读回核验失败",
              500,
              true,
            );
          }
        });
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
        });
        await runStore.updateRun(runId, (current) => ({
          obsidian: {
            ...current.obsidian,
            proposals: (current.obsidian?.proposals ?? []).map((item) => (
              item.proposal_id === proposal.proposal_id
                ? {
                    ...item,
                    selected: true,
                    status: "committed",
                    committed_at: completedAt,
                    verified_at: completedAt,
                    last_error: null,
                  }
                : item
            )),
            updated_at: completedAt,
          },
        }));
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
          obsidian: {
            ...current.obsidian,
            proposals: (current.obsidian?.proposals ?? []).map((item) => (
              item.proposal_id === proposal.proposal_id
                ? { ...item, selected: true, status: "failed", last_error: lastError }
                : item
            )),
            last_error: lastError,
            updated_at: failedAt,
          },
        }));
      }
    }
    const finishedAt = now().toISOString();
    const updated = await runStore.updateRun(runId, (current) => {
      const selectedStates = (current.obsidian?.proposals ?? []).filter(
        (proposal) => proposal.selected === true,
      );
      const failed = selectedStates.filter((proposal) => proposal.status === "failed");
      const committed = selectedStates.filter((proposal) => proposal.status === "committed");
      return {
        obsidian: {
          ...current.obsidian,
          status: failed.length > 0
            ? committed.length > 0 ? "partial" : "failed"
            : "completed",
          updated_at: finishedAt,
        },
      };
    });
    await runStore.appendEvent(runId, {
      type: "obsidian_commit_completed",
      proposal_hash: proposalHash,
      at: finishedAt,
    });
    return updated;
  }

  return {
    commit,
    createPreview,
    getPreview,
    validateCommit,
  };
}

export const __test = {
  noteFileName,
  noteMarkdown,
  relevantRunHash,
  sha256,
};
