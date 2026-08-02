import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vitePromise;

async function loadModule() {
  vitePromise ??= createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  return (await vitePromise).ssrLoadModule("/src/components/PaperDiscoveryCard.jsx");
}

after(async () => {
  if (vitePromise) await (await vitePromise).close();
});

test("paper presentation uses translated identity and the shared summary fallback order", async () => {
  const { toPaperPresentation } = await loadModule();
  const view = toPaperPresentation({
    id: "paper-1",
    title: "Original paper title",
    titleZh: "中文论文标题",
    authors: ["甲", "乙"],
    venue: "ACL",
    publishedAt: "2026-06-18T00:00:00.000Z",
    selectionSummary: "候选说明",
    abstractZh: "中文摘要",
    abstract: "English abstract",
  });

  assert.equal(view.displayTitle, "中文论文标题");
  assert.equal(view.originalTitle, "Original paper title");
  assert.equal(view.summary, "候选说明");
  assert.equal(view.projectImpact, "待核验");
  assert.deepEqual(view.metadata, ["甲、乙", "ACL", "发表于 2026-06-18"]);

  assert.equal(toPaperPresentation({ abstractZh: "中文摘要", abstract: "English" }).summary, "中文摘要");
  assert.equal(toPaperPresentation({ abstract: "English" }).summary, "English");
  assert.deepEqual(
    toPaperPresentation({
      publishedAt: "2026-01-01",
      publicationDatePrecision: "year",
    }).metadata,
    ["发表于 2026（年份）"],
  );
});

test("shared card renders the fixed title, metadata, insight, and action anatomy", async () => {
  const { PaperDiscoveryCard } = await loadModule();
  const html = renderToStaticMarkup(React.createElement(PaperDiscoveryCard, {
    paper: {
      title: "Original title",
      titleZh: "中文标题",
      venue: "ICML",
      publishedAt: "2026-05-20",
      abstractZh: "这篇论文讨论可恢复工作流。",
      projectImpact: "可用于检验当前项目的状态恢复设计。",
    },
    href: "https://example.com/paper",
    badge: "优先精读",
    actions: React.createElement("button", { type: "button" }, "加入本月推荐"),
  }));

  assert.match(html, /中文标题/);
  assert.match(html, /Original title/);
  assert.match(html, /ICML · 发表于 2026-05-20/);
  assert.match(html, /<dt>论文讲什么<\/dt>/);
  assert.match(html, /<dt>对项目的作用<\/dt>/);
  assert.match(html, /优先精读/);
  assert.match(html, /加入本月推荐/);
  assert.match(html, /target="_blank"/);
});
