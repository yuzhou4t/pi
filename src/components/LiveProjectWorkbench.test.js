import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/LiveProjectWorkbench.jsx";
const COMPONENT_URL = new URL("./LiveProjectWorkbench.jsx", import.meta.url);

const artifactLayoutStub = {
  name: "live-project-workbench-artifact-layout-stub",
  enforce: "pre",
  resolveId(source, importer) {
    if (
      source === "./AgentArtifactLayout.jsx"
      && importer?.endsWith("/LiveProjectWorkbench.jsx")
    ) {
      return "\0live-project-artifact-layout";
    }
    return null;
  },
  load(id) {
    if (id !== "\0live-project-artifact-layout") return null;
    return `
      import React from "react";
      export function AgentArtifactLayout({ title, agent, artifact }) {
        return React.createElement("main", null, title, agent, artifact);
      }
    `;
  },
};

async function withLiveWorkbench(callback, { exposeArtifact = false } = {}) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    plugins: exposeArtifact ? [artifactLayoutStub] : [],
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(COMPONENT_PATH));
  } finally {
    await vite.close();
  }
}

function conversation(overrides = {}) {
  return {
    id: "conversation-live-1",
    projectId: "project-live-1",
    rootLabel: "真实项目",
    title: "修复设置页",
    status: "idle",
    turnStatus: "idle",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messages: [],
    plan: [],
    events: [],
    pendingChangeSet: null,
    verificationCommand: null,
    verificationRuns: [],
    preview: null,
    activeArtifactId: "files",
    error: null,
    ...overrides,
  };
}

const project = {
  id: "project-live-1",
  name: "真实项目",
  rootLabel: "真实项目",
};

test("live project workbench renders the honest empty states without starting work", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const noConversationHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project, conversation: null },
    ));

    assert.match(noConversationHtml, /绑定项目 \/ 新建会话后开始/);
    assert.match(noConversationHtml, /等待会话/);
    assert.match(noConversationHtml, /新建会话后可打开项目工件/);

    const emptyConversationHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project, conversation: conversation() },
    ));

    assert.match(emptyConversationHtml, /从一个明确任务开始/);
    assert.match(emptyConversationHtml, /真实项目上下文/);
    assert.match(emptyConversationHtml, /修改先审阅/);
    assert.match(emptyConversationHtml, /命令显式运行/);
    assert.match(emptyConversationHtml, /只有显式发送才开始工作/);
    assert.doesNotMatch(emptyConversationHtml, /aria-label="项目工件"/);
    assert.doesNotMatch(emptyConversationHtml, /MinerU|Zotero|Obsidian|阅读镜头/);
  });
});

test("a ready change set exposes its exact diff and hash-bound apply control", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        status: "awaiting_confirmation",
        turnStatus: "awaiting_confirmation",
        activeArtifactId: "changes",
        pendingChangeSet: {
          id: "change-set-live-1",
          status: "ready",
          proposalHash: "sha256:proposal-123",
          files: [{
            id: "file-change-1",
            path: "src/settings.css",
            operation: "modify",
            additions: 2,
            deletions: 1,
            actionable: true,
            selected: true,
            baseHash: "sha256:before-123",
            afterHash: "sha256:after-456",
            diff: [
              "--- a/src/settings.css",
              "+++ b/src/settings.css",
              "@@ -1,2 +1,3 @@",
              "-.actions { position: fixed; }",
              "+.actions { position: sticky; }",
              "+.actions { bottom: env(safe-area-inset-bottom); }",
            ],
          }],
        },
      }),
    }));

    assert.match(html, /修改已经准备好，尚未写入项目/);
    assert.match(html, /src\/settings\.css/);
    assert.match(html, /unified diff/);
    assert.match(html, /position: sticky/);
    assert.match(html, /sha256:before-123/);
    assert.match(html, /sha256:after-456/);
    assert.match(html, /sha256:proposal-123/);
    assert.match(html, /确认应用所选修改/);
    assert.match(html, /写入前重新核对每个基础哈希/);
  }, { exposeArtifact: true });
});

