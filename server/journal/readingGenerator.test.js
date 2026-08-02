import assert from "node:assert/strict";
import test from "node:test";
import {
  generateReadingFollowUp,
  generateReadingStage,
  ReadingGeneratorError,
  READING_STAGE_ORDER,
} from "./readingGenerator.js";

const paper = {
  paper_id: "paper-reading-1",
  title: "A Workflow-Informed Agent",
  authors: ["Ada Author"],
  venue: "AAAI",
  published_at: "2026-07-01",
};

const stagePromptVersions = {
  "research-question": "research-question.v2",
  method: "method.v3",
  evidence: "evidence.v3",
  "project-relation": "project-relation.v3",
};

function document() {
  const names = [
    "Abstract",
    "Introduction",
    "Method",
    "Planning Framework",
    "Experimental Setup",
    "Main Results",
    "Limitations",
  ];
  const sections = names.map((title, index) => ({
    section_id: `section-${index}`,
    path: [title],
    title,
    level: 2,
  }));
  const blocks = Array.from({ length: 42 }, (_, index) => {
    const section = sections[index % sections.length];
    return {
      block_id: `block-${(index + 1).toString(16).padStart(20, "0")}`,
      section_id: section.section_id,
      path: section.path,
      kind: index % 11 === 0 ? "table" : "text",
      text: `${section.title} evidence paragraph ${index + 1} with bounded content.`,
      markdown: `${section.title} evidence paragraph ${index + 1} with bounded content.`,
    };
  });
  return {
    title: paper.title,
    revision: "sha256:document-reading-1",
    sections,
    blocks,
  };
}

function modelResult(stage, locator, overrides = {}) {
  return {
    paper_id: paper.paper_id,
    stage,
    answer: "这是一段经过论文证据约束的中文阶段解释，明确区分已支持判断与待核验内容。",
    evidence: [{
      locator,
      support: "该段直接支持当前阶段的核心判断。",
    }],
    open_questions: ["附录中的失败案例仍需核验。"],
    ...overrides,
  };
}

test("every reading stage uses a bounded input and only project-relation receives project context", async () => {
  for (const stage of READING_STAGE_ORDER) {
    let request;
    const result = await generateReadingStage({
      paper,
      stage,
      document: document(),
      previousStages: stage === "project-relation"
        ? READING_STAGE_ORDER.slice(0, 3).map((previousStage) => modelResult(
            previousStage,
            "block-00000000000000000001",
          ))
        : [],
      projectContext: {
        source_path: "PRODUCT_MEETING.md",
        revision: "sha256:project-state",
        content: "项目以长期工作流和精确写入确认作为当前约束。",
      },
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      modelProviders: {
        completeStructured: async (value) => {
          request = value;
          return {
            value: modelResult(stage, value.input.document.blocks[0].block_id),
            provider_id: "deepseek",
            model_id: "deepseek-v4-flash",
            operation_id: `operation-${stage}`,
            upstream_request_id: `request-${stage}`,
            usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
          };
        },
      },
    });

    assert.equal(request.input.stage, stage);
    assert.equal(request.input.document.blocks.length <= 24, true);
    assert.equal(JSON.stringify(request.input).length < 30_000, true);
    assert.equal(
      Object.hasOwn(request.input, "project_context"),
      stage === "project-relation",
    );
    assert.equal(request.input.document.page_mapping_available, false);
    assert.equal(result.result.stage, stage);
    assert.equal(result.prompt_version, stagePromptVersions[stage]);
    assert.match(result.input_hash, /^sha256:/);
    assert.equal(result.document_revision, document().revision);
    assert.equal(
      result.project_context_revision,
      stage === "project-relation" ? "sha256:project-state" : null,
    );
  }
});

