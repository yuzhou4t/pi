import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/LiveProjectWorkbench.jsx";
const COMPONENT_URL = new URL("./LiveProjectWorkbench.jsx", import.meta.url);
const APP_URL = new URL("../App.jsx", import.meta.url);
const STYLES_URL = new URL("../styles.css", import.meta.url);

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

function findElement(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

test("same-session rename updates the workbench title without resetting local detail", async () => {
  await withLiveWorkbench(({ mergeConversationTitle }) => {
    const snapshot = conversation({
      title: "新工作会话",
      messages: [{ id: "message-1", role: "user", text: "保留当前对话" }],
    });
    const renamed = mergeConversationTitle(snapshot, {
      id: snapshot.id,
      title: "检查登录页",
      updatedAt: "2026-07-25T14:00:00.000Z",
    });

    assert.equal(renamed.title, "检查登录页");
    assert.equal(renamed.messages[0].text, "保留当前对话");
    assert.equal(renamed.updatedAt, "2026-07-25T14:00:00.000Z");
  });
});

test("live project workbench renders the honest empty states without starting work", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const noConversationHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project, conversation: null },
    ));

    assert.match(noConversationHtml, /新建会话后开始/);
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
    assert.match(emptyConversationHtml, /添加文件/);
    assert.match(emptyConversationHtml, /上传 PDF/);
    assert.match(emptyConversationHtml, /MinerU Cloud/);
    assert.doesNotMatch(emptyConversationHtml, /aria-label="项目工件"/);
    assert.doesNotMatch(emptyConversationHtml, /Zotero|Obsidian|阅读镜头/);
  });
});

test("PDF state stays visible while MinerU parses without marking the Agent as running", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench, hasProcessingDocuments }) => {
    const parsing = conversation({
      documents: [{
        id: "document-1",
        fileName: "开发手册.pdf",
        byteLength: 1024,
        status: "parsing",
        parser: "MinerU Cloud v4",
        error: null,
      }],
    });
    assert.equal(hasProcessingDocuments(parsing), true);
    assert.equal(parsing.status, "idle");
    const parsingHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project, conversation: parsing },
    ));
    assert.match(parsingHtml, /开发手册\.pdf/);
    assert.match(parsingHtml, /正在由 MinerU 解析/);
    assert.match(parsingHtml, /等待任务/);
    assert.doesNotMatch(parsingHtml, /Agent 正在工作/);

    const ready = {
      ...parsing,
      documents: [{
        ...parsing.documents[0],
        status: "ready",
        revision: "sha256:ready",
      }],
    };
    assert.equal(hasProcessingDocuments(ready), false);
    const readyHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project, conversation: ready },
    ));
    assert.match(readyHtml, /已可供 AI 阅读/);
    assert.match(readyHtml, /只有显式发送才开始工作/);
  });
});

test("standalone workbench states that it cannot read a local folder", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const standalone = conversation({
      projectId: null,
      workspaceKind: "scratch",
      scope: "standalone",
      rootLabel: "未连接文件夹",
      title: "整理需求",
    });
    const html = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project: null, conversation: standalone },
    ));

    assert.match(html, /独立对话/);
    assert.match(html, /未连接本地文件夹/);
    assert.match(html, /私有草稿区/);
    assert.match(html, /只有显式发送才开始工作/);
    assert.doesNotMatch(html, /真实项目上下文|读取当前项目/);
  });
});

test("context usage menu exposes exact usage, automatic compaction, and an explicit action", async () => {
  await withLiveWorkbench(({ ProjectContextUsageMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectContextUsageMenu, {
      open: true,
      onOpenChange: () => {},
      contextUsage: {
        tokens: 30_720,
        contextWindow: 128_000,
        percent: 24,
      },
      modelContextWindow: null,
      compaction: {
        autoEnabled: true,
        status: "idle",
      },
      hasAssistantReply: true,
      running: false,
      compacting: false,
      onCompact: () => {},
    }));

    assert.match(html, /上下文 24%/);
    assert.match(html, /30\.7k \/ 128k tokens/);
    assert.match(html, /aria-valuenow="24"/);
    assert.match(html, /自动压缩/);
    assert.match(html, /已开启/);
    assert.match(html, /立即压缩上下文/);
    assert.doesNotMatch(html, /整理上下文/);
  });
});