test("failed and passing verification evidence keeps the saved command retryable", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        activeArtifactId: "run_result",
        verificationCommand: {
          id: "command-test-1",
          label: "前端测试",
          displayCommand: "npm test",
          resolvedScript: "node --test",
          cwdLabel: "真实项目",
        },
        verificationRuns: [{
          id: "run-failed",
          status: "failed",
          command: "npm test",
          summary: "首次验证发现布局断言失败",
          checks: [{ id: "check-failed", label: "设置页布局", status: "failed" }],
          logs: ["AssertionError: footer overlaps content"],
          stdout: "",
          stderr: "",
          exitCode: 1,
          durationMs: 418,
        }, {
          id: "run-passed",
          status: "passed",
          command: "npm test",
          summary: "修复后验证通过",
          checks: [{ id: "check-passed", label: "设置页布局", status: "passed" }],
          logs: ["1 test passed"],
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 367,
        }],
      }),
    }));

    assert.match(html, /待运行验证命令/);
    assert.match(html, /npm test/);
    assert.match(html, /运行验证/);
    assert.match(html, /首次验证发现布局断言失败/);
    assert.match(html, /AssertionError: footer overlaps content/);
    assert.match(html, /退出码 1/);
    assert.match(html, /修复后验证通过/);
    assert.match(html, /1 test passed/);
    assert.match(html, /退出码 0/);
  }, { exposeArtifact: true });
});

test("pending changes block verification until the exact diff is applied", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        status: "awaiting_confirmation",
        turnStatus: "awaiting_confirmation",
        activeArtifactId: "run_result",
        pendingChangeSet: {
          id: "change-set-live-2",
          status: "ready",
          proposalHash: "sha256:proposal-456",
          files: [{
            id: "file-change-2",
            path: "src/settings.css",
            operation: "modify",
            additions: 1,
            deletions: 1,
            actionable: true,
            selected: true,
            baseHash: "sha256:before-456",
            afterHash: "sha256:after-789",
            diff: ["-old", "+new"],
          }],
        },
        verificationCommand: {
          id: "command-test-2",
          label: "前端测试",
          displayCommand: "npm test",
          resolvedScript: "node --test",
          cwdLabel: "真实项目",
        },
      }),
    }));

    assert.match(html, /disabled=""[^>]*>.*先审阅修改/s);
    assert.match(html, /等待修改确认/);
    assert.match(html, /验证才会变为可运行/);
  }, { exposeArtifact: true });
});

test("a ready change event links to changes instead of matching read inside ready", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        events: [{
          seq: 7,
          type: "change_set.ready",
          status: "ready",
        }],
      }),
    }));

    assert.match(html, /修改提案已更新/);
    assert.match(html, />查看更改</);
    assert.doesNotMatch(html, />查看文件</);
  });
});

test("adding file context only updates removable composer context until submit", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const addContextStart = source.indexOf("const addContext = useCallback");
  const addContextEnd = source.indexOf("const applySelectedChanges", addContextStart);
  const addContextImplementation = source.slice(addContextStart, addContextEnd);
  const submitStart = source.indexOf("const submitMessage = useCallback");
  const submitEnd = source.indexOf("const openArtifact", submitStart);
  const submitImplementation = source.slice(submitStart, submitEnd);

  assert.notEqual(addContextStart, -1);
  assert.notEqual(addContextEnd, -1);
  assert.match(addContextImplementation, /setContextChips/);
  assert.match(addContextImplementation, /some\(\(item\) => item\.id === context\.id\)/);
  assert.doesNotMatch(addContextImplementation, /api\.(?:sendMessage|steerConversation)/);

  assert.match(source, />\s*加入上下文\s*</);
  assert.match(source, /aria-label=\{`移除上下文：\$\{context\.label\}`\}/);
  assert.match(source, /<form className="project-agent-composer" onSubmit=\{onSubmit\}>/);
  assert.match(submitImplementation, /api\.sendMessage/);
  assert.match(submitImplementation, /contexts: contextChips/);
  assert.match(source, /useState\(\s*readLastArtifact\(/);
});
