import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStore } from "./runStore.js";
import {
  __test as noteTest,
  createReadingNoteActionService,
} from "./readingNoteAction.js";

const PAPER = Object.freeze({
  paper_id: "paper-1",
  dedupe_key: "doi:10.1000/pi-agent",
  title: "A Small Agent for Long-Lived Research Workflows",
  authors: ["Ada Lovelace", "Alan Turing"],
  venue: "Journal of Useful Agents",
  published_at: "2026-07-23",
  doi: "10.1000/pi-agent",
  canonical_url: "https://example.test/paper",
});

const TURN = Object.freeze({
  id: "chat-turn-1",
  client_request_id: "chat-request-1",
  input_hash: `sha256:${"1".repeat(64)}`,
  question: "这段结论对长期项目工作流意味着什么？",
  status: "answered",
  provider_id: "codex-subscription",
  model_id: "account-default",
  created_at: "2026-07-23T00:00:00.000Z",
  answered_at: "2026-07-23T00:00:01.000Z",
});

const ANSWER = "它说明持续保存可核验状态，比每次重新生成完整上下文更适合长期项目。";
const CITATIONS = Object.freeze([
  {
    block_id: "block-1234567890abcdef1234",
    path: ["Discussion", "Implications"],
    ordinal: 12,
    start_offset: 4,
    end_offset: 48,
    quote: "Persistent state reduces repeated reconstruction work.",
    source_hash: `sha256:${"2".repeat(64)}`,
    support: "该段直接说明持久状态能减少重复重建。",
  },
]);

function makeClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 23, 0, 0, tick++));
}

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-reading-note-action-"));
  const dataDir = path.join(root, "data");
  const noteDir = path.join(root, "notes");
  await mkdir(noteDir, { recursive: true });
  const now = makeClock();
  const runStore = createRunStore({
    dataDir,
    now,
    idFactory: () => "11111111-1111-4111-8111-111111111111",
  });
  const created = await runStore.createRun({ sourceIds: ["test-source"] });
  const run = await runStore.updateRun(created.run_id, {
    status: "reading",
    phase: "close_reading",
    paused_reason: "等待继续精读",
    candidates: [PAPER],
    paper_decisions: { [PAPER.paper_id]: "read" },
    readings: {
      schema_version: 1,
      status: "reading",
      paper_ids: [PAPER.paper_id],
      provider_id: "codex-subscription",
      model_id: "account-default",
      papers: {
        [PAPER.paper_id]: {
          status: "reading",
          document_revision: `sha256:${"3".repeat(64)}`,
          current_stage: "method",
          position: {
            mode: "focused",
            block_id: null,
            updated_at: null,
          },
          stages: {
            "research-question": { status: "ready", content_hash: "kept-stage-hash" },
            method: { status: "not_started" },
          },
          questions: [],
          chat: {
            status: "ready",
            turns: [TURN],
            updated_at: TURN.answered_at,
          },
          updated_at: TURN.answered_at,
        },
      },
      last_error: null,
    },
  });
  const getRunPaper = async (runId, paperId) => {
    const current = await runStore.getRun(runId);
    if (!current) throw new Error("run missing");
    const paper = current.candidates.find((item) => item.paper_id === paperId);
    if (!paper) throw new Error("paper missing");
    return { run: current, paper };
  };
  const getPaperReading = async (runId, paperId) => {
    const current = await runStore.getRun(runId);
    const paperState = current.readings.papers[paperId];
    return {
      schema_version: 1,
      run_id: runId,
      paper_id: paperId,
      status: paperState.status,
      current_stage: paperState.current_stage,
      stages: structuredClone(paperState.stages),
      chat: {
        ...structuredClone(paperState.chat),
        turns: paperState.chat.turns.map((turn) => ({
          ...structuredClone(turn),
          answer: turn.status === "answered" ? ANSWER : null,
          citations: turn.status === "answered" ? structuredClone(CITATIONS) : [],
        })),
      },
    };
  };
  const service = createReadingNoteActionService({
    runStore,
    getRunPaper,
    getPaperReading,
    obsidianNoteDir: noteDir,
    now,
  });
  return {
    root,
    dataDir,
    noteDir,
    runStore,
    run,
    service,
    getRunPaper,
    getPaperReading,
  };
}

async function cleanup(context) {
  await rm(context.root, { recursive: true, force: true });
}