test("context usage stays unknown after compaction until Pi recalculates it", async () => {
  await withLiveWorkbench(({ ProjectContextUsageMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectContextUsageMenu, {
      open: true,
      onOpenChange: () => {},
      contextUsage: {
        tokens: null,
        contextWindow: null,
        percent: null,
        status: "awaiting_measurement",
      },
      modelContextWindow: 131_072,
      compaction: {
        autoEnabled: true,
        status: "completed",
        completedAt: "2026-07-26T00:01:00.000Z",
      },
      hasAssistantReply: true,
      running: false,
      compacting: false,
      onCompact: () => {},
    }));

    assert.match(html, /上下文 · 重新计算中/);
    assert.match(html, /— \/ 131k tokens/);
    assert.match(html, /aria-valuetext="重新计算中"/);
    assert.match(html, /压缩已完成，下一次模型响应后重新计算/);
    assert.match(html, /disabled=""[^>]*>立即压缩上下文/);
  });
});

test("opening context usage does not invoke compaction, while its action does", async () => {
  await withLiveWorkbench(({ ProjectContextUsageMenu }) => {
    const openChanges = [];
    let compactCalls = 0;
    const menuProps = {
      onOpenChange: (open) => openChanges.push(open),
      contextUsage: {
        tokens: 10_000,
        contextWindow: 100_000,
        percent: 10,
      },
      modelContextWindow: null,
      compaction: { autoEnabled: true, status: "idle" },
      hasAssistantReply: true,
      running: false,
      compacting: false,
      onCompact: () => {
        compactCalls += 1;
      },
    };
    const closedMenu = ProjectContextUsageMenu({
      ...menuProps,
      open: false,
    });
    const trigger = findElement(
      closedMenu,
      (element) => element.props.className?.includes("project-context-usage-trigger"),
    );
    trigger.props.onClick();

    assert.deepEqual(openChanges, [true]);
    assert.equal(compactCalls, 0);

    const openMenu = ProjectContextUsageMenu({
      ...menuProps,
      open: true,
    });
    const compactButton = findElement(
      openMenu,
      (element) => element.props.className === "project-context-compact-button",
    );
    compactButton.props.onClick();

    assert.deepEqual(openChanges, [true, false]);
    assert.equal(compactCalls, 1);
  });
});

test("manual context compaction waits for the first assistant reply", async () => {
  await withLiveWorkbench(({ ProjectContextUsageMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectContextUsageMenu, {
      open: true,
      onOpenChange: () => {},
      contextUsage: null,
      modelContextWindow: null,
      compaction: { autoEnabled: true, status: "idle" },
      hasAssistantReply: false,
      running: false,
      compacting: false,
      onCompact: () => {},
    }));

    assert.match(html, /— \/ — tokens/);
    assert.match(html, /disabled=""[^>]*>立即压缩上下文/);
    assert.match(html, /产生首轮回复后可手动压缩/);
  });
});

test("composer thinking control exposes only model-supported Chinese levels", async () => {
  await withLiveWorkbench(({ ProjectThinkingLevelControl }) => {
    const availableHtml = renderToStaticMarkup(React.createElement(
      ProjectThinkingLevelControl,
      {
        thinkingLevels: ["low", "medium", "high"],
        thinkingLevel: "medium",
        supportsThinking: true,
        running: false,
        onChange: () => {},
      },
    ));
    assert.match(availableHtml, /aria-label="思考强度"/);
    assert.match(availableHtml, /思考 · 低/);
    assert.match(availableHtml, /思考 · 中/);
    assert.match(availableHtml, /思考 · 高/);
    assert.doesNotMatch(availableHtml, /思考 · 最高/);

    const runningHtml = renderToStaticMarkup(React.createElement(
      ProjectThinkingLevelControl,
      {
        thinkingLevels: ["low", "medium", "high"],
        thinkingLevel: "high",
        supportsThinking: true,
        running: true,
        onChange: () => {},
      },
    ));
    assert.match(runningHtml, /Agent 工作期间不能切换思考强度/);
    assert.match(runningHtml, /disabled=""/);

    const unsupportedHtml = renderToStaticMarkup(React.createElement(
      ProjectThinkingLevelControl,
      {
        thinkingLevels: ["off"],
        thinkingLevel: "off",
        supportsThinking: false,
        onChange: () => {},
      },
    ));
    assert.match(unsupportedHtml, /思考 · 不支持/);
    assert.match(unsupportedHtml, /disabled=""/);
  });
});

