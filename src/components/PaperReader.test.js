import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const STYLES_URL = new URL("../styles.css", import.meta.url);

function renderBlock(PaperReaderFullBlock, block, {
  resolved,
  active = true,
  zh = null,
  language = "bilingual",
}) {
  return renderToStaticMarkup(React.createElement(PaperReaderFullBlock, {
    block,
    section: null,
    active,
    activeRef: null,
    onActivate() {},
    language,
    zh,
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
    assert.match(
      renderBlock(PaperReaderFullBlock, translated, { resolved: true, active: true }),
      /tabindex="0"/,
    );
    assert.doesNotMatch(
      renderBlock(PaperReaderFullBlock, translated, { resolved: true, active: false }),
      /tabindex=|role="button"|aria-label=/,
    );
  });
});

test("headings and figure captions share the Spark translation view", async () => {
  await withPaperReader(({ documentTranslationView, PaperReaderFullBlock }) => {
    const heading = {
      id: "heading",
      kind: "heading",
      text: "Introduction",
    };
    const figure = {
      id: "figure",
      kind: "image",
      text: "Figure 1. System overview.",
      imageUrl: "/api/v1/papers/paper-1/assets/figure-1.png",
    };
    const document = {
      revision: "sha256:paper-structure",
      blocks: [heading, figure],
    };
    const view = documentTranslationView(document, {
      documentRevision: document.revision,
      blocks: {
        heading: "引言",
        figure: "图 1：系统总览。",
      },
    });

    assert.equal(view.blocks.heading, "引言");
    assert.equal(view.blocks.figure, "图 1：系统总览。");
    assert.equal(view.resolvedBlockIds.has(heading.id), true);
    assert.equal(view.resolvedBlockIds.has(figure.id), true);

    const headingHtml = renderBlock(PaperReaderFullBlock, heading, {
      resolved: true,
      zh: view.blocks.heading,
    });
    assert.match(headingHtml, /Introduction/);
    assert.match(headingHtml, /引言/);

    const bilingualFigureHtml = renderBlock(PaperReaderFullBlock, figure, {
      resolved: true,
      zh: view.blocks.figure,
    });
    assert.match(bilingualFigureHtml, /figure-1\.png/);
    assert.match(bilingualFigureHtml, /Figure 1\. System overview\./);
    assert.match(bilingualFigureHtml, /图 1：系统总览。/);

    const chineseFigureHtml = renderBlock(PaperReaderFullBlock, figure, {
      resolved: true,
      zh: view.blocks.figure,
      language: "zh",
    });
    assert.match(chineseFigureHtml, /alt="图 1：系统总览。"/);
    assert.doesNotMatch(chineseFigureHtml, />Figure 1\. System overview\.</);
  });
});

test("1440 desktop full text keeps every stable anchor with one focusable paragraph", async () => {
  await withPaperReader(({ PaperReaderFullBlock }) => {
    const blocks = Array.from({ length: 240 }, (_, index) => ({
      id: `block-${String(index + 1).padStart(3, "0")}`,
      kind: "paragraph",
      text: `Paragraph ${index + 1} keeps **source ${index + 1}** available for selection.`,
    }));
    const activeId = "block-120";
    const html = renderToStaticMarkup(React.createElement(
      "div",
      {
        className: "paper-reader-full",
        style: { width: 820, maxWidth: "100%" },
      },
      blocks.map((block) => React.createElement(PaperReaderFullBlock, {
        block,
        section: null,
        active: block.id === activeId,
        activeRef: null,
        onActivate() {},
        language: "original",
        translationResolved: true,
        key: block.id,
      })),
    ));

    assert.equal((html.match(/data-reader-block-id=/g) ?? []).length, blocks.length);
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
    assert.equal((html.match(/role="button"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /tabindex="-1"/);
    assert.match(html, new RegExp(`id="${activeId}"[^>]*data-reader-block-id="${activeId}"`));
    assert.match(html, /data-source-start=/);
    assert.match(html, /data-source-end=/);
    assert.match(html, /Paragraph 1 keeps/);
    assert.match(html, /Paragraph 240 keeps/);
  });

  const styles = await readFile(STYLES_URL, "utf8");
  const virtualizationStart = styles.indexOf(
    ".paper-reader-full > .paper-reader-full-heading,",
  );
  const virtualizationEnd = styles.indexOf(
    ".paper-reader-full-heading.is-active {",
    virtualizationStart,
  );
  const virtualization = styles.slice(virtualizationStart, virtualizationEnd);

  assert.notEqual(virtualizationStart, -1);
  assert.match(virtualization, /content-visibility:\s*auto/);
  assert.match(virtualization, /contain:\s*layout paint style/);
  assert.match(virtualization, /contain-intrinsic-block-size:\s*auto 132px/);
  assert.match(virtualization, /\.paper-reader-full-block\.is-active[\s\S]*content-visibility:\s*visible/);
  assert.doesNotMatch(virtualization, /display:\s*none|visibility:\s*hidden/);
});
