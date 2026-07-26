import assert from "node:assert/strict";
import test from "node:test";
import {
  isMathOnlyBlock,
  isTranslatableBlock,
  translatePaperBatch,
  translationBatches,
  TranslationGeneratorError,
} from "./translationGenerator.js";

function blockId(index) {
  return `block-${String(index).padStart(20, "0").replaceAll(/[^a-f0-9]/g, "0")}`;
}

function textBlock(index, text) {
  return { block_id: blockId(index), kind: "text", text };
}

test("translation batches skip images, headings, math-only and cached blocks", () => {
  const blocks = [
    { block_id: blockId(1), kind: "heading", text: "Introduction" },
    textBlock(2, "First paragraph."),
    { block_id: blockId(3), kind: "image", text: "Figure 1" },
    { block_id: blockId(4), kind: "text", text: "$$x = y + 1$$" },
    textBlock(5, "Second paragraph."),
  ];
  assert.equal(isTranslatableBlock(blocks[0]), false);
  assert.equal(isTranslatableBlock(blocks[2]), false);
  assert.equal(isMathOnlyBlock(blocks[3]), true);

  const batches = translationBatches(blocks, new Set([blockId(5)]));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((block) => block.block_id), [blockId(2)]);
});

test("translation batches stay bounded by block count", () => {
  const blocks = Array.from({ length: 60 }, (_, index) => textBlock(index, `Paragraph ${index}.`));
  const batches = translationBatches(blocks);
  assert.ok(batches.length >= 3);
  assert.ok(batches.every((batch) => batch.length <= 24));
  assert.equal(batches.flat().length, 60);
});

test("fixture mode translates a batch without a model provider", async () => {
  const generated = await translatePaperBatch({
    paperId: "paper-1",
    batch: [{ block_id: blockId(1), kind: "text", source: "Hello world." }],
    modelMode: "fixture",
  });
  assert.equal(generated.source, "fixture");
  assert.match(generated.translations[blockId(1)], /示例译文/);
  assert.equal(generated.prompt_id, "translation");
  assert.match(generated.input_hash, /^sha256:[a-f0-9]{64}$/);
});

test("live mode validates coverage and rejects untranslated prose", async () => {
  const batch = [
    { block_id: blockId(1), kind: "text", source: "This paragraph explains the entropy patching mechanism." },
  ];
  const modelProviders = {
    completeStructured: async () => ({
      value: {
        paper_id: "paper-1",
        blocks: [{ block_id: blockId(1), zh: "Still English output here." }],
      },
    }),
  };
  await assert.rejects(
    translatePaperBatch({
      paperId: "paper-1",
      batch,
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      modelProviders,
      modelMode: "live",
    }),
    (error) => error instanceof TranslationGeneratorError
      && error.code === "TRANSLATION_OUTPUT_INVALID",
  );

  const good = await translatePaperBatch({
    paperId: "paper-1",
    batch,
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    modelProviders: {
      completeStructured: async () => ({
        value: {
          paper_id: "paper-1",
          blocks: [{ block_id: blockId(1), zh: "这一段解释了熵切分（entropy patching）机制。" }],
        },
        provider_id: "deepseek",
        model_id: "deepseek-v4-flash",
        usage: { total_tokens: 10 },
      }),
    },
    modelMode: "live",
  });
  assert.match(good.translations[blockId(1)], /熵切分/);
  assert.equal(good.provider_id, "deepseek");
});

test("live mode rejects missing or unknown block coverage", async () => {
  await assert.rejects(
    translatePaperBatch({
      paperId: "paper-1",
      batch: [
        { block_id: blockId(1), kind: "text", source: "First." },
        { block_id: blockId(2), kind: "text", source: "Second." },
      ],
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      modelProviders: {
        completeStructured: async () => ({
          value: {
            paper_id: "paper-1",
            blocks: [{ block_id: blockId(1), zh: "第一段。" }],
          },
        }),
      },
      modelMode: "live",
    }),
    (error) => error.code === "TRANSLATION_OUTPUT_INVALID",
  );
});