test("current-message capability menu exposes only configured retrieval and one workflow", async () => {
  await withLiveWorkbench(({ ProjectCapabilityMenu }) => {
    const html = renderToStaticMarkup(React.createElement(
      ProjectCapabilityMenu,
      {
        open: true,
        onOpenChange: () => {},
        capabilityStatus: {
          web_search: { available: true, reason: "Tavily 已配置" },
          docs_search: { available: false, reason: "Context7 尚未配置" },
        },
        selectedCapabilityIds: ["web_search"],
        onToggleCapability: () => {},
        selectedWorkflowId: "code_review",
        onSelectWorkflow: () => {},
        supportsImages: false,
        running: false,
        onOpenSkills: () => {},
        installedSkillCount: 4,
      },
    ));

    assert.match(html, /能力 · 2/);
    assert.match(html, /只在显式发送的这一轮生效/);
    assert.match(html, /联网搜索/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /Context7 尚未配置/);
    assert.match(html, /当前模型不支持识图/);
    assert.match(html, /查看内置流程 · 4/);
    assert.match(html, /未选择时不增加工具或提示词/);

    const lockedHtml = renderToStaticMarkup(React.createElement(
      ProjectCapabilityMenu,
      {
        open: true,
        onOpenChange: () => {},
        capabilityStatus: {
          web_search: { available: true, reason: "Tavily 已配置" },
        },
        selectedCapabilityIds: ["web_search"],
        onToggleCapability: () => {},
        selectedWorkflowId: "code_review",
        onSelectWorkflow: () => {},
        running: true,
      },
    ));
    assert.match(
      lockedHtml,
      /header-skill-pill[^>]*type="button" disabled=""/,
    );
    assert.match(lockedHtml, /Agent 工作期间不能更换本轮能力/);
  });
});

test("message payload controls stay frozen until image serialization and HTTP finish", async () => {
  await withLiveWorkbench(({ ProjectAgentPane }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectAgentPane, {
      conversation: conversation({ documents: [] }),
      draft: "检查这张截图",
      onDraftChange: () => {},
      contextChips: [{ id: "context-1", label: "src/App.jsx" }],
      onRemoveContext: () => {},
      selectedCapabilityIds: ["web_search"],
      onRemoveCapability: () => {},
      selectedWorkflowId: "code_review",
      onRemoveWorkflow: () => {},
      pendingImage: {
        file: { name: "设置页.png" },
        previewUrl: "",
      },
      onRemoveImage: () => {},
      imageInputRef: { current: null },
      onSelectImage: () => {},
      supportsImages: true,
      onSubmit: () => {},
      onAbort: () => {},
      onOpenArtifact: () => {},
      action: "message",
      error: null,
      modelLabel: "vision-model",
      thinkingLevelControl: null,
      contextUsageControl: null,
      pdfInputRef: { current: null },
      uploadingPdf: null,
      onUploadPdf: () => {},
      onRetryDocument: () => {},
      retryingDocumentId: null,
    }));

    assert.match(html, /<textarea[^>]*disabled=""/);
    assert.match(
      html,
      /<button type="button" disabled="" aria-label="移除上下文：src\/App\.jsx"/,
    );
    assert.match(
      html,
      /<button type="button" disabled="" aria-label="移除流程：代码审查"/,
    );
    assert.match(
      html,
      /<button type="button" disabled="" aria-label="移除能力：联网搜索"/,
    );
    assert.match(
      html,
      /<button type="button" disabled="" aria-label="移除图片：设置页\.png"/,
    );
    assert.match(
      html,
      /project-composer-attachment" type="button" disabled="" title="为当前消息添加一张/,
    );
    assert.match(
      html,
      /type="file" accept="image\/png,image\/jpeg,image\/webp" disabled=""/,
    );
  });
});

test("safe image metadata is visible without returning image data to the browser", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          messages: [{
            id: "message-image",
            role: "user",
            content: "检查这张界面截图",
            images: [{
              fileName: "设置页.png",
              mimeType: "image/png",
              byteLength: 2048,
            }],
          }],
        }),
      },
    ));

    assert.match(html, /检查这张界面截图/);
    assert.match(html, /图片 · 设置页\.png/);
    assert.doesNotMatch(html, /data:image|base64/);
  });
});

test("normal-work keeps context usage beside the composer model and out of the header", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const headerStart = source.indexOf("const headerActions");
  const headerEnd = source.indexOf("if (!snapshot)", headerStart);
  const headerImplementation = source.slice(headerStart, headerEnd);
  const composerStart = source.indexOf('<form className="project-agent-composer"');
  const composerEnd = source.indexOf("</form>", composerStart);
  const composerImplementation = source.slice(composerStart, composerEnd);

  const providerIndex = headerImplementation.indexOf("<ProviderMenu");
  const capabilitiesIndex = headerImplementation.indexOf("<ProjectCapabilityMenu");
  const modelIndex = composerImplementation.indexOf("project-composer-model");
  const thinkingIndex = composerImplementation.indexOf("{thinkingLevelControl}");
  const contextIndex = composerImplementation.indexOf("{contextUsageControl}");
  assert.ok(providerIndex >= 0 && providerIndex < capabilitiesIndex);
  assert.doesNotMatch(headerImplementation, /ProjectContextUsageMenu/);
  assert.ok(modelIndex >= 0 && modelIndex < thinkingIndex);
  assert.ok(thinkingIndex < contextIndex);
  assert.doesNotMatch(source, />\s*整理上下文\s*</);
});

