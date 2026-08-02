import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/ProjectBrowserQaResults.jsx";

test("browser QA results show fixed viewport evidence without interaction controls", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { ProjectBrowserQaResults } = await vite.ssrLoadModule(COMPONENT_PATH);
    const html = renderToStaticMarkup(
      React.createElement(ProjectBrowserQaResults, {
        conversationId: "conversation-1",
        screenshotUrl: ({ profileId }) => `/safe/${profileId}.png`,
        runs: [{
          id: "run-1",
          status: "completed",
          verdict: "issues",
          issueSummary: {
            accessibilityIssueCount: 0,
            blockedActionCount: 1,
          },
          captures: [{
            profile: {
              id: "desktop",
              label: "桌面",
              width: 1440,
              height: 1024,
            },
            dom: { nodeCount: 30, interactiveCount: 4 },
            accessibility: { issueCount: 0 },
          }],
          console: { entries: [] },
          failedRequests: { entries: [] },
          security: {
            blockedRequests: 2,
            blockedNavigations: 1,
          },
        }, {
          id: "run-2",
          status: "completed",
          verdict: "passed",
          captures: [],
          console: { entries: [] },
          failedRequests: { entries: [] },
          security: {
            blockedRequests: 0,
            blockedNavigations: 0,
          },
        }],
      }),
    );

    assert.match(html, /受控页面验收/);
    assert.match(html, /1440×1024/);
    assert.match(html, /\/safe\/desktop\.png/);
    assert.match(html, /被阻止请求/);
    assert.match(html, /被阻止操作/);
    assert.match(html, /页面证据已采集，发现需处理的问题/);
    assert.match(html, /页面验收通过/);
    assert.match(html, /不建立 WebSocket/);
    assert.match(html, /class="is-issues"/);
    assert.match(html, /class="is-passed"/);
    assert.doesNotMatch(html, /点击页面|填写表单|上传文件/);
  } finally {
    await vite.close();
  }
});
