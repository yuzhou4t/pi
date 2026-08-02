import assert from "node:assert/strict";
import test from "node:test";
import {
  GuideGeneratorError,
  generateFiveMinuteGuide,
} from "./guideGenerator.js";

const paper = {
  paper_id: "paper-1",
  title: "A Bounded Agent Workflow",
  authors: ["Ada Author"],
  venue: "JMLR",
  published_at: "2026-07-01",
};

function document(blockCount = 6) {
  const sectionNames = ["Abstract", "Method", "Results", "Limitations"];
  const sections = [
    {
      section_id: "section-root",
      path: [],
      title: null,
      level: 0,
    },
    ...sectionNames.map((title, index) => ({
      section_id: `section-${index + 1}`,
      path: [title],
      title,
      level: 2,
    })),
  ];
  const blocks = Array.from({ length: blockCount }, (_, index) => {
    const sectionIndex = index % sectionNames.length;
    const section = sections[sectionIndex + 1];
    return {
      block_id: `block-${String(index + 1).padStart(20, "0")}`,
      section_id: section.section_id,
      path: section.path,
      kind: "text",
      text: `${section.title} evidence paragraph ${index + 1}.`,
      markdown: `${section.title} evidence paragraph ${index + 1}.`,
    };
  });
  return { title: paper.title, sections, blocks };
}

function modelGuide(overrides = {}) {
  return {
    paper_id: paper.paper_id,
    problem: "论文研究有界智能体工作流中的状态保持问题。",
    why_read: "它提供了可以核验的方法与实验结构。",
    intuition: "核心做法是只向每个步骤提供必要上下文。",
    evidence: "作者比较了多种基线并报告主要结果。",
    limitations: "跨任务迁移和失败案例仍需进一步核验。",
    questions: ["状态何时更新？", "主要结果是否稳健？"],
    evidence_refs: ["block-00000000000000000001", "block-00000000000000000003"],
    ...overrides,
  };
}

test("live guide uses the registered prompt, bounded blocks, and complete audit fields", async () => {
  let request;
  const result = await generateFiveMinuteGuide({
    paper,
    document: document(120),
    projectContext: { goal: "This must not enter the paper-only guide." },
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async (value) => {
        request = value;
        return {
          value: modelGuide(),
          provider_id: "deepseek",
          model_id: "deepseek-v4-flash",
          operation_id: "operation-1",
          upstream_request_id: "upstream-1",
          usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
        };
      },
    },
  });

  assert.equal(request.input.paper.paper_id, paper.paper_id);
  assert.equal(request.input.document.blocks.length <= 36, true);
  assert.equal(request.input.document.page_mapping_available, false);
  assert.equal("project_context" in request.input, false);
  assert.equal(JSON.stringify(request.input).includes("This must not enter"), false);
  assert.match(request.prompt, /简体中文/);
  assert.deepEqual(request.schema.required, [
    "paper_id",
    "problem",
    "why_read",
    "intuition",
    "evidence",
    "limitations",
    "questions",
    "evidence_refs",
  ]);
  assert.deepEqual(result.guide.evidence_refs, [
    "block-00000000000000000001",
    "block-00000000000000000003",
  ]);
  assert.equal(result.source, "model");
  assert.equal(result.prompt_id, "five-minute-guide");
  assert.equal(result.prompt_version, "five-minute-guide.v3");
  assert.match(result.prompt_hash, /^sha256:/);
  assert.match(result.input_hash, /^sha256:/);
  assert.equal(result.input_block_count, request.input.document.blocks.length);
  assert.equal(result.input_chars, JSON.stringify(request.input).length);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 40, total_tokens: 140 });
});

test("fixture guide is deterministic, structurally complete, cited, and has no invented pages", async () => {
  const first = await generateFiveMinuteGuide({
    paper,
    document: document(),
    projectContext: { goal: "First context" },
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelMode: "fixture",
  });
  const second = await generateFiveMinuteGuide({
    paper,
    document: document(),
    projectContext: { goal: "Changed context" },
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelMode: "fixture",
  });

  assert.deepEqual(first, second);
  assert.equal(first.source, "fixture");
  assert.equal(first.guide.paper_id, paper.paper_id);
  assert.deepEqual(Object.keys(first.guide).sort(), [
    "evidence",
    "evidence_refs",
    "intuition",
    "limitations",
    "paper_id",
    "problem",
    "questions",
    "why_read",
  ]);
  assert.equal(first.guide.evidence_refs.length > 0, true);
  assert.equal(
    [
      first.guide.problem,
      first.guide.why_read,
      first.guide.intuition,
      first.guide.evidence,
      first.guide.limitations,
      ...first.guide.questions,
    ].every((value) => /\p{Script=Han}/u.test(value)),
    true,
  );
  assert.equal(
    first.guide.evidence_refs.every((blockId) => document().blocks.some(
      (block) => block.block_id === blockId,
    )),
    true,
  );
  assert.doesNotMatch(JSON.stringify(first.guide), /(?:第\s*\d+\s*页|p(?:age)?\.?\s*\d+)/i);
  assert.equal(first.usage, null);
});

