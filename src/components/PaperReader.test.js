import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

function renderBlock(PaperReaderFullBlock, block, { resolved }) {
  return renderToStaticMarkup(React.createElement(PaperReaderFullBlock, {
    block,
    section: null,
    active: true,
    activeRef: null,
    onActivate() {},
    language: "bilingual",
    translationResolved: resolved,
  }));
}

async function withPaperReader(callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule("/src/components/PaperReader.jsx"));
  } finally {
    await vite.close();
  }
}

test("ready passthrough blocks do not show a false untranslated warning", async () => {
  await withPaperReader(({ documentTranslationView, PaperReaderFullBlock }) => {
    const formula = {
      id: "formula",
      kind: "text",
      text: "$$E = mc^2$$",
    };
    const metadata = {
      id: "metadata",
      kind: "text",
      text: "Project page: https://example.com/paper",
    };
    const translated = {
      id: "translated",
      kind: "text",
      text: "This is the main result.",
    };
    const missing = {
      id: "missing",
      kind: "text",
      text: "This paragraph is still pending.",
    };
    const document = {
      revision: "sha256:paper",
      blocks: [formula, metadata, translated, missing],
    };
    const view = documentTranslationView(document, {
      documentRevision: document.revision,
      blocks: {
        metadata: metadata.text,
        translated: "这是主要结果。",
      },
    });

    assert.equal(view.blocks.translated, "这是主要结果。");
    assert.equal(view.blocks.metadata, undefined);
    assert.equal(view.resolvedBlockIds.has(formula.id), true);
    assert.equal(view.resolvedBlockIds.has(metadata.id), true);
    assert.equal(view.resolvedBlockIds.has(translated.id), true);
    assert.equal(view.resolvedBlockIds.has(missing.id), false);

    assert.doesNotMatch(
      renderBlock(PaperReaderFullBlock, formula, { resolved: true }),
      /本段尚未翻译/,
    );
    assert.doesNotMatch(
      renderBlock(PaperReaderFullBlock, metadata, { resolved: true }),
      /本段尚未翻译/,
    );
    assert.match(
      renderBlock(PaperReaderFullBlock, missing, { resolved: false }),
      /本段尚未翻译/,
    );
  });
});
