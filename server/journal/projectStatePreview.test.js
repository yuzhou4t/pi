import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { READING_STAGE_ORDER } from "./readingGenerator.js";
import {
  __test,
  createProjectStatePreviewService,
} from "./projectStatePreview.js";
import { createRunStore } from "./runStore.js";

const paper = {
  paper_id: "paper-project-state",
  title: "Bounded Project-State Updates",
  authors: ["Ada Author"],
  venue: "AAAI",
  published_at: "2026-07-01",
  doi: "10.1234/project.state",
  canonical_url: "https://example.com/project-state",
};

const DEFAULT_STATE_CONTENT = "# 项目状态\n\n## 当前状态\n\n保持稳定。\n";

function relationEvidence() {
  return {
    block_id: "block-00000000000000000004",
    path: ["Discussion", "Project implications"],
    ordinal: 4,
    excerpt: "Evidence-grounded workflow updates remain reviewable.",
    support: "该段支持把项目影响保留为带来源的候选更新。",
  };
}

function reading(runId, {
  projectContextRevision = __test.sha256(DEFAULT_STATE_CONTENT),
  ...overrides
} = {}) {
  return {
    schema_version: 1,
    run_id: runId,
    paper_id: paper.paper_id,
    status: "complete",
    document_revision: "sha256:reading-document",
    current_stage: "project-relation",
    stage_order: [...READING_STAGE_ORDER],
    stages: Object.fromEntries(
      READING_STAGE_ORDER.map((stage, index) => [stage, {
        status: "ready",
        content_hash: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`,
        result: {
          answer: stage === "project-relation"
            ? "把项目状态更新收敛为带证据、可确认、可重复检查的追加建议。"
            : `${stage} answer`,
          evidence: stage === "project-relation" ? [relationEvidence()] : [],
          open_questions: stage === "project-relation"
            ? ["如何验证长期运行后不会积累重复结论？"]
            : [],
        },
        provenance: stage === "project-relation"
          ? { project_context_revision: projectContextRevision }
          : null,
      }]),
    ),
    questions: [],
    ...overrides,
  };
}

async function setup({
  runStatus = "draft_ready",
  decisions = { [paper.paper_id]: "read" },
  readingFactory = reading,
  stateContent = DEFAULT_STATE_CONTENT,
  projectStatePath = "state/project-state.md",
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-project-state-preview-"));
  const projectRoot = path.join(dataDir, "project");
  const targetPath = path.resolve(projectRoot, projectStatePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stateContent, "utf8");
  const runStore = createRunStore({
    dataDir,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
    idFactory: () => "12345678-aaaa-bbbb-cccc-dddddddddddd",
  });
  const created = await runStore.createRun();
  await runStore.updateRun(created.run_id, {
    status: runStatus,
    phase: "write_preview",
    candidates: [paper],
    paper_decisions: decisions,
    readings: {
      schema_version: 1,
      status: "ready_for_preview",
      paper_ids: decisions[paper.paper_id] === "read" ? [paper.paper_id] : [],
      papers: decisions[paper.paper_id] === "read"
        ? {
            [paper.paper_id]: {
              status: "complete",
              document_revision: "sha256:reading-document",
              stages: Object.fromEntries(
                READING_STAGE_ORDER.map((stage, index) => [stage, {
                  status: "ready",
                  content_hash: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`,
                }]),
              ),
            },
          }
        : {},
    },
    obsidian: {
      schema_version: 1,
      status: "preview_ready",
      proposals: decisions[paper.paper_id] === "read"
        ? [{
            proposal_id: "obsidian-preview-1",
            paper_id: paper.paper_id,
            target: "obsidian",
            target_locator: "/vault/论文精读/2026-Ada-Bounded-Project-State.md",
            target_details: {
              file_name: "2026-Ada-Bounded-Project-State.md",
            },
            content_hash: `sha256:${"a".repeat(64)}`,
          }]
        : [],
    },
  });
  const calls = [];
  const getPaperReading = async (runId, paperId) => {
    calls.push({ runId, paperId });
    return readingFactory === reading
      ? reading(runId, { projectContextRevision: __test.sha256(stateContent) })
      : readingFactory(runId);
  };
  const service = createProjectStatePreviewService({
    runStore,
    getPaperReading,
    projectRoot,
    projectStatePath,
    now: () => new Date("2026-07-23T09:00:00.000Z"),
  });
  return {
    calls,
    dataDir,
    projectRoot,
    projectStatePath,
    runId: created.run_id,
    runStore,
    service,
    stateContent,
    targetPath,
  };
}