test("model guide rejects a wrong paper id, missing fields, and unknown or duplicate refs", async () => {
  async function rejectsGuide(value) {
    await assert.rejects(generateFiveMinuteGuide({
      paper,
      document: document(),
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      modelProviders: {
        completeStructured: async () => ({ value }),
      },
    }), (error) => (
      error instanceof GuideGeneratorError
      && error.code === "GUIDE_OUTPUT_INVALID"
      && error.status === 502
      && error.retryable
    ));
  }

  await rejectsGuide(modelGuide({ paper_id: "unknown-paper" }));
  const missing = modelGuide();
  delete missing.limitations;
  await rejectsGuide(missing);
  await rejectsGuide(modelGuide({
    evidence_refs: ["block-00000000000000000001", "block-unknown"],
  }));
  await rejectsGuide(modelGuide({
    evidence_refs: [
      "block-00000000000000000001",
      "block-00000000000000000001",
    ],
  }));
  await rejectsGuide(modelGuide({
    evidence_refs: [`block-${"a".repeat(200)}`],
  }));
  await rejectsGuide(modelGuide({ evidence_refs: [] }));
});

test("overlong model prose is deterministically bounded instead of discarding a paid guide", async () => {
  let calls = 0;
  const result = await generateFiveMinuteGuide({
    paper,
    document: document(),
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    modelProviders: {
      completeStructured: async () => {
        calls += 1;
        return {
          value: modelGuide({
            why_read: `  ${"值得继续阅读。".repeat(40)}\n${"仍需核验证据。".repeat(40)}  `,
            questions: ["这个问题如何验证？".repeat(30), "主要结论是否稳健？"],
          }),
        };
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.guide.why_read.length, 300);
  assert.doesNotMatch(result.guide.why_read, /\s{2,}|\n/);
  assert.equal(result.guide.questions[0].length, 180);
  assert.equal(result.guide.questions[1], "主要结论是否稳健？");
});

test("model guide rejects English prose but accepts Chinese with necessary English terms", async () => {
  await assert.rejects(generateFiveMinuteGuide({
    paper,
    document: document(),
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => ({
        value: modelGuide({
          problem: "The paper studies memory management for LLM agents.",
        }),
      }),
    },
  }), (error) => (
    error instanceof GuideGeneratorError
    && error.code === "GUIDE_OUTPUT_INVALID"
    && /problem 必须使用简体中文/.test(error.message)
  ));

  const mixed = await generateFiveMinuteGuide({
    paper,
    document: document(),
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => ({
        value: modelGuide({
          problem: "论文研究 LLM Agent 的长期记忆管理问题。",
          intuition: "核心机制结合 AgentDriver、KDE 与 CIC-IoT 数据集。",
        }),
      }),
    },
  });
  assert.match(mixed.guide.problem, /LLM Agent/);
  assert.match(mixed.guide.intuition, /AgentDriver、KDE 与 CIC-IoT/);
});

test("invalid document contracts fail before a model call", async () => {
  let calls = 0;
  const duplicateBlocks = document();
  duplicateBlocks.blocks[1].block_id = duplicateBlocks.blocks[0].block_id;

  await assert.rejects(generateFiveMinuteGuide({
    paper,
    document: duplicateBlocks,
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => {
        calls += 1;
        return { value: modelGuide() };
      },
    },
  }), (error) => (
    error instanceof GuideGeneratorError
    && error.code === "GUIDE_INPUT_INVALID"
    && error.status === 400
  ));
  assert.equal(calls, 0);
});

test("live mode requires a provider while fixture mode never calls one", async () => {
  await assert.rejects(generateFiveMinuteGuide({
    paper,
    document: document(),
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  }), (error) => (
    error instanceof GuideGeneratorError
    && error.code === "MODEL_PROVIDER_REQUIRED"
  ));

  let calls = 0;
  await generateFiveMinuteGuide({
    paper,
    document: document(),
    modelMode: "fixture",
    modelProviders: {
      completeStructured: async () => {
        calls += 1;
      },
    },
  });
  assert.equal(calls, 0);
});