test("composer context menu expands above its trigger", async () => {
  const styles = await readFile(STYLES_URL, "utf8");
  const selectorStart = styles.indexOf(
    ".project-agent-composer .project-context-usage-popover",
  );
  const selectorEnd = styles.indexOf("}", selectorStart);
  const rule = styles.slice(selectorStart, selectorEnd);

  assert.notEqual(selectorStart, -1);
  assert.match(rule, /top: auto/);
  assert.match(rule, /bottom: calc\(100% \+ 8px\)/);
});

test("normal-work model menu honestly explains an unavailable ChatGPT subscription", async () => {
  const source = await readFile(APP_URL, "utf8");

  assert.match(source, /provider\.id === "openai-codex"/);
  assert.match(source, /name: "GPT · ChatGPT 订阅"/);
  assert.match(source, /provider\.id === "openai-codex"[\s\S]*\? "GPT · ChatGPT 订阅"/);
  assert.match(source, /available: false/);
  assert.match(source, /hint: "需在 Pi 中单独连接 ChatGPT 订阅"/);
  assert.match(source, /models: \[\]/);
  assert.match(source, /modelContextWindow=\{selectedProjectWorkModelInfo\?\.contextWindow \?\? null\}/);
});

test("compacting state uses the context-specific status copy", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        status: "compacting",
        turnStatus: "compacting",
        messages: [{
          id: "message-assistant",
          role: "assistant",
          content: "已有首轮回复。",
        }],
        compaction: {
          autoEnabled: true,
          status: "running",
        },
      }),
    }));

    assert.match(html, /正在压缩上下文/);
    assert.doesNotMatch(html, /正在整理上下文|>整理上下文</);
  });
});

test("file artifact reads standalone trees from the conversation route", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const fileArtifactStart = source.indexOf("function FileArtifact");
  const fileArtifactEnd = source.indexOf("function ChangeArtifact", fileArtifactStart);
  const implementation = source.slice(fileArtifactStart, fileArtifactEnd);

  assert.match(implementation, /api\.fetchTree\(\{[\s\S]*conversationId/);
  assert.doesNotMatch(implementation, /fetchTree\(\{ projectId: project\.id/);
});

test("live project workbench renders an immediate preparation state for a new conversation", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: null,
        preparingConversation: true,
      },
    ));

    assert.match(html, /正在准备新工作会话/);
    assert.match(html, /创建会话/);
    assert.doesNotMatch(html, /还没有会话/);
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

test("settled activity is coalesced and collapsed above the final answer", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const events = [
      { seq: 1, type: "message.created", status: "accepted" },
      ...Array.from({ length: 35 }, (_, index) => ({
        seq: index + 2,
        type: "agent.thinking",
        status: "active",
      })),
      { seq: 37, type: "agent.thinking", status: "finished" },
      {
        seq: 38,
        type: "tool.completed",
        toolName: "read",
        path: "src/app.js",
        status: "completed",
      },
    ];
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        messages: [
          { id: "message-user", role: "user", content: "检查项目" },
          { id: "message-assistant", role: "assistant", content: "这是本轮最终答案。" },
        ],
        events,
      }),
    }));

    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /class="project-activity-body" hidden=""/);
    assert.match(html, /已完成/);
    assert.match(html, /2 项 · 查看过程/);
    assert.equal((html.match(/思考完成/g) ?? []).length, 1);
    assert.doesNotMatch(html, /agent\.thinking|37 条记录/);
    assert.ok(
      html.indexOf('aria-label="Pi Agent 活动"') < html.indexOf("这是本轮最终答案。"),
      "completed activity should render before the final answer",
    );
  });
});