function commitBindings(proposal, clientRequestId = "commit-request-1") {
  return {
    clientRequestId,
    proposalHash: proposal.proposal_hash,
    contentHash: proposal.content_hash,
    targetVersionOrHash: proposal.target_version_or_hash,
  };
}

test("answered turn creates an exact proposal and commits a verified managed note", async () => {
  const context = await setup();
  try {
    const before = await context.runStore.getRun(context.run.run_id);
    const protectedState = {
      status: before.status,
      phase: before.phase,
      paused_reason: before.paused_reason,
      reading_status: before.readings.status,
      paper_status: before.readings.papers[PAPER.paper_id].status,
      current_stage: before.readings.papers[PAPER.paper_id].current_stage,
      stages: structuredClone(before.readings.papers[PAPER.paper_id].stages),
    };

    const [created, concurrentRepeat] = await Promise.all([
      context.service.createProposal(
        context.run.run_id,
        PAPER.paper_id,
        TURN.id,
        { clientRequestId: "proposal-request-1" },
      ),
      context.service.createProposal(
        context.run.run_id,
        PAPER.paper_id,
        TURN.id,
        { clientRequestId: "proposal-request-1" },
      ),
    ]);
    const proposal = created.proposal;
    assert.equal(concurrentRepeat.proposal.proposal_id, proposal.proposal_id);
    assert.equal(proposal.status, "draft");
    assert.equal(proposal.operation_label, "新建受管论文笔记");
    assert.equal(
      proposal.target_locator,
      path.join(await realpath(context.noteDir), noteTest.noteFileName(PAPER)),
    );
    await assert.rejects(readFile(proposal.target_locator, "utf8"), { code: "ENOENT" });
    assert.match(proposal.diff.after, /pi-agent:paper-note:v1:/);
    assert.match(proposal.diff.after, /pi-agent:workflow:start/);
    assert.match(proposal.diff.after, /这段结论对长期项目工作流意味着什么/);
    assert.match(proposal.diff.after, /block-1234567890abcdef1234/);

    const afterProposal = await context.runStore.getRun(context.run.run_id);
    assert.deepEqual({
      status: afterProposal.status,
      phase: afterProposal.phase,
      paused_reason: afterProposal.paused_reason,
      reading_status: afterProposal.readings.status,
      paper_status: afterProposal.readings.papers[PAPER.paper_id].status,
      current_stage: afterProposal.readings.papers[PAPER.paper_id].current_stage,
      stages: afterProposal.readings.papers[PAPER.paper_id].stages,
    }, protectedState);
    assert.equal(
      afterProposal.readings.papers[PAPER.paper_id].chat.turns[0].action_proposal_id,
      proposal.proposal_id,
    );

    const repeated = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      TURN.id,
      { clientRequestId: "proposal-request-1" },
    );
    assert.equal(repeated.proposal.proposal_id, proposal.proposal_id);
    await assert.rejects(
      context.service.createProposal(
        context.run.run_id,
        PAPER.paper_id,
        TURN.id,
        { clientRequestId: "proposal-request-other" },
      ),
      { code: "READING_NOTE_TURN_ALREADY_PROPOSED" },
    );
    await assert.rejects(
      context.service.commitProposal(
        context.run.run_id,
        PAPER.paper_id,
        proposal.proposal_id,
        { ...commitBindings(proposal), proposalHash: `sha256:${"0".repeat(64)}` },
      ),
      { code: "READING_NOTE_BINDING_MISMATCH" },
    );

    const committed = await context.service.commitProposal(
      context.run.run_id,
      PAPER.paper_id,
      proposal.proposal_id,
      commitBindings(proposal),
    );
    assert.equal(committed.proposal.status, "committed");
    assert.equal(committed.proposal.expected_after_hash, committed.proposal.verified_at
      ? noteTest.sha256(await readFile(proposal.target_locator, "utf8"))
      : null);
    const markdown = await readFile(proposal.target_locator, "utf8");
    assert.equal(markdown, proposal.diff.after);
    assert.match(markdown, /pi-agent:paper-note:v1:/);
    assert.match(markdown, /pi-agent:workflow:start/);
    assert.match(markdown, /pi-agent:agent-notes:start/);
    assert.equal(markdown.split(proposal.action_marker).length - 1, 1);

    const retried = await context.service.commitProposal(
      context.run.run_id,
      PAPER.paper_id,
      proposal.proposal_id,
      commitBindings(proposal),
    );
    assert.equal(retried.proposal.status, "committed");
    const afterRetry = await readFile(proposal.target_locator, "utf8");
    assert.equal(afterRetry.split(proposal.action_marker).length - 1, 1);

    const proposalArtifact = await context.runStore.readArtifact(
      context.run.run_id,
      `readings/${PAPER.paper_id}/agent-actions/proposals/${proposal.proposal_id}.json`,
    );
    assert.equal(proposalArtifact.approval.client_request_id, "commit-request-1");
    const approvalArtifact = await context.runStore.readArtifact(
      context.run.run_id,
      proposalArtifact.approval_artifact_path,
    );
    assert.equal(approvalArtifact.proposal_hash, proposal.proposal_hash);
    assert.equal(approvalArtifact.target_version_or_hash, proposal.target_version_or_hash);

    const afterCommit = await context.runStore.getRun(context.run.run_id);
    assert.deepEqual({
      status: afterCommit.status,
      phase: afterCommit.phase,
      paused_reason: afterCommit.paused_reason,
      reading_status: afterCommit.readings.status,
      paper_status: afterCommit.readings.papers[PAPER.paper_id].status,
      current_stage: afterCommit.readings.papers[PAPER.paper_id].current_stage,
      stages: afterCommit.readings.papers[PAPER.paper_id].stages,
    }, protectedState);
  } finally {
    await cleanup(context);
  }
});

