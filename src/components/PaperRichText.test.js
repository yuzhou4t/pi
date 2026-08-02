import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("paper markup renders Markdown, tables, and LaTeX without exposing unsafe HTML", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { PaperRichText } = await vite.ssrLoadModule(
      "/src/components/PaperRichText.jsx",
    );
    const content = [
      "**Memory** 与 $\\pi(q,e)=1$。",
      "",
      "| 方法 | 分数 |",
      "| --- | ---: |",
      "| Pi | 1 |",
      "",
      "<script>alert('unsafe')</script>",
      "<img src=x onerror=alert('unsafe')>",
    ].join("\n");
    const html = renderToStaticMarkup(React.createElement(PaperRichText, { content }));

    assert.match(html, /<strong[^>]*>/);
    assert.match(html, /class="katex"/);
    assert.match(html, /<table[^>]*>/);
    assert.match(html, /<th[^>]*>.*方法.*<\/th>/);
    assert.match(html, /data-source-start=/);
    assert.match(html, /class="paper-math-source" data-source-start=/);
    assert.doesNotMatch(html, /\*\*Memory\*\*/);
    assert.doesNotMatch(html, /<script|<img[^>]*onerror=/);
  } finally {
    await vite.close();
  }
});

test("inline paper markup stays valid inside a citation button", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { PaperRichText } = await vite.ssrLoadModule(
      "/src/components/PaperRichText.jsx",
    );
    const html = renderToStaticMarkup(React.createElement(
      "button",
      { type: "button" },
      React.createElement(PaperRichText, {
        content: "核心概率为 $p(y\\mid x)$。",
        inline: true,
      }),
    ));
    assert.match(html, /<button[^>]*>.*paper-rich-text is-inline.*class="katex".*<\/button>/);
    assert.doesNotMatch(html, /<button[^>]*>.*<p/);
  } finally {
    await vite.close();
  }
});