test("assistant messages render safe structured Markdown while user text stays literal", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        messages: [
          { id: "message-user", role: "user", content: "**不要格式化我**" },
          {
            id: "message-assistant",
            role: "assistant",
            content: [
              "## 我能完成三类工作",
              "",
              "1. **阅读与分析代码**",
              "2. 使用 `grep` 搜索项目",
              "",
              "> 修改会先等待审阅。",
              "",
              "```js",
              "const ready = true;",
              "```",
              "",
              "<script>window.bad = true</script>",
            ].join("\n"),
          },
        ],
      }),
    }));

    assert.match(html, /class="project-agent-plain-text">\*\*不要格式化我\*\*<\/div>/);
    assert.match(html, /class="project-agent-markdown"/);
    assert.match(html, /<h2>我能完成三类工作<\/h2>/);
    assert.match(html, /<ol>/);
    assert.match(html, /<strong>阅读与分析代码<\/strong>/);
    assert.match(html, /<code>grep<\/code>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<pre><code class="language-js">const ready = true;/);
    assert.doesNotMatch(html, /<script>|window\.bad/);
    assert.doesNotMatch(html, /\*\*阅读与分析代码\*\*/);
  });
});

test("project composer sends on Enter and preserves Shift+Enter for a new line", async () => {
  await withLiveWorkbench(({ handleProjectComposerKeyDown }) => {
    let prevented = 0;
    let submitted = 0;
    const baseEvent = {
      key: "Enter",
      repeat: false,
      preventDefault: () => {
        prevented += 1;
      },
      currentTarget: {
        form: {
          requestSubmit: () => {
            submitted += 1;
          },
        },
      },
      nativeEvent: {
        isComposing: false,
        keyCode: 13,
      },
    };

    handleProjectComposerKeyDown(baseEvent);
    assert.equal(prevented, 1);
    assert.equal(submitted, 1);

    handleProjectComposerKeyDown({ ...baseEvent, shiftKey: true });
    assert.equal(prevented, 1);
    assert.equal(submitted, 1);

    handleProjectComposerKeyDown({ ...baseEvent, metaKey: true });
    assert.equal(prevented, 2);
    assert.equal(submitted, 2);

    handleProjectComposerKeyDown({
      ...baseEvent,
      nativeEvent: { isComposing: true, keyCode: 229 },
    });
    assert.equal(prevented, 2);
    assert.equal(submitted, 2);

    handleProjectComposerKeyDown({ ...baseEvent, repeat: true });
    assert.equal(prevented, 3);
    assert.equal(submitted, 2);

    handleProjectComposerKeyDown({ ...baseEvent, key: "a" });
    assert.equal(prevented, 3);
    assert.equal(submitted, 2);
  });
});

test("running activity stays expanded while historical thinking deltas are coalesced", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        status: "running",
        turnStatus: "running",
        messages: [{ id: "message-user", role: "user", content: "继续检查" }],
        events: [
          { seq: 1, type: "message.created", status: "accepted" },
          ...Array.from({ length: 30 }, (_, index) => ({
            seq: index + 2,
            type: "agent.thinking",
            status: "active",
          })),
        ],
      }),
    }));

    assert.match(html, /Agent 正在工作/);
    assert.match(html, /1 项实时进展/);
    assert.match(html, /aria-expanded="true"/);
    assert.doesNotMatch(html, /class="project-activity-body" hidden=""/);
    assert.equal((html.match(/正在思考/g) ?? []).length, 1);
    assert.doesNotMatch(html, /agent\.thinking|30 条记录/);
  });
});

test("a limited large-project snapshot stays explicit in the activity timeline", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        workspaceSnapshot: {
          includedFiles: 7938,
          includedBytes: 100_663_296,
          truncated: true,
        },
        events: [{
          seq: 2,
          type: "workspace.snapshot_limited",
          title: "大型项目已按安全范围载入",
          detail: "已载入 7938 个可编辑文本文件；未载入的项目文件不会自动进入 Agent 工作区。",
        }],
      }),
    }));

    assert.match(html, /大型项目已按安全范围载入/);
    assert.match(html, /已载入 7938 个可编辑文本文件/);
    assert.match(html, /Agent 不会把未载入范围当成已检查内容/);
    assert.match(html, /请绑定更具体的子文件夹/);
    assert.doesNotMatch(html, /项目超出当前工作快照/);
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
  assert.match(submitImplementation, /images: pendingImage/);
  assert.match(submitImplementation, /capabilities: selectedCapabilityIds/);
  assert.match(submitImplementation, /workflowId: selectedWorkflowId/);
  assert.match(submitImplementation, /const submittedDraft = draft/);
  assert.match(
    submitImplementation,
    /setDraft\(\(current\) => \(\s*current === submittedDraft \? "" : current\s*\)\)/,
  );
  assert.match(submitImplementation, /replacePendingImage\(null\)/);
  assert.match(source, /useState\(\s*readLastArtifact\(/);
});
