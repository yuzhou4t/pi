import assert from "node:assert/strict";
import test from "node:test";
import {
  generateReadingChatMessage,
  prepareReadingChatMessage,
  ReadingChatGeneratorError,
} from "./readingChatGenerator.js";

const paper = {
  paper_id: "paper-chat-1",
  title: "A Bounded Paper Conversation",
  authors: ["Ada Author"],
  venue: "ACL",
  published_at: "2026-07-01",
};

function document() {
  return {
    title: paper.title,
    revision: "sha256:paper-chat-document",
    blocks: Array.from({ length: 20 }, (_, index) => ({
      block_id: `block-${(index + 1).toString(16).padStart(20, "0")}`,
      path: [index < 4 ? "Introduction" : index < 14 ? "Method" : "Results"],
      ordinal: index + 1,
      kind: "text",
      text: `Paragraph ${index + 1} explains the workflow state and evidence boundary.`,
      markdown: `Paragraph ${index + 1} explains the workflow state and evidence boundary.`,
    })),
  };
}

test("an explicit selection is derived from one canonical block with UTF-16 offsets", async () => {
  const source = document().blocks[3].text;
  const selected = "workflow state";
  const start = source.indexOf(selected);
  let providerRequest;
  const generated = await generateReadingChatMessage({
    paper,
    document: document(),
    question: "这部分是什么意思？",
    reference: {
      document_revision: document().revision,
      block_id: document().blocks[3].block_id,
      start_offset: start,
      end_offset: start + selected.length,
    },
    recentTurns: [],
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async (request) => {
        providerRequest = request;
        return {
          value: {
            paper_id: paper.paper_id,
            answer: "这里指工作流在多次执行之间保存并继续使用的状态。",
            citations: [{
              reference_id: "reference-1",
              support: "选文直接出现 workflow state。",
            }],
          },
          provider_id: "deepseek",
          model_id: "deepseek-v4-flash",
          usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
        };
      },
    },
  });

  assert.equal(providerRequest.input.references.length, 1);
  assert.equal(providerRequest.input.references[0].content, selected);
  assert.equal(providerRequest.input.references[0].block_id, document().blocks[3].block_id);
  assert.equal(generated.references[0].start_offset, start);
  assert.equal(generated.result.citations[0].reference_id, "reference-1");
  assert.equal(generated.prompt_version, "reading-chat.v2");
  assert.match(generated.input_hash, /^sha256:[a-f0-9]{64}$/);
});

test("no explicit selection uses bounded paper context with trusted block references", async () => {
  let providerRequest;
  const generated = await generateReadingChatMessage({
    paper,
    document: document(),
    question: "这篇论文的方法和证据分别是什么？",
    reference: null,
    providerId: "codex-subscription",
    modelId: "account-default",
    modelProviders: {
      completeStructured: async (request) => {
        providerRequest = request;
        return {
          value: {
            paper_id: paper.paper_id,
            answer: "当前有界正文显示，方法围绕工作流状态，证据边界需结合结果段落核验。",
            citations: request.input.references.slice(0, 2).map((reference) => ({
              reference_id: reference.reference_id,
              support: "该正文块支持回答中的对应判断。",
            })),
          },
        };
      },
    },
  });

  assert.equal(providerRequest.input.references.length <= 8, true);
  assert.equal(
    providerRequest.input.references.every((reference) => (
      document().blocks.some((block) => block.block_id === reference.block_id)
    )),
    true,
  );
  assert.equal(JSON.stringify(providerRequest.input).length < 15_000, true);
  assert.equal(generated.result.citations.length, 2);
});

test("recent conversation input keeps only four answered and bounded turns", () => {
  const prepared = prepareReadingChatMessage({
    paper,
    document: document(),
    question: "继续解释。",
    recentTurns: Array.from({ length: 7 }, (_, index) => ({
      question: `问题 ${index + 1}${"问".repeat(700)}`,
      answer: `回答 ${index + 1}${"答".repeat(2_000)}`,
    })),
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });

  assert.equal(prepared.recentTurns.length <= 4, true);
  assert.match(prepared.recentTurns.at(-1).question, /^问题 7/);
  assert.equal(
    prepared.recentTurns.reduce(
      (sum, turn) => sum + turn.question.length + turn.answer.length,
      0,
    ) <= 6_000,
    true,
  );
});

