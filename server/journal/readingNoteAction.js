import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AGENT_NOTES_END as AGENT_END,
  noteFileName,
  paperIdentityMarker as identityMarker,
  parseManagedNote,
  renderManagedNote,
} from "./obsidianNoteFormat.js";

const PAPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const TARGET_WRITE_QUEUES = new Map();
const PROPOSAL_CREATE_QUEUES = new Map();

export class ReadingNoteActionError extends Error {
  constructor(code, message, status = 409, retryable = false) {
    super(message);
    this.name = "ReadingNoteActionError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function actionError(code, message, status = 409, retryable = false) {
  return new ReadingNoteActionError(code, message, status, retryable);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
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

function actionMarkers(proposalId) {
  return {
    start: `<!-- pi-agent:agent-action:${proposalId}:start -->`,
    end: `<!-- pi-agent:agent-action:${proposalId}:end -->`,
  };
}

function markerCount(markdown, marker) {
  return markdown.split(marker).length - 1;
}

function assertManagedNote(markdown, paper) {
  if (parseManagedNote(markdown, paper).status !== "managed") {
    throw actionError(
      "OBSIDIAN_NOTE_UNMANAGED",
      "目标笔记不是当前论文的 Pi Agent 受管笔记，不能自动修改",
    );
  }
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function canonicalSkeleton(runId, paper) {
  const authors = (paper.authors ?? []).map((author) => compactLine(author)).filter(Boolean);
  const sourceUrl = safeWebUrl(paper.canonical_url ?? paper.official_url);
  const workflowMarkdown = [
    `# ${compactLine(paper.title, "未命名论文")}`,
    "",
    "## 论文信息",
    "",
    `- 作者：${authors.length > 0 ? authors.join("；") : "未提供"}`,
    `- 发表信息：${[compactLine(paper.venue), compactLine(paper.published_at)].filter(Boolean).join(" · ") || "未提供"}`,
    `- DOI：${compactLine(paper.doi, "未提供")}`,
    `- 原文：${sourceUrl ? `[打开原文](${sourceUrl})` : "未提供"}`,
    `- Pi Agent Run：\`${runId}\``,
    `- Paper ID：\`${paper.paper_id}\``,
    "",
    "## 分阶段精读",
    "",
    "> 分阶段精读完成后，由归档流程更新此受管区域。",
  ].join("\n");
  return renderManagedNote({
    paper,
    workflowMarkdown,
    agentMarkdown: "## Agent 补充笔记",
  });
}

function assertSafeTurnText(turn) {
  if (
    [turn.question, turn.answer, ...(turn.citations ?? []).flatMap(
      (citation) => [citation.quote, citation.support],
    )].some((value) => /<!--\s*pi-agent:/i.test(String(value ?? "")))
  ) {
    throw actionError(
      "OBSIDIAN_NOTE_CONTENT_INVALID",
      "对话内容包含保留的笔记控制标记，不能形成自动修改提案",
      400,
    );
  }
}

function actionMarkdown(proposalId, turn) {
  assertSafeTurnText(turn);
  const markers = actionMarkers(proposalId);
  const lines = [
    markers.start,
    "### Agent 对话",
    "",
    "**问题**",
    "",
    markdownText(turn.question),
    "",
    "**回答**",
    "",
    markdownText(turn.answer),
    "",
    "#### 原文依据",
    "",
  ];
  if (!Array.isArray(turn.citations) || turn.citations.length === 0) {
    lines.push("- 本次回答未引用具体段落。");
  } else {
    turn.citations.forEach((citation, index) => {
      const location = Array.isArray(citation.path) && citation.path.length > 0
        ? citation.path.map(compactLine).filter(Boolean).join(" › ")
        : "未提供章节路径";
      lines.push(
        `${index + 1}. \`${compactLine(citation.block_id, "未提供锚点")}\``,
        `   - 位置：${location}`,
        `   - 原文：${compactLine(citation.quote, "未提供摘录")}`,
        `   - 支持关系：${compactLine(citation.support, "未提供")}`,
      );
    });
  }
  lines.push(markers.end);
  return `${lines.join("\n").trim()}\n`;
}

function appendAgentAction(current, paper, block) {
  assertManagedNote(current, paper);
  const insertion = `${block.trim()}\n\n${AGENT_END}`;
  return current.replace(AGENT_END, insertion);
}

function targetStateVersion(state) {
  return sha256({
    exists: state.exists,
    kind: state.kind,
    byte_length: state.byte_length,
    content_hash: state.current_content_hash,
  });
}

async function inspectTarget(targetPath) {
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const state = {
      exists: false,
      kind: null,
      byte_length: 0,
      current_content_hash: null,
      markdown: null,
    };
    return { ...state, target_version: targetStateVersion(state) };
  }
  const kind = targetStat.isSymbolicLink()
    ? "symbolic_link"
    : targetStat.isFile()
      ? "file"
      : targetStat.isDirectory()
        ? "directory"
        : "other";
  if (kind !== "file") {
    throw actionError(
      "OBSIDIAN_NOTE_TARGET_INVALID",
      "Obsidian 目标必须是普通 Markdown 文件",
    );
  }
  if (targetStat.size > MAX_NOTE_BYTES) {
    throw actionError("OBSIDIAN_NOTE_TOO_LARGE", "Obsidian 目标笔记过大，不能自动修改");
  }
  const markdown = await readFile(targetPath, "utf8");
  const state = {
    exists: true,
    kind,
    byte_length: Buffer.byteLength(markdown),
    current_content_hash: sha256(markdown),
    markdown,
  };
  return { ...state, target_version: targetStateVersion(state) };
}

function proposalCore(proposal) {
  return {
    proposal_id: proposal.proposal_id,
    run_id: proposal.run_id,
    paper_id: proposal.paper_id,
    turn_id: proposal.turn_id,
    target_locator: proposal.target_locator,
    operation: proposal.operation,
    action_marker: proposal.action_marker,
    content_hash: proposal.content_hash,
    target_version_or_hash: proposal.target_version_or_hash,
    expected_after_hash: proposal.expected_after_hash,
  };
}

function summaryFromProposal(proposal) {
  return {
    proposal_id: proposal.proposal_id,
    client_request_id: proposal.client_request_id,
    turn_id: proposal.turn_id,
    status: proposal.status,
    target_locator: proposal.target_locator,
    operation_label: proposal.operation === "create"
      ? "新建受管论文笔记"
      : "追加 Agent 对话笔记",
    proposal_hash: proposal.proposal_hash,
    content_hash: proposal.content_hash,
    target_version_or_hash: proposal.target_version_or_hash,
    preview_or_diff: [...proposal.preview_or_diff],
    diff: structuredClone(proposal.diff),
    last_error: proposal.last_error ? structuredClone(proposal.last_error) : null,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
    committed_at: proposal.committed_at ?? null,
  };
}

function publicProposal(proposal) {
  return {
    schema_version: proposal.schema_version,
    ...summaryFromProposal(proposal),
    run_id: proposal.run_id,
    paper_id: proposal.paper_id,
    action_marker: proposal.action_marker,
    expected_after_hash: proposal.expected_after_hash,
    approval: proposal.approval ? structuredClone(proposal.approval) : null,
    abandoned_at: proposal.abandoned_at ?? null,
    verified_at: proposal.verified_at ?? null,
  };
}

function assertRequestId(clientRequestId) {
  if (typeof clientRequestId !== "string" || !REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw actionError(
      "READING_NOTE_CLIENT_REQUEST_ID_REQUIRED",
      "笔记修改操作必须提供稳定的请求标识",
      400,
    );
  }
}

function assertPaperId(paperId) {
  if (typeof paperId !== "string" || !PAPER_ID_PATTERN.test(paperId)) {
    throw actionError("READING_NOTE_PAPER_INVALID", "论文标识无效", 400);
  }
}

function assertBindings(proposal, bindings) {
  if (
    !bindings
    || bindings.proposalHash !== proposal.proposal_hash
    || bindings.contentHash !== proposal.content_hash
    || bindings.targetVersionOrHash !== proposal.target_version_or_hash
  ) {
    throw actionError(
      "READING_NOTE_BINDING_MISMATCH",
      "笔记修改提案已变化，请重新检查预览",
      409,
    );
  }
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "OBSIDIAN_NOTE_WRITE_FAILED",
    message: typeof error?.message === "string"
      ? error.message.slice(0, 300)
      : "Obsidian 笔记写入失败",
    retryable: error?.retryable === true,
  };
}

function withTargetLock(targetPath, operation) {
  const previous = TARGET_WRITE_QUEUES.get(targetPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  TARGET_WRITE_QUEUES.set(targetPath, current);
  return current.finally(() => {
    if (TARGET_WRITE_QUEUES.get(targetPath) === current) {
      TARGET_WRITE_QUEUES.delete(targetPath);
    }
  });
}

function withProposalCreateLock(key, operation) {
  const previous = PROPOSAL_CREATE_QUEUES.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  PROPOSAL_CREATE_QUEUES.set(key, current);
  return current.finally(() => {
    if (PROPOSAL_CREATE_QUEUES.get(key) === current) {
      PROPOSAL_CREATE_QUEUES.delete(key);
    }
  });
}

async function atomicWrite(targetPath, markdown, expectedState) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const beforeWrite = await inspectTarget(targetPath);
    if (beforeWrite.target_version !== expectedState.target_version) {
      throw actionError(
        "READING_NOTE_TARGET_STALE",
        "目标笔记在确认后发生变化，未执行写入",
        409,
        true,
      );
    }
    if (expectedState.exists) {
      await rename(temporaryPath, targetPath);
    } else {
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (error?.code === "EEXIST") {
      throw actionError(
        "READING_NOTE_TARGET_STALE",
        "目标笔记在确认后发生变化，未执行写入",
        409,
        true,
      );
    }
    throw error;
  }
}

export function createReadingNoteActionService({
  runStore,
  getRunPaper,
  getPaperReading,
  obsidianNoteDir,
  now = () => new Date(),
} = {}) {
  if (!runStore || typeof getRunPaper !== "function" || typeof getPaperReading !== "function") {
    throw new Error("reading note action service dependencies are required");
  }
  if (typeof obsidianNoteDir !== "string" || !obsidianNoteDir.trim()) {
    throw new Error("obsidianNoteDir is required");
  }
  const configuredDirectory = path.resolve(obsidianNoteDir);

  async function noteDirectory() {
    let directoryStat;
    try {
      directoryStat = await stat(configuredDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw actionError(
          "OBSIDIAN_DIRECTORY_NOT_FOUND",
          "配置的 Obsidian 笔记目录不存在",
        );
      }
      throw error;
    }
    if (!directoryStat.isDirectory()) {
      throw actionError("OBSIDIAN_DIRECTORY_INVALID", "配置的 Obsidian 笔记目标不是目录");
    }
    return realpath(configuredDirectory);
  }

  async function resolvedTarget(paper) {
    const directory = await noteDirectory();
    const fileName = noteFileName(paper);
    const targetPath = path.resolve(directory, fileName);
    const relative = path.relative(directory, targetPath);
    if (
      !relative
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || relative !== fileName
      || path.extname(targetPath).toLowerCase() !== ".md"
    ) {
      throw actionError(
        "OBSIDIAN_NOTE_TARGET_INVALID",
        "Obsidian 目标必须是配置目录内由服务端派生的 Markdown 文件",
      );
    }
    return targetPath;
  }

  function findSummary(run, paperId, proposalId) {
    return run.readings?.papers?.[paperId]?.agent_actions?.proposals?.find(
      (proposal) => proposal.proposal_id === proposalId,
    ) ?? null;
  }

  async function loadProposal(runId, paperId, proposalId) {
    const run = await runStore.getRun(runId);
    if (!run) throw actionError("RUN_NOT_FOUND", "运行不存在", 404);
    const summary = findSummary(run, paperId, proposalId);
    if (!summary) {
      throw actionError("READING_NOTE_PROPOSAL_NOT_FOUND", "笔记修改提案不存在", 404);
    }
    const artifactPath = `readings/${paperId}/agent-actions/proposals/${proposalId}.json`;
    let proposal;
    try {
      proposal = await runStore.readArtifact(runId, artifactPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw actionError("READING_NOTE_PROPOSAL_CORRUPT", "笔记修改提案文件缺失");
      }
      throw error;
    }
    const paper = run.candidates?.find((candidate) => candidate.paper_id === paperId);
    const expectedTarget = paper ? await resolvedTarget(paper) : null;
    const originalTargetState = proposal?.operation === "append"
      && typeof proposal.before_markdown === "string"
      ? {
          exists: true,
          kind: "file",
          byte_length: Buffer.byteLength(proposal.before_markdown),
          current_content_hash: sha256(proposal.before_markdown),
        }
      : {
          exists: false,
          kind: null,
          byte_length: 0,
          current_content_hash: null,
        };
    if (
      proposal?.run_id !== runId
      || proposal?.paper_id !== paperId
      || proposal?.proposal_id !== proposalId
      || !paper
      || proposal.target_locator !== expectedTarget
      || proposal.proposal_hash !== sha256(proposalCore(proposal))
      || summary.proposal_hash !== proposal.proposal_hash
      || summary.content_hash !== proposal.content_hash
      || summary.target_version_or_hash !== proposal.target_version_or_hash
      || !HASH_PATTERN.test(proposal.content_hash)
      || !HASH_PATTERN.test(proposal.expected_after_hash)
      || !["create", "append"].includes(proposal.operation)
      || typeof proposal.action_markdown !== "string"
      || typeof proposal.after_markdown !== "string"
      || typeof proposal.diff?.after !== "string"
      || sha256(proposal.after_markdown) !== proposal.expected_after_hash
      || sha256(proposal.action_markdown) !== proposal.content_hash
      || proposal.diff.mode !== (
        proposal.operation === "create" ? "create_managed_note" : "append_managed_region"
      )
      || proposal.diff.after !== (
        proposal.operation === "create"
          ? proposal.after_markdown
          : proposal.action_markdown
      )
      || targetStateVersion(originalTargetState) !== proposal.target_version_or_hash
      || proposal.action_marker !== actionMarkers(proposalId).start
      || markerCount(proposal.action_markdown, proposal.action_marker) !== 1
      || markerCount(proposal.after_markdown, proposal.action_marker) !== 1
      || markerCount(proposal.action_markdown, actionMarkers(proposalId).end) !== 1
      || markerCount(proposal.after_markdown, actionMarkers(proposalId).end) !== 1
    ) {
      throw actionError("READING_NOTE_PROPOSAL_CORRUPT", "笔记修改提案校验失败");
    }
    assertManagedNote(proposal.after_markdown, paper);
    if (proposal.operation === "append") {
      assertManagedNote(proposal.before_markdown, paper);
    } else if (proposal.before_markdown !== null) {
      throw actionError("READING_NOTE_PROPOSAL_CORRUPT", "笔记修改提案校验失败");
    }
    return { run, proposal, artifactPath };
  }

  async function persistProposal(runId, paperId, proposal, artifactPath) {
    await runStore.writeArtifact(runId, artifactPath, proposal);
    const savedAt = proposal.updated_at;
    await runStore.updateRun(runId, (current) => {
      const readings = structuredClone(current.readings ?? {});
      const paperState = readings.papers?.[paperId];
      if (!paperState) {
        throw actionError("READING_NOTE_STATE_MISSING", "论文精读状态不存在");
      }
      const agentActions = {
        schema_version: 1,
        status: proposal.status,
        proposals: Array.isArray(paperState.agent_actions?.proposals)
          ? [...paperState.agent_actions.proposals]
          : [],
        updated_at: savedAt,
      };
      const index = agentActions.proposals.findIndex(
        (item) => item.proposal_id === proposal.proposal_id,
      );
      const summary = summaryFromProposal(proposal);
      if (index >= 0) agentActions.proposals[index] = summary;
      else agentActions.proposals.push(summary);
      const turns = (paperState.chat?.turns ?? []).map((turn) => (
        turn.id === proposal.turn_id
          ? { ...turn, action_proposal_id: proposal.proposal_id }
          : turn
      ));
      readings.papers[paperId] = {
        ...paperState,
        agent_actions: agentActions,
        chat: {
          ...paperState.chat,
          turns,
        },
      };
      return { readings };
    });
  }

  async function createProposalUnlocked(runId, paperId, turnId, {
    clientRequestId,
  } = {}) {
    assertPaperId(paperId);
    assertRequestId(clientRequestId);
    const { run, paper } = await getRunPaper(runId, paperId);
    const rawPaper = run.readings?.papers?.[paperId];
    const rawTurn = rawPaper?.chat?.turns?.find((turn) => turn.id === turnId);
    if (!rawTurn || rawTurn.status !== "answered") {
      throw actionError(
        "READING_NOTE_TURN_NOT_READY",
        "只有已回答的论文 Agent 对话才能形成笔记修改提案",
      );
    }
    let replacedProposalId = null;
    if (rawTurn.action_proposal_id) {
      const existing = await loadProposal(
        runId,
        paperId,
        rawTurn.action_proposal_id,
      );
      if (existing.proposal.status === "abandoned") {
        replacedProposalId = existing.proposal.proposal_id;
      } else if (existing.proposal.client_request_id !== clientRequestId) {
        throw actionError(
          "READING_NOTE_TURN_ALREADY_PROPOSED",
          "这条 Agent 回答已经形成过笔记修改提案",
        );
      } else {
        return {
          proposal: publicProposal(existing.proposal),
          reading: await getPaperReading(runId, paperId),
        };
      }
    }
    const existingByRequest = rawPaper.agent_actions?.proposals?.find(
      (proposal) => proposal.client_request_id === clientRequestId,
    );
    if (existingByRequest) {
      if (existingByRequest.turn_id !== turnId) {
        throw actionError(
          "READING_NOTE_REQUEST_CONFLICT",
          "同一笔记请求标识已用于不同对话",
        );
      }
      return getProposal(runId, paperId, existingByRequest.proposal_id);
    }

    const reading = await getPaperReading(runId, paperId);
    const turn = reading?.chat?.turns?.find((item) => item.id === turnId);
    if (!turn || turn.status !== "answered" || !markdownText(turn.answer)) {
      throw actionError(
        "READING_NOTE_TURN_NOT_READY",
        "Agent 回答产物尚未准备好，不能形成笔记修改提案",
      );
    }
    const targetPath = await resolvedTarget(paper);
    const target = await inspectTarget(targetPath);
    if (target.exists) assertManagedNote(target.markdown, paper);

    const proposalId = `reading-note-${sha256({
      run_id: runId,
      paper_id: paperId,
      turn_id: turnId,
      client_request_id: clientRequestId,
    }).slice(7, 23)}`;
    const block = actionMarkdown(proposalId, turn);
    const afterMarkdown = target.exists
      ? appendAgentAction(target.markdown, paper, block)
      : appendAgentAction(canonicalSkeleton(runId, paper), paper, block);
    const createdAt = now().toISOString();
    const markers = actionMarkers(proposalId);
    const proposal = {
      schema_version: 1,
      proposal_id: proposalId,
      client_request_id: clientRequestId,
      request_fingerprint: sha256({
        run_id: runId,
        paper_id: paperId,
        turn_id: turnId,
        turn_input_hash: rawTurn.input_hash ?? null,
      }),
      run_id: runId,
      paper_id: paperId,
      turn_id: turnId,
      target_locator: targetPath,
      operation: target.exists ? "append" : "create",
      action_marker: markers.start,
      content_hash: sha256(block),
      action_markdown: block,
      target_version_or_hash: target.target_version,
      expected_after_hash: sha256(afterMarkdown),
      before_markdown: target.markdown,
      after_markdown: afterMarkdown,
      preview_or_diff: [
        target.exists ? `追加到：${targetPath}` : `新建：${targetPath}`,
        "只写入下方已回答的 Agent 对话，不推进精读阶段。",
      ],
      diff: {
        mode: target.exists ? "append_managed_region" : "create_managed_note",
        before: null,
        after: target.exists ? block : afterMarkdown,
      },
      status: "draft",
      approval: null,
      last_error: null,
      created_at: createdAt,
      updated_at: createdAt,
      committed_at: null,
      abandoned_at: null,
      verified_at: null,
    };
    proposal.proposal_hash = sha256(proposalCore(proposal));
    const artifactPath =
      `readings/${paperId}/agent-actions/proposals/${proposalId}.json`;
    await runStore.writeArtifact(runId, artifactPath, proposal);

    let attached = false;
    await runStore.updateRun(runId, (current) => {
      const readings = structuredClone(current.readings ?? {});
      const paperState = readings.papers?.[paperId];
      const currentTurn = paperState?.chat?.turns?.find((item) => item.id === turnId);
      if (
        !currentTurn
        || currentTurn.status !== "answered"
        || currentTurn.input_hash !== rawTurn.input_hash
      ) {
        throw actionError(
          "READING_NOTE_TURN_CHANGED",
          "Agent 回答已变化，请重新生成笔记修改提案",
        );
      }
      if (
        currentTurn.action_proposal_id
        && currentTurn.action_proposal_id !== replacedProposalId
      ) {
        throw actionError(
          "READING_NOTE_TURN_ALREADY_PROPOSED",
          "这条 Agent 回答已经形成过笔记修改提案",
        );
      }
      const agentActions = {
        schema_version: 1,
        status: "draft",
        proposals: Array.isArray(paperState.agent_actions?.proposals)
          ? [...paperState.agent_actions.proposals]
          : [],
        updated_at: createdAt,
      };
      agentActions.proposals.push({
        ...summaryFromProposal(proposal),
      });
      readings.papers[paperId] = {
        ...paperState,
        agent_actions: agentActions,
        chat: {
          ...paperState.chat,
          turns: paperState.chat.turns.map((item) => (
            item.id === turnId
              ? { ...item, action_proposal_id: proposalId }
              : item
          )),
        },
      };
      attached = true;
      return { readings };
    });
    if (!attached) {
      throw actionError("READING_NOTE_PROPOSAL_NOT_ATTACHED", "笔记修改提案未能关联到对话");
    }
    await runStore.appendEvent(runId, {
      type: "reading_note_proposal_created",
      paper_id: paperId,
      turn_id: turnId,
      proposal_id: proposalId,
      proposal_hash: proposal.proposal_hash,
      at: createdAt,
    });
    return {
      proposal: publicProposal(proposal),
      reading: await getPaperReading(runId, paperId),
    };
  }

  function createProposal(runId, paperId, turnId, options = {}) {
    return withProposalCreateLock(
      `${runId}:${paperId}:${turnId}`,
      () => createProposalUnlocked(runId, paperId, turnId, options),
    );
  }

  async function getProposal(runId, paperId, proposalId) {
    assertPaperId(paperId);
    const { proposal } = await loadProposal(runId, paperId, proposalId);
    return {
      proposal: publicProposal(proposal),
      reading: await getPaperReading(runId, paperId),
    };
  }

  async function markFailed(runId, paperId, proposal, artifactPath, error) {
    const failedAt = now().toISOString();
    const failed = {
      ...proposal,
      status: error?.code === "READING_NOTE_TARGET_STALE" ? "conflict" : "failed",
      last_error: safeError(error),
      updated_at: failedAt,
    };
    await persistProposal(runId, paperId, failed, artifactPath);
    await runStore.appendEvent(runId, {
      type: "reading_note_commit_failed",
      paper_id: paperId,
      turn_id: proposal.turn_id,
      proposal_id: proposal.proposal_id,
      error: failed.last_error,
      at: failedAt,
    });
  }

  async function commitProposal(runId, paperId, proposalId, {
    clientRequestId,
    proposalHash,
    contentHash,
    targetVersionOrHash,
  } = {}) {
    assertPaperId(paperId);
    assertRequestId(clientRequestId);
    const loaded = await loadProposal(runId, paperId, proposalId);
    assertBindings(loaded.proposal, { proposalHash, contentHash, targetVersionOrHash });
    return withTargetLock(loaded.proposal.target_locator, async () => {
      let { proposal, artifactPath } = await loadProposal(runId, paperId, proposalId);
      assertBindings(proposal, { proposalHash, contentHash, targetVersionOrHash });
      if (proposal.status === "abandoned") {
        throw actionError("READING_NOTE_PROPOSAL_ABANDONED", "该笔记修改提案已放弃");
      }
      if (proposal.status === "committed") {
        return {
          proposal: publicProposal(proposal),
          reading: await getPaperReading(runId, paperId),
        };
      }

      const approvalFingerprint = sha256({
        client_request_id: clientRequestId,
        proposal_hash: proposalHash,
        content_hash: contentHash,
        target_version_or_hash: targetVersionOrHash,
      });
      if (
        proposal.approval
        && proposal.approval.client_request_id === clientRequestId
        && proposal.approval.request_fingerprint !== approvalFingerprint
      ) {
        throw actionError(
          "READING_NOTE_COMMIT_REQUEST_CONFLICT",
          "同一确认请求标识已用于不同提案版本",
        );
      }
      const approvedAt = proposal.approval?.approved_at ?? now().toISOString();
      const approval = {
        client_request_id: clientRequestId,
        request_fingerprint: approvalFingerprint,
        proposal_hash: proposalHash,
        content_hash: contentHash,
        target_version_or_hash: targetVersionOrHash,
        approved_at: approvedAt,
      };
      const approvalPath =
        `readings/${paperId}/agent-actions/approvals/${proposalId}-${sha256(clientRequestId).slice(7, 23)}.json`;
      await runStore.writeArtifact(runId, approvalPath, {
        schema_version: 1,
        run_id: runId,
        paper_id: paperId,
        proposal_id: proposalId,
        ...approval,
      });
      proposal = {
        ...proposal,
        status: "approved",
        approval,
        approval_artifact_path: approvalPath,
        last_error: null,
        updated_at: approvedAt,
      };
      await persistProposal(runId, paperId, proposal, artifactPath);
      await runStore.appendEvent(runId, {
        type: "reading_note_commit_approved",
        paper_id: paperId,
        turn_id: proposal.turn_id,
        proposal_id: proposalId,
        proposal_hash: proposalHash,
        at: approvedAt,
      });

      try {
        const current = await inspectTarget(proposal.target_locator);
        const markerPresent = current.exists
          && markerCount(current.markdown, proposal.action_marker) === 1;
        if (
          current.current_content_hash === proposal.expected_after_hash
          && markerPresent
        ) {
          // A prior process may have completed the write before persisting verification.
        } else {
          if (current.target_version !== proposal.target_version_or_hash) {
            throw actionError(
              "READING_NOTE_TARGET_STALE",
              "目标笔记在预览后发生变化，未执行写入",
              409,
              true,
            );
          }
          await atomicWrite(proposal.target_locator, proposal.after_markdown, current);
        }
        const verified = await inspectTarget(proposal.target_locator);
        if (
          verified.current_content_hash !== proposal.expected_after_hash
          || markerCount(verified.markdown, proposal.action_marker) !== 1
        ) {
          throw actionError(
            "READING_NOTE_VERIFY_FAILED",
            "笔记写入后的读回校验失败，请人工检查目标文件",
            500,
            true,
          );
        }
        const committedAt = now().toISOString();
        proposal = {
          ...proposal,
          status: "committed",
          last_error: null,
          updated_at: committedAt,
          committed_at: committedAt,
          verified_at: committedAt,
          verified_content_hash: verified.current_content_hash,
        };
        await persistProposal(runId, paperId, proposal, artifactPath);
        await runStore.appendEvent(runId, {
          type: "reading_note_committed",
          paper_id: paperId,
          turn_id: proposal.turn_id,
          proposal_id: proposalId,
          content_hash: proposal.content_hash,
          verified_content_hash: verified.current_content_hash,
          at: committedAt,
        });
        return {
          proposal: publicProposal(proposal),
          reading: await getPaperReading(runId, paperId),
        };
      } catch (error) {
        await markFailed(runId, paperId, proposal, artifactPath, error);
        throw error;
      }
    });
  }

  async function abandonProposal(runId, paperId, proposalId, {
    clientRequestId,
  } = {}) {
    assertPaperId(paperId);
    assertRequestId(clientRequestId);
    const loaded = await loadProposal(runId, paperId, proposalId);
    return withTargetLock(loaded.proposal.target_locator, async () => {
      const { proposal, artifactPath } = await loadProposal(
        runId,
        paperId,
        proposalId,
      );
      if (proposal.status === "committed") {
        throw actionError(
          "READING_NOTE_ALREADY_COMMITTED",
          "笔记修改已经写入，不能再放弃",
        );
      }
      if (proposal.status === "abandoned") {
        if (proposal.abandon_client_request_id !== clientRequestId) {
          throw actionError(
            "READING_NOTE_ABANDON_REQUEST_CONFLICT",
            "该笔记修改提案已由另一请求放弃",
          );
        }
        return {
          proposal: publicProposal(proposal),
          reading: await getPaperReading(runId, paperId),
        };
      }
      if (proposal.status === "approved") {
        throw actionError(
          "READING_NOTE_ALREADY_APPROVED",
          "笔记修改已经确认，不能在写入过程中放弃",
        );
      }
      const abandonedAt = now().toISOString();
      const abandoned = {
        ...proposal,
        status: "abandoned",
        abandon_client_request_id: clientRequestId,
        abandoned_at: abandonedAt,
        updated_at: abandonedAt,
        last_error: null,
      };
      await persistProposal(runId, paperId, abandoned, artifactPath);
      await runStore.appendEvent(runId, {
        type: "reading_note_proposal_abandoned",
        paper_id: paperId,
        turn_id: proposal.turn_id,
        proposal_id: proposalId,
        at: abandonedAt,
      });
      return {
        proposal: publicProposal(abandoned),
        reading: await getPaperReading(runId, paperId),
      };
    });
  }

  return Object.freeze({
    abandonProposal,
    commitProposal,
    createProposal,
    getProposal,
  });
}

export const __test = {
  actionMarkdown,
  canonicalSkeleton,
  identityMarker,
  noteFileName,
  sha256,
};