test("creates a deterministic exact append preview without writing the project-state target", async () => {
  const context = await setup();

  const first = await context.service.createPreview(context.runId);
  const proposal = first.proposal;
  assert.equal(first.status, "preview_ready");
  assert.equal(first.write_capability, "hash_bound_commit");
  assert.equal(first.external_write_performed, false);
  assert.equal(first.run_status, "draft_ready");
  assert.equal(context.calls.length, 1);
  assert.equal(proposal.target, "project_state");
  assert.equal(proposal.operation, "append");
  assert.equal(proposal.write_mode, "append_after_approval");
  assert.equal(proposal.actionable, true);
  assert.equal(proposal.selected, true);
  assert.equal(proposal.diff.mode, "append");
  assert.equal(proposal.diff.append_offset_chars, context.stateContent.length);
  assert.equal(
    proposal.diff.append_offset_bytes,
    Buffer.byteLength(context.stateContent, "utf8"),
  );
  assert.equal(
    proposal.diff.before_hash,
    __test.sha256(context.stateContent),
  );
  assert.equal(
    proposal.diff.after_hash,
    __test.sha256(`${context.stateContent}${proposal.diff.append_text}`),
  );
  assert.equal(proposal.content_hash, __test.sha256(proposal.markdown));
  assert.match(proposal.markdown, /### 项目影响/);
  assert.match(proposal.markdown, /### 开放问题/);
  assert.match(proposal.markdown, /Bounded Project-State Updates/);
  assert.match(proposal.markdown, /`block-00000000000000000004`/);
  assert.match(proposal.markdown, /Discussion › Project implications/);
  assert.match(proposal.markdown, /`journal-/);
  assert.match(
    proposal.markdown,
    /\[\[2026-Ada-Bounded-Project-State\]\]/,
  );
  assert.match(
    proposal.markdown,
    new RegExp(__test.runMarker(context.runId).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(await readFile(context.targetPath, "utf8"), context.stateContent);

  assert.equal(
    await context.runStore.readArtifact(context.runId, proposal.markdown_artifact_path),
    proposal.markdown,
  );
  const storedArtifact = await context.runStore.readArtifact(
    context.runId,
    first.artifact_path,
  );
  assert.equal(storedArtifact.proposal_hash, first.proposal_hash);
  const storedRun = await context.runStore.getRun(context.runId);
  assert.equal(storedRun.status, "draft_ready");
  assert.equal(storedRun.phase, "write_preview");
  assert.equal(storedRun.project_state.status, "preview_ready");
  assert.equal(storedRun.project_state.approval, null);

  const restored = await context.service.getPreview(context.runId);
  assert.equal(restored.proposal_hash, first.proposal_hash);
  assert.equal(restored.proposal.diff.append_text, proposal.diff.append_text);

  const second = await context.service.createPreview(context.runId);
  assert.equal(second.proposal_hash, first.proposal_hash);
  assert.equal(second.proposal.proposal_id, proposal.proposal_id);
  assert.equal(second.proposal.diff.after_hash, proposal.diff.after_hash);
  assert.equal(await readFile(context.targetPath, "utf8"), context.stateContent);
});

test("commits the exact project-state append once and verifies it on read-back", async () => {
  const context = await setup();
  await chmod(context.targetPath, 0o640);
  const preview = await context.service.createPreview(context.runId);
  const proposal = preview.proposal;
  const approval = {
    clientRequestId: "project-state-approval-1",
    proposalHash: preview.proposal_hash,
    operation: {
      proposal_id: proposal.proposal_id,
      content_hash: proposal.content_hash,
      target_version_or_hash: proposal.target_version_or_hash,
    },
  };

  const committed = await context.service.commit(context.runId, approval);
  const expected = `${context.stateContent}${proposal.diff.append_text}`;
  assert.equal(await readFile(context.targetPath, "utf8"), expected);
  assert.equal(committed.project_state.status, "completed");
  assert.ok(committed.project_state.verified_at);
  assert.equal((await stat(context.targetPath)).mode & 0o777, 0o640);

  const idempotent = await context.service.commit(context.runId, {
    ...approval,
    clientRequestId: "project-state-approval-2",
  });
  assert.equal(idempotent.project_state.status, "completed");
  assert.equal(await readFile(context.targetPath, "utf8"), expected);
});

test("refuses a project-state commit after the target changes", async () => {
  const context = await setup();
  const preview = await context.service.createPreview(context.runId);
  const proposal = preview.proposal;
  const changed = `${context.stateContent}\n## 用户修改\n\n保留我。\n`;
  await writeFile(context.targetPath, changed, "utf8");

  await assert.rejects(
    context.service.commit(context.runId, {
      clientRequestId: "project-state-stale-1",
      proposalHash: preview.proposal_hash,
      operation: {
        proposal_id: proposal.proposal_id,
        content_hash: proposal.content_hash,
        target_version_or_hash: proposal.target_version_or_hash,
      },
    }),
    (error) => error.code === "PROJECT_STATE_PREVIEW_STALE",
  );
  assert.equal(await readFile(context.targetPath, "utf8"), changed);
});

test("refuses a tampered project-state preview artifact before writing", async () => {
  const context = await setup();
  const preview = await context.service.createPreview(context.runId);
  const proposal = preview.proposal;
  const tamperedMarkdown = `${proposal.markdown}\n篡改内容\n`;
  const tamperedAppend = `${proposal.diff.append_text}\n篡改内容\n`;
  await context.runStore.writeArtifact(context.runId, preview.artifact_path, {
    ...preview,
    proposal: {
      ...proposal,
      markdown: tamperedMarkdown,
      content_hash: __test.sha256(tamperedMarkdown),
      diff: {
        ...proposal.diff,
        append_text: tamperedAppend,
        after_hash: __test.sha256(`${context.stateContent}${tamperedAppend}`),
      },
    },
  });

  await assert.rejects(
    context.service.commit(context.runId, {
      clientRequestId: "project-state-tampered-artifact",
      proposalHash: preview.proposal_hash,
      operation: {
        proposal_id: proposal.proposal_id,
        content_hash: proposal.content_hash,
        target_version_or_hash: proposal.target_version_or_hash,
      },
    }),
    (error) => error.code === "PROJECT_STATE_PREVIEW_STALE",
  );
  assert.equal(
    await readFile(context.targetPath, "utf8"),
    context.stateContent,
  );
});

test("requires draft_ready, an authoritative read decision, and all four completed stages", async () => {
  const wrongStatus = await setup({ runStatus: "reading" });
  await assert.rejects(
    wrongStatus.service.createPreview(wrongStatus.runId),
    (error) => error.code === "PROJECT_STATE_PREVIEW_NOT_ALLOWED",
  );
  assert.equal(wrongStatus.calls.length, 0);

  const collectOnly = await setup({
    decisions: { [paper.paper_id]: "collect" },
  });
  await assert.rejects(
    collectOnly.service.createPreview(collectOnly.runId),
    (error) => error.code === "PROJECT_STATE_NOT_REQUIRED",
  );
  assert.equal(collectOnly.calls.length, 0);

  const incomplete = await setup({
    readingFactory: (runId) => {
      const result = reading(runId);
      result.stages.evidence.status = "not_started";
      return result;
    },
  });
  await assert.rejects(
    incomplete.service.createPreview(incomplete.runId),
    (error) => error.code === "PROJECT_STATE_READING_NOT_READY",
  );
});

test("rejects target traversal, non-Markdown files, and symbolic-link targets", async () => {
  const traversal = await setup();
  const outsidePath = path.join(traversal.dataDir, "outside.md");
  await writeFile(outsidePath, "# Outside\n", "utf8");
  const traversalService = createProjectStatePreviewService({
    runStore: traversal.runStore,
    getPaperReading: async (runId) => reading(runId),
    projectRoot: traversal.projectRoot,
    projectStatePath: "../outside.md",
  });
  await assert.rejects(
    traversalService.createPreview(traversal.runId),
    (error) => error.code === "PROJECT_STATE_TARGET_OUT_OF_SCOPE",
  );
  assert.equal(await readFile(outsidePath, "utf8"), "# Outside\n");

  const nonMarkdown = await setup({ projectStatePath: "state.txt" });
  await assert.rejects(
    nonMarkdown.service.createPreview(nonMarkdown.runId),
    (error) => error.code === "PROJECT_STATE_TARGET_OUT_OF_SCOPE",
  );

  const symbolic = await setup();
  const realTarget = path.join(symbolic.projectRoot, "real-state.md");
  const linkTarget = path.join(symbolic.projectRoot, "state-link.md");
  await writeFile(realTarget, "# Real\n", "utf8");
  await symlink(realTarget, linkTarget);
  const symbolicService = createProjectStatePreviewService({
    runStore: symbolic.runStore,
    getPaperReading: async (runId) => reading(runId),
    projectRoot: symbolic.projectRoot,
    projectStatePath: "state-link.md",
  });
  await assert.rejects(
    symbolicService.createPreview(symbolic.runId),
    (error) => error.code === "PROJECT_STATE_TARGET_OUT_OF_SCOPE",
  );
  assert.equal(await readFile(realTarget, "utf8"), "# Real\n");
});

test("an existing run marker persists a blocked non-actionable preview and is never appended again", async () => {
  const base = await setup();
  const marker = __test.runMarker(base.runId);
  const content = `# 项目状态\n\n${marker}\n\n## 既有更新\n\n保留。\n`;
  await writeFile(base.targetPath, content, "utf8");
  const service = createProjectStatePreviewService({
    runStore: base.runStore,
    getPaperReading: async (runId) => reading(runId, {
      projectContextRevision: __test.sha256(content),
    }),
    projectRoot: base.projectRoot,
    projectStatePath: base.projectStatePath,
  });

  const result = await service.createPreview(base.runId, {
    targetPath: path.join(base.dataDir, "redirect.md"),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.proposal.actionable, false);
  assert.equal(result.proposal.selected, false);
  assert.equal(result.proposal.status, "blocked");
  assert.equal(result.proposal.write_mode, "blocked_existing_run");
  assert.equal(result.proposal.diff.mode, "blocked_existing_run_marker");
  assert.equal(result.proposal.diff.append_text, null);
  assert.equal(result.proposal.diff.before_hash, __test.sha256(content));
  assert.equal(result.proposal.diff.after_hash, result.proposal.diff.before_hash);
  assert.equal(await readFile(base.targetPath, "utf8"), content);
  const storedRun = await base.runStore.getRun(base.runId);
  assert.equal(storedRun.status, "draft_ready");
  assert.equal(storedRun.project_state.status, "blocked");
  const restored = await service.getPreview(base.runId);
  assert.equal(restored.status, "blocked");
});

test("a project-state change after project-relation invalidates the preview", async () => {
  const context = await setup();
  await writeFile(
    context.targetPath,
    `${context.stateContent}\n## 用户刚刚修改\n\n保持这段。\n`,
    "utf8",
  );
  await assert.rejects(
    context.service.createPreview(context.runId),
    (error) => error.code === "PROJECT_STATE_CONTEXT_STALE",
  );
});

test("bounds reused project-relation output and never invokes a model dependency", async () => {
  const context = await setup({
    readingFactory: (runId) => {
      const result = reading(runId);
      result.stages["project-relation"].result.answer = "影响".repeat(10_000);
      result.stages["project-relation"].result.open_questions = Array.from(
        { length: 100 },
        (_, index) => `问题 ${index} ${"很长".repeat(500)}`,
      );
      return result;
    },
  });

  const result = await context.service.createPreview(context.runId);
  assert.equal(result.proposal.markdown.length <= 14_000, true);
  assert.match(result.proposal.markdown, /内容已按项目状态预览上限截断/);
  assert.equal(
    (result.proposal.markdown.match(/^- \[ \]/gm) ?? []).length,
    6,
  );
  assert.equal(context.calls.length, 1);
});