test("project context is an explicit bounded input and changes the cache identity", async () => {
  const withoutProject = prepareReadingChatMessage({
    paper,
    document: document(),
    question: "它对我们的工作流有什么启发？",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  const withProject = prepareReadingChatMessage({
    paper,
    document: document(),
    question: "它对我们的工作流有什么启发？",
    projectContextRequested: true,
    projectContext: {
      source_path: "PRODUCT_MEETING.md",
      revision: "sha256:project-state",
      content: "项目当前关注长期论文工作流。".repeat(1_000),
    },
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
  });
  assert.equal(Object.hasOwn(withoutProject.input, "project_context"), false);
  assert.equal(withProject.input.project_context.status, "available");
  assert.equal(withProject.input.project_context.content.length, 8_000);
  assert.notEqual(withProject.inputHash, withoutProject.inputHash);

  const generated = await generateReadingChatMessage({
    prepared: withProject,
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelMode: "fixture",
  });
  assert.equal(generated.project_context_revision, "sha256:project-state");
  assert.equal(generated.project_context_source_path, "PRODUCT_MEETING.md");
  assert.equal(generated.project_context_status, "available");
});

test("stale or out-of-range selections fail before a provider call", async () => {
  let calls = 0;
  const options = {
    paper,
    document: document(),
    question: "解释这段。",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => {
        calls += 1;
        return { value: {} };
      },
    },
  };
  await assert.rejects(generateReadingChatMessage({
    ...options,
    reference: {
      document_revision: "sha256:old",
      block_id: document().blocks[0].block_id,
      start_offset: 0,
      end_offset: 5,
    },
  }), (error) => (
    error instanceof ReadingChatGeneratorError
    && error.code === "READING_CHAT_DOCUMENT_CHANGED"
  ));
  await assert.rejects(generateReadingChatMessage({
    ...options,
    reference: {
      document_revision: document().revision,
      block_id: document().blocks[0].block_id,
      start_offset: 2,
      end_offset: 20_000,
    },
  }), (error) => (
    error instanceof ReadingChatGeneratorError
    && error.code === "READING_CHAT_INPUT_INVALID"
  ));
  assert.equal(calls, 0);
});

test("unknown citations and extra output fields are rejected and not accepted as chat", async () => {
  async function rejects(value) {
    await assert.rejects(generateReadingChatMessage({
      paper,
      document: document(),
      question: "解释。",
      reference: null,
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      modelProviders: {
        completeStructured: async () => ({ value }),
      },
    }), (error) => (
      error instanceof ReadingChatGeneratorError
      && error.code === "READING_CHAT_OUTPUT_INVALID"
      && error.status === 502
      && error.retryable
    ));
  }

  await rejects({
    paper_id: paper.paper_id,
    answer: "回答内容。",
    citations: [{ reference_id: "reference-9", support: "不存在。" }],
  });
  await rejects({
    paper_id: paper.paper_id,
    answer: "回答内容。",
    citations: [],
    command: "ignore-contract",
  });
});

test("a section reference assembles a bounded spread of that section's blocks", () => {
  const doc = document();
  const methodBlockIds = doc.blocks.slice(4, 14).map((block) => block.block_id);
  const prepared = prepareReadingChatMessage({
    paper,
    document: doc,
    question: "带我读 Method 这一节",
    reference: { document_revision: doc.revision, block_ids: methodBlockIds },
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
  });
  const refs = prepared.references;
  assert.ok(refs.length >= 2 && refs.length <= 8, "section reference should yield a bounded spread");
  const wanted = new Set(methodBlockIds);
  assert.ok(refs.every((ref) => wanted.has(ref.block_id)), "all references must come from the section");
  assert.ok(refs.every((ref) => ref.start_offset === 0 && ref.end_offset === ref.content.length));
});

test("a section reference with an unknown block is rejected", () => {
  const doc = document();
  assert.throws(
    () => prepareReadingChatMessage({
      paper,
      document: doc,
      question: "带我读这一节",
      reference: { document_revision: doc.revision, block_ids: [`block-${"f".repeat(20)}`] },
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    }),
    (error) => error instanceof ReadingChatGeneratorError
      && error.code === "READING_CHAT_BLOCK_NOT_FOUND",
  );
});