test("answered prior-stage interventions are kept recent and bounded in model input", async () => {
  let request;
  const interventions = Array.from({ length: 4 }, (_, index) => ({
    question: `Q${index + 1}-${"问".repeat(900)}`,
    answer: `A${index + 1}-${"答".repeat(1_500)}`,
    evidence: Array.from({ length: 5 }, (__, evidenceIndex) => ({
      locator: `block-${(evidenceIndex + 1).toString(16).padStart(20, "0")}`,
      support: `S${evidenceIndex + 1}-${"证".repeat(500)}`,
    })),
  }));
  const result = await generateReadingStage({
    paper,
    stage: "method",
    document: document(),
    previousStages: [{
      ...modelResult("research-question", "block-00000000000000000001"),
      interventions,
    }],
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async (value) => {
        request = value;
        return {
          value: modelResult("method", value.input.document.blocks[0].block_id),
        };
      },
    },
  });

  const bounded = request.input.previous_stages[0].interventions;
  assert.equal(result.prompt_version, "method.v3");
  assert.equal(bounded.length, 2);
  assert.match(bounded[0].question, /^Q3-/);
  assert.match(bounded[1].question, /^Q4-/);
  assert.equal(bounded[0].question.length, 500);
  assert.equal(bounded[0].answer.length, 1_000);
  assert.equal(bounded[0].evidence.length, 3);
  assert.equal(bounded[0].evidence[0].support.length, 300);
  assert.match(request.prompt, /previous_stages\[\]\.interventions/);
  assert.equal(JSON.stringify(request.input).length < 35_000, true);
});

test("fixture stages are deterministic, cited, and project relation requires bounded project state", async () => {
  const first = await generateReadingStage({
    paper,
    stage: "method",
    document: document(),
    modelMode: "fixture",
  });
  const second = await generateReadingStage({
    paper,
    stage: "method",
    document: document(),
    modelMode: "fixture",
  });

  assert.deepEqual(first, second);
  assert.equal(first.source, "fixture");
  assert.equal(first.result.evidence.length > 0, true);
  assert.equal(first.result.evidence.every((item) => (
    document().blocks.some((block) => block.block_id === item.locator)
  )), true);

  await assert.rejects(generateReadingStage({
    paper,
    stage: "project-relation",
    document: document(),
    modelMode: "fixture",
  }), (error) => (
    error instanceof ReadingGeneratorError
    && error.code === "READING_INPUT_INVALID"
  ));
});

test("model output rejects unknown and duplicate block references", async () => {
  async function rejects(valueFactory) {
    await assert.rejects(generateReadingStage({
      paper,
      stage: "evidence",
      document: document(),
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      modelProviders: {
        completeStructured: async ({ input }) => ({
          value: valueFactory(input),
        }),
      },
    }), (error) => (
      error instanceof ReadingGeneratorError
      && error.code === "READING_OUTPUT_INVALID"
      && error.status === 502
      && error.retryable
    ));
  }

  await rejects(() => modelResult("evidence", "block-ffffffffffffffffffff"));
  await rejects((input) => modelResult("evidence", input.document.blocks[0].block_id, {
    evidence: [
      {
        locator: input.document.blocks[0].block_id,
        support: "第一条证据。",
      },
      {
        locator: input.document.blocks[0].block_id,
        support: "重复证据。",
      },
    ],
  }));
  await rejects((input) => modelResult("method", input.document.blocks[0].block_id));
});

test("follow-up keeps the current paper and stage, persists the question in bounded model input", async () => {
  let request;
  const stageResult = await generateReadingStage({
    paper,
    stage: "research-question",
    document: document(),
    modelMode: "fixture",
  });
  const followUp = await generateReadingFollowUp({
    paper,
    stage: "research-question",
    document: document(),
    currentStage: stageResult.result,
    question: "作者真正解决的是搜索空间问题，还是工作流知识质量问题？",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async (value) => {
        request = value;
        return {
          value: modelResult(
            "research-question",
            value.input.document.blocks[0].block_id,
          ),
        };
      },
    },
  });

  assert.equal(request.input.follow_up.question.includes("搜索空间"), true);
  assert.equal(request.input.follow_up.current_stage.paper_id, paper.paper_id);
  assert.equal(followUp.prompt_id, "reading-follow-up");
  assert.equal(followUp.prompt_version, "reading-follow-up.v1");
  assert.equal(followUp.result.stage, "research-question");
});

test("invalid documents and unsupported stages fail before a model call", async () => {
  let calls = 0;
  const duplicate = document();
  duplicate.blocks[1].block_id = duplicate.blocks[0].block_id;

  await assert.rejects(generateReadingStage({
    paper,
    stage: "method",
    document: duplicate,
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => {
        calls += 1;
      },
    },
  }), (error) => (
    error instanceof ReadingGeneratorError
    && error.code === "READING_INPUT_INVALID"
  ));
  await assert.rejects(generateReadingStage({
    paper,
    stage: "unknown-stage",
    document: document(),
    modelProviders: {
      completeStructured: async () => {
        calls += 1;
      },
    },
  }), (error) => error.code === "READING_INPUT_INVALID");
  assert.equal(calls, 0);
});