test("abandon is persistent and never writes the target", async () => {
  const context = await setup();
  try {
    const { proposal } = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      TURN.id,
      { clientRequestId: "proposal-abandon" },
    );
    const abandoned = await context.service.abandonProposal(
      context.run.run_id,
      PAPER.paper_id,
      proposal.proposal_id,
      { clientRequestId: "abandon-request-1" },
    );
    assert.equal(abandoned.proposal.status, "abandoned");
    const repeated = await context.service.abandonProposal(
      context.run.run_id,
      PAPER.paper_id,
      proposal.proposal_id,
      { clientRequestId: "abandon-request-1" },
    );
    assert.equal(repeated.proposal.status, "abandoned");
    await assert.rejects(readFile(proposal.target_locator, "utf8"), { code: "ENOENT" });
    await assert.rejects(
      context.service.commitProposal(
        context.run.run_id,
        PAPER.paper_id,
        proposal.proposal_id,
        commitBindings(proposal),
      ),
      { code: "READING_NOTE_PROPOSAL_ABANDONED" },
    );
    const regenerated = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      TURN.id,
      { clientRequestId: "proposal-regenerated" },
    );
    assert.notEqual(regenerated.proposal.proposal_id, proposal.proposal_id);
    assert.equal(regenerated.proposal.status, "draft");
    const regeneratedRun = await context.runStore.getRun(context.run.run_id);
    assert.equal(
      regeneratedRun.readings.papers[PAPER.paper_id].chat.turns[0].action_proposal_id,
      regenerated.proposal.proposal_id,
    );
  } finally {
    await cleanup(context);
  }
});

test("an unmanaged existing file is rejected without modification", async () => {
  const context = await setup();
  try {
    const targetPath = path.join(context.noteDir, noteTest.noteFileName(PAPER));
    const original = "# My existing note\n\nDo not touch.\n";
    await writeFile(targetPath, original, "utf8");
    await assert.rejects(
      context.service.createProposal(
        context.run.run_id,
        PAPER.paper_id,
        TURN.id,
        { clientRequestId: "proposal-unmanaged" },
      ),
      { code: "OBSIDIAN_NOTE_UNMANAGED" },
    );
    assert.equal(await readFile(targetPath, "utf8"), original);
    const current = await context.runStore.getRun(context.run.run_id);
    assert.equal(
      current.readings.papers[PAPER.paper_id].agent_actions,
      undefined,
    );
  } finally {
    await cleanup(context);
  }
});

