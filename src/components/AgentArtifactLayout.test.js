import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

async function withViteModule(path, callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(path));
  } finally {
    await vite.close();
  }
}

test("Agent artifact layout keeps the Agent full width until the right pane is opened", async () => {
  await withViteModule("/src/components/AgentArtifactLayout.jsx", ({ AgentArtifactLayout }) => {
    const defaultHtml = renderToStaticMarkup(React.createElement(AgentArtifactLayout, {
      ariaLabel: "工作台",
      title: React.createElement("h1", null, "会话"),
      agent: React.createElement("div", null, "Agent 内容"),
      artifact: React.createElement("div", null, "工件内容"),
    }));

    assert.match(defaultHtml, /Agent 内容/);
    assert.match(defaultHtml, /打开右侧/);
    assert.doesNotMatch(defaultHtml, /工件内容/);
    assert.doesNotMatch(defaultHtml, /role="separator"/);

    const openHtml = renderToStaticMarkup(React.createElement(AgentArtifactLayout, {
      ariaLabel: "工作台",
      title: React.createElement("h1", null, "会话"),
      agent: React.createElement("div", null, "Agent 内容"),
      artifact: React.createElement("div", null, "工件内容"),
      artifactOpen: true,
      onArtifactOpenChange() {},
    }));

    assert.match(openHtml, /Agent 内容/);
    assert.match(openHtml, /工件内容/);
    assert.match(openHtml, /收起右侧/);
    assert.match(openHtml, /role="separator"/);
  });
});