test("commit persists approval but refuses a target changed after preview", async () => {
  const context = await setup();
  try {
    const { proposal } = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      TURN.id,
      { clientRequestId: "proposal-stale" },
    );
    const external = "# A file created after preview\n";
    await writeFile(proposal.target_locator, external, "utf8");
    await assert.rejects(
      context.service.commitProposal(
        context.run.run_id,
        PAPER.paper_id,
        proposal.proposal_id,
        commitBindings(proposal),
      ),
      { code: "READING_NOTE_TARGET_STALE" },
    );
    assert.equal(await readFile(proposal.target_locator, "utf8"), external);
    const artifact = await context.runStore.readArtifact(
      context.run.run_id,
      `readings/${PAPER.paper_id}/agent-actions/proposals/${proposal.proposal_id}.json`,
    );
    assert.equal(artifact.status, "conflict");
    assert.equal(artifact.last_error.code, "READING_NOTE_TARGET_STALE");
    assert.equal(artifact.approval.client_request_id, "commit-request-1");
    const approval = await context.runStore.readArtifact(
      context.run.run_id,
      artifact.approval_artifact_path,
    );
    assert.equal(approval.proposal_id, proposal.proposal_id);
  } finally {
    await cleanup(context);
  }
});

test("a second answered turn appends only inside the managed Agent region", async () => {
  const context = await setup();
  try {
    const first = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      TURN.id,
      { clientRequestId: "proposal-first" },
    );
    await context.service.commitProposal(
      context.run.run_id,
      PAPER.paper_id,
      first.proposal.proposal_id,
      commitBindings(first.proposal, "commit-first"),
    );
    const secondTurn = {
      ...TURN,
      id: "chat-turn-2",
      client_request_id: "chat-request-2",
      input_hash: `sha256:${"4".repeat(64)}`,
      question: "第二个问题",
    };
    await context.runStore.updateRun(context.run.run_id, (current) => {
      const readings = structuredClone(current.readings);
      const paperState = readings.papers[PAPER.paper_id];
      paperState.chat.turns.push(secondTurn);
      return { readings };
    });
    const second = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      secondTurn.id,
      { clientRequestId: "proposal-second" },
    );
    assert.equal(second.proposal.operation_label, "追加 Agent 对话笔记");
    await context.service.commitProposal(
      context.run.run_id,
      PAPER.paper_id,
      second.proposal.proposal_id,
      commitBindings(second.proposal, "commit-second"),
    );
    const markdown = await readFile(first.proposal.target_locator, "utf8");
    assert.equal(markdown.split(first.proposal.action_marker).length - 1, 1);
    assert.equal(markdown.split(second.proposal.action_marker).length - 1, 1);
    assert.equal(markdown.split("<!-- pi-agent:workflow:start -->").length - 1, 1);
    assert.equal(markdown.split("<!-- pi-agent:agent-notes:start -->").length - 1, 1);
  } finally {
    await cleanup(context);
  }
});

test("two service instances serialize commits targeting the same missing note", async () => {
  const context = await setup();
  try {
    const first = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      TURN.id,
      { clientRequestId: "proposal-concurrent-first" },
    );
    const secondTurn = {
      ...TURN,
      id: "chat-turn-concurrent-2",
      client_request_id: "chat-request-concurrent-2",
      input_hash: `sha256:${"5".repeat(64)}`,
      question: "并发的第二个问题",
    };
    await context.runStore.updateRun(context.run.run_id, (current) => {
      const readings = structuredClone(current.readings);
      readings.papers[PAPER.paper_id].chat.turns.push(secondTurn);
      return { readings };
    });
    const second = await context.service.createProposal(
      context.run.run_id,
      PAPER.paper_id,
      secondTurn.id,
      { clientRequestId: "proposal-concurrent-second" },
    );
    const otherInstance = createReadingNoteActionService({
      runStore: context.runStore,
      getRunPaper: context.getRunPaper,
      getPaperReading: context.getPaperReading,
      obsidianNoteDir: context.noteDir,
      now: makeClock(),
    });
    const results = await Promise.allSettled([
      context.service.commitProposal(
        context.run.run_id,
        PAPER.paper_id,
        first.proposal.proposal_id,
        commitBindings(first.proposal, "commit-concurrent-first"),
      ),
      otherInstance.commitProposal(
        context.run.run_id,
        PAPER.paper_id,
        second.proposal.proposal_id,
        commitBindings(second.proposal, "commit-concurrent-second"),
      ),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "READING_NOTE_TARGET_STALE");
    const markdown = await readFile(first.proposal.target_locator, "utf8");
    const presentMarkers = [first.proposal.action_marker, second.proposal.action_marker]
      .filter((marker) => markdown.includes(marker));
    assert.equal(presentMarkers.length, 1);
  } finally {
    await cleanup(context);
  }
});
