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
    assert.match(noConversationHtml, /尚未开始/);
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
    assert.match(emptyConversationHtml, /添加项目文件/);
    assert.match(emptyConversationHtml, /上传 PDF 资料/);
    assert.match(emptyConversationHtml, /普通文件由 AI 按需读取/);
    assert.doesNotMatch(emptyConversationHtml, /MinerU Cloud/);
    assert.doesNotMatch(emptyConversationHtml, /aria-label="项目工件"/);
    assert.doesNotMatch(emptyConversationHtml, /Zotero|Obsidian|阅读镜头/);
  });
});

test("paper material parsing stays visible without exposing the parser or marking the Agent as running", async () => {
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
    assert.match(parsingHtml, /正在解析资料/);
    assert.doesNotMatch(parsingHtml, /MinerU Cloud/);
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

test("execution policy control offers only confirmation and safe auto-review modes", async () => {
  await withLiveWorkbench(({ ProjectExecutionPolicyControl }) => {
    const changes = [];
    const control = ProjectExecutionPolicyControl({
      open: true,
      onOpenChange: () => {},
      executionPolicy: {
        mode: "manual_review",
        revision: 2,
        policyVersion: 1,
      },
      running: false,
      saving: false,
      onChange: (mode) => changes.push(mode),
    });
    const html = renderToStaticMarkup(control);
    assert.match(html, /工作权限/);
    assert.match(html, /需确认/);
    assert.match(html, /替我审批/);
    assert.match(html, /高风险操作直接阻止/);
    assert.doesNotMatch(html, /完全访问/);

    const autoReviewOption = findElement(
      control,
      (element) => (
        element.props.role === "radio"
        && element.props["aria-checked"] === false
      ),
    );
    autoReviewOption.props.onClick();
    assert.deepEqual(changes, ["auto_review"]);

    const runningHtml = renderToStaticMarkup(React.createElement(
      ProjectExecutionPolicyControl,
      {
        open: true,
        onOpenChange: () => {},
        executionPolicy: { mode: "auto_review", revision: 3 },
        running: true,
        onChange: () => {},
      },
    ));
    assert.match(runningHtml, /Agent 工作期间不能更改权限/);
    assert.match(runningHtml, /disabled=""/);
    assert.doesNotMatch(runningHtml, /role="dialog"/);
  });
});

test("preview artifact confirms manual startup and exposes only a ready loopback URL", async () => {
  await withLiveWorkbench(({ PreviewArtifact }) => {
    const requestHash = `sha256:${"0123456789abcdef".repeat(4)}`;
    let starts = 0;
    const manualPreview = {
      id: "preview-manual-1",
      status: "requested",
      executionPolicyMode: "manual_review",
      confirmationRequired: true,
      requestHash,
      recipe: {
        runtime: "vite",
        cwd: "apps/web",
        route: "/reader/",
        command: {
          argv: [
            "--host",
            "127.0.0.1",
            "--port",
            "<assigned-loopback-port>",
            "--strictPort",
          ],
        },
      },
    };
    const manualPanel = React.createElement(PreviewArtifact, {
      preview: manualPreview,
      onStart: () => {
        starts += 1;
      },
    });
    const manualHtml = renderToStaticMarkup(manualPanel);
    assert.match(manualHtml, /等待你确认/);
    assert.match(manualHtml, /核对本机预览/);
    assert.match(manualHtml, /Vite 开发预览/);
    assert.match(manualHtml, /apps\/web/);
    assert.match(manualHtml, /\[&quot;--host&quot;,&quot;127\.0\.0\.1&quot;/);
    assert.match(manualHtml, /01234567…89abcdef/);
    assert.match(manualHtml, /确认启动本机预览/);
    assert.match(manualHtml, /不会安装依赖或运行其他命令/);
    assert.doesNotMatch(manualHtml, /sha256:|requestHash|\/Users\//);

    const startButton = findElement(
      PreviewArtifact({
        preview: manualPreview,
        onStart: () => {
          starts += 1;
        },
      }),
      (node) => (
        node.type === "button"
        && React.Children.toArray(node.props.children).includes("确认启动本机预览")
      ),
    );
    assert.ok(startButton);
    assert.equal(startButton.props.disabled, false);
    startButton.props.onClick();
    assert.equal(starts, 1);

    const readyHtml = renderToStaticMarkup(React.createElement(
      PreviewArtifact,
      {
        preview: {
          status: "ready",
          url: "http://127.0.0.1:48080/reader/",
          title: "读者端",
        },
      },
    ));
    assert.match(readyHtml, /本机预览已就绪/);
    assert.match(readyHtml, /在浏览器打开/);
    assert.match(readyHtml, /http:\/\/127\.0\.0\.1:48080\/reader\//);
    assert.match(
      readyHtml,
      /sandbox="allow-scripts allow-same-origin allow-forms"/,
    );

    const startingHtml = renderToStaticMarkup(React.createElement(
      PreviewArtifact,
      {
        preview: {
          status: "starting",
          url: null,
          title: "读者端",
        },
      },
    ));
    assert.match(startingHtml, /正在启动本机预览/);
    assert.match(startingHtml, /无需手动运行命令/);
    assert.doesNotMatch(startingHtml, /<iframe/);

    const unsafeHtml = renderToStaticMarkup(React.createElement(
      PreviewArtifact,
      {
        preview: {
          status: "ready",
          url: "https://example.com/",
          title: "外部页面",
        },
      },
    ));
    assert.doesNotMatch(unsafeHtml, /<iframe|example\.com/);

    const autoRequestedHtml = renderToStaticMarkup(React.createElement(
      PreviewArtifact,
      {
        preview: {
          ...manualPreview,
          executionPolicyMode: "auto_review",
          confirmationRequired: false,
        },
        onStart: () => {
          starts += 1;
        },
      },
    ));
    assert.match(autoRequestedHtml, /等待自动安全判断/);
    assert.match(autoRequestedHtml, /页面不会自行发起启动/);
    assert.doesNotMatch(autoRequestedHtml, /确认启动本机预览/);
    assert.equal(starts, 1);

    const unsafeRequestHtml = renderToStaticMarkup(React.createElement(
      PreviewArtifact,
      {
        preview: {
          ...manualPreview,
          recipe: {
            ...manualPreview.recipe,
            cwd: "/Users/example/private-project",
            command: {
              argv: ["--config", "/Users/example/private-project/vite.config.js"],
            },
          },
        },
        onStart() {},
      },
    ));
    assert.match(unsafeRequestHtml, /预览信息不完整或无法安全显示/);
    assert.match(unsafeRequestHtml, /disabled=""/);
    assert.doesNotMatch(unsafeRequestHtml, /\/Users\/|private-project/);

    const localErrorHtml = renderToStaticMarkup(React.createElement(
      PreviewArtifact,
      {
        preview: manualPreview,
        error: {
          code: "PROJECT_WORK_PREVIEW_STALE",
          message: "stale /Users/example/private-project",
        },
        onStart() {},
      },
    ));
    assert.match(localErrorHtml, /预览请求已经变化，请重新核对当前面板后再确认/);
    assert.doesNotMatch(localErrorHtml, /\/Users\/|private-project/);
  });
});

test("manual preview uses the injected API only after an explicit hash-bound action", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const actionStart = source.indexOf("const startPreview = useCallback");
  const actionEnd = source.indexOf("const compactContext", actionStart);
  const implementation = source.slice(actionStart, actionEnd);
  const executorStart = source.indexOf("const executeAction = useCallback");
  const executorEnd = source.indexOf("const activeProviderId", executorStart);
  const executor = source.slice(executorStart, executorEnd);

  assert.notEqual(actionStart, -1);
  assert.match(implementation, /preview\?\.status !== "requested"/);
  assert.match(implementation, /preview\.executionPolicyMode !== "manual_review"/);
  assert.match(implementation, /preview\.confirmationRequired !== true/);
  assert.match(implementation, /executeAction\("preview-start"/);
  assert.match(implementation, /api\.startPreview/);
  assert.match(implementation, /conversationId: snapshot\.id/);
  assert.match(implementation, /previewId: preview\.id/);
  assert.match(implementation, /requestHash: preview\.requestHash/);
  assert.match(implementation, /setPreviewError/);
  assert.equal((source.match(/api\.startPreview\(/g) ?? []).length, 1);
  assert.doesNotMatch(implementation, /useEffect|window\.open|location\./);
  assert.match(executor, /const nextSnapshot = await operation\(\)/);
  assert.match(executor, /publishSnapshot\(nextSnapshot\)/);
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

test("current-message capability menu exposes retrieval, explicit image generation, and workflows", async () => {
  await withLiveWorkbench(({ ProjectCapabilityMenu }) => {
    const html = renderToStaticMarkup(React.createElement(
      ProjectCapabilityMenu,
      {
        open: true,
        onOpenChange: () => {},
        capabilityStatus: {
          web_search: { available: true, reason: "Tavily 已配置" },
          docs_search: { available: false, reason: "Context7 尚未配置" },
          image_generation: {
            available: true,
            reason: "ChatGPT 订阅已连接",
          },
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
    assert.match(html, /本轮能力/);
    assert.match(html, /联网搜索/);
    assert.match(html, /生成图片/);
    assert.match(html, /ChatGPT 订阅已连接/);
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
      pendingAttachments: [{
        id: "attachment-1",
        fileName: "检查说明.md",
        byteLength: 20,
        revision: `sha256:${"a".repeat(64)}`,
      }],
      uploadingAttachments: [],
      onRemoveAttachment: () => {},
      onDropFiles: () => {},
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
      /<button type="button" disabled="" aria-label="移除文件：检查说明\.md"/,
    );
    assert.match(html, /AI 按需读取 · 不预载全文/);
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

test("durable ask-user renders text and choice questions without becoming write approval", async () => {
  await withLiveWorkbench(({
    ProjectAgentPane,
    createAskUserAnswerDraft,
    isAskUserAnswerComplete,
    serializeAskUserAnswers,
  }) => {
    const request = {
      id: "ask-user-1",
      status: "pending",
      source: "model_tool",
      questions: [{
        id: "scope",
        label: "修改范围",
        prompt: "需要处理哪些部分？",
        kind: "multiple_choice",
        required: true,
        options: [{
          id: "code",
          label: "代码",
          description: "修改实现文件",
        }, {
          id: "tests",
          label: "测试",
          description: "同步补充测试",
        }],
      }, {
        id: "strategy",
        prompt: "选择实现策略",
        kind: "single_choice",
        required: true,
        options: [{
          id: "small",
          label: "最小改动",
        }, {
          id: "refactor",
          label: "结构调整",
        }],
      }, {
        id: "note",
        prompt: "补充限制",
        kind: "text",
        required: false,
        options: [],
      }],
      answers: [],
    };
    const html = renderToStaticMarkup(React.createElement(ProjectAgentPane, {
      conversation: conversation({
        status: "awaiting_user",
        askUserRequests: [request],
      }),
      draft: "",
      onDraftChange: () => {},
      contextChips: [],
      onRemoveContext: () => {},
      selectedCapabilityIds: [],
      onRemoveCapability: () => {},
      selectedWorkflowId: null,
      onRemoveWorkflow: () => {},
      pendingImage: null,
      onRemoveImage: () => {},
      imageInputRef: { current: null },
      onSelectImage: () => {},
      supportsImages: false,
      onSubmit: () => {},
      onAbort: () => {},
      onAnswerAskUser: () => {},
      onCancelAskUser: () => {},
      onOpenArtifact: () => {},
      action: null,
      error: null,
      modelLabel: "deepseek-v4-flash",
      thinkingLevelControl: null,
      contextUsageControl: null,
      pdfInputRef: { current: null },
      uploadingPdf: null,
      onUploadPdf: () => {},
      onRetryDocument: () => {},
      retryingDocumentId: null,
    }));

    assert.match(html, /Agent 等待你的决定/);
    assert.match(html, /回答只用于明确任务需求，不代表批准任何文件修改/);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /type="radio"/);
    assert.match(html, /aria-label="补充限制"/);
    assert.match(html, /请先回答 Agent 的问题/);
    assert.match(html, /回答需求问题不会批准文件写入/);
    assert.match(html, /<button class="project-agent-primary" type="submit" disabled="">/);

    const initial = createAskUserAnswerDraft(request);
    assert.equal(isAskUserAnswerComplete(request, initial), false);
    const completed = {
      ...initial,
      scope: ["code", "tests"],
      strategy: "small",
      note: "  保持改动克制  ",
    };
    assert.equal(isAskUserAnswerComplete(request, completed), true);
    assert.deepEqual(serializeAskUserAnswers(request, completed), [{
      questionId: "scope",
      value: ["code", "tests"],
    }, {
      questionId: "strategy",
      value: "small",
    }, {
      questionId: "note",
      value: "保持改动克制",
    }]);
  });
});

test("ask-user explains that auto review independently applies only safe changes", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        executionPolicy: {
          mode: "auto_review",
          revision: 2,
          policyVersion: 1,
        },
        askUserRequests: [{
          id: "ask-auto-review",
          status: "pending",
          questions: [{
            id: "scope",
            kind: "text",
            prompt: "需要修改哪些页面？",
            required: true,
          }],
        }],
      }),
    }));

    assert.match(html, /当前为“替我审批”/);
    assert.match(html, /符合安全范围的修改会自动写入/);
    assert.match(html, /超出范围的操作会直接阻止/);
  });
});

test("running composer keeps steer separate from the durable follow-up queue", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench, ProjectAgentPane }) => {
    const runningConversation = conversation({
      status: "running",
      turnStatus: "running",
      followUpQueue: [{
        id: "follow-up-1",
        text: "完成检查后再运行类型检查",
        status: "queued",
      }, {
        id: "follow-up-old",
        text: "已经处理的旧消息",
        status: "delivered",
      }],
    });
    const html = renderToStaticMarkup(React.createElement(ProjectAgentPane, {
      conversation: runningConversation,
      draft: "最后再检查 README",
      onDraftChange: () => {},
      contextChips: [],
      onRemoveContext: () => {},
      selectedCapabilityIds: [],
      onRemoveCapability: () => {},
      selectedWorkflowId: null,
      onRemoveWorkflow: () => {},
      pendingImage: null,
      onRemoveImage: () => {},
      imageInputRef: { current: null },
      onSelectImage: () => {},
      supportsImages: false,
      onSubmit: () => {},
      onAbort: () => {},
      runningMessageMode: "follow_up",
      onRunningMessageModeChange: () => {},
      onRemoveFollowUp: () => {},
      onClearFollowUps: () => {},
      onOpenArtifact: () => {},
      action: null,
      error: null,
      modelLabel: "deepseek-v4-flash",
      thinkingLevelControl: null,
      contextUsageControl: null,
      pdfInputRef: { current: null },
      uploadingPdf: null,
      onUploadPdf: () => {},
      onRetryDocument: () => {},
      retryingDocumentId: null,
    }));

    assert.match(html, /后续队列/);
    assert.match(html, /1 条等待当前 Agent 完成后处理/);
    assert.match(html, /完成检查后再运行类型检查/);
    assert.doesNotMatch(html, /已经处理的旧消息/);
    assert.match(html, /立即调整/);
    assert.match(html, /改变当前工作方向/);
    assert.match(html, /排队后续/);
    assert.match(html, /当前工作结束后处理/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /发送会加入持久后续队列/);
    assert.match(html, /aria-label="加入后续队列"/);

    const workbenchHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      { project, conversation: runningConversation },
    ));
    assert.match(workbenchHtml, /停止并清空队列/);
    assert.match(workbenchHtml, /停止会同时取消尚未处理的后续消息/);
  });
});

test("normal-work control mutations publish durable snapshots and refresh queue deletions", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const submitStart = source.indexOf("const submitMessage = useCallback");
  const submitEnd = source.indexOf("const selectImage", submitStart);
  const submitImplementation = source.slice(submitStart, submitEnd);
  const controlStart = source.indexOf("const removeFollowUp = useCallback");
  const controlEnd = source.indexOf("const headerTitle", controlStart);
  const controlImplementation = source.slice(controlStart, controlEnd);

  assert.match(submitImplementation, /runningMessageMode === "follow_up"/);
  assert.match(submitImplementation, /api\.enqueueFollowUp/);
  assert.match(submitImplementation, /\.then\(\(result\) => result\.snapshot\)/);
  assert.match(submitImplementation, /api\.steerConversation/);
  assert.match(controlImplementation, /api\.removeFollowUp/);
  assert.match(controlImplementation, /api\.clearFollowUps/);
  assert.match(controlImplementation, /api\.fetchConversation/);
  assert.match(controlImplementation, /api\.answerAskUserRequest/);
  assert.match(controlImplementation, /api\.cancelAskUserRequest/);
  assert.match(controlImplementation, /尚未处理的 \$\{queuedCount\} 条后续消息会同时取消/);
  assert.doesNotMatch(controlImplementation, /applyChangeSet|proposalHash/);
});

test("live workbench keeps a bounded polling watchdog beside incremental EventSource", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const effectStart = source.indexOf(
    "function schedulePoll()",
  );
  const effectEnd = source.indexOf(
    "useEffect(() => {\n    const changeSet",
    effectStart,
  );
  const implementation = source.slice(effectStart, effectEnd);

  assert.notEqual(effectStart, -1);
  assert.notEqual(effectEnd, -1);
  assert.match(implementation, /api\.subscribeConversation/);
  assert.match(
    implementation,
    /afterSeq: snapshotRef\.current\?\.lastEventSeq \?\? 0/,
  );
  assert.match(implementation, /mergeIncrementalConversationSnapshot/);
  assert.match(
    implementation,
    /refreshSnapshot\(\{\s*continuePolling: shouldPollConversation,\s*\}\)/,
  );
  assert.match(implementation, /if \(shouldPollConversation\)/);
  assert.match(implementation, /api\.fetchConversation/);
  assert.match(implementation, /unsubscribe\?\.\(\)/);
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

test("completed Image2 output renders in the conversation with subscription usage evidence", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          messages: [{
            id: "message-user-image-generation",
            role: "user",
            turnId: "turn-image-1",
            content: "生成一张深青色陶瓷球体",
          }, {
            id: "message-assistant-image-generation",
            role: "assistant",
            turnId: "turn-image-1",
            content: "图片已经生成。",
          }],
          generatedImages: [{
            id: "image-1",
            turnId: "turn-image-1",
            status: "completed",
            prompt: "暖象牙背景上的深青色陶瓷球体",
            fileName: "image-1.png",
            mimeType: "image/png",
            byteLength: 1_885_527,
            width: 1254,
            height: 1254,
            modelId: "gpt-image-2",
            usage: { totalTokens: 35_258 },
          }],
        }),
      },
    ));

    assert.match(html, /GPT Image 2/);
    assert.match(html, /1254 × 1254/);
    assert.match(html, /35,258 tokens/);
    assert.match(html, /ChatGPT 订阅 · 未提供单次价格/);
    assert.match(
      html,
      /generated-images\/image-1\/content/,
    );
    assert.match(html, /在文件中查看/);
    assert.doesNotMatch(html, /Users\/|generated_images/);
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
  const policyIndex = composerImplementation.indexOf("{executionPolicyControl}");
  const modelIndex = composerImplementation.indexOf("project-composer-model");
  const thinkingIndex = composerImplementation.indexOf("{thinkingLevelControl}");
  const contextIndex = composerImplementation.indexOf("{contextUsageControl}");
  assert.ok(providerIndex >= 0 && providerIndex < capabilitiesIndex);
  assert.doesNotMatch(headerImplementation, /ProjectContextUsageMenu/);
  assert.ok(policyIndex >= 0 && policyIndex < modelIndex);
  assert.ok(modelIndex < thinkingIndex);
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

test("composer execution policy menu expands above its trigger", async () => {
  const styles = await readFile(STYLES_URL, "utf8");
  const selectorStart = styles.indexOf(
    ".project-agent-composer .project-execution-policy-popover",
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

test("file artifact uses server paging, explicit search, overlay labels, and safe image URLs", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const fileArtifactStart = source.indexOf("const PROJECT_FILE_TREE_PAGE_SIZE = 160");
  const fileArtifactEnd = source.indexOf(
    "const GIT_EVIDENCE_VISIBLE_PATHS",
    fileArtifactStart,
  );
  const implementation = source.slice(fileArtifactStart, fileArtifactEnd);

  assert.notEqual(fileArtifactStart, -1);
  assert.match(
    implementation,
    /api\.fetchTree\(\{[\s\S]*limit: PROJECT_FILE_TREE_PAGE_SIZE,[\s\S]*cursor:/,
  );
  assert.match(
    implementation,
    /api\.fetchTree\(\{[\s\S]*query: normalized,[\s\S]*limit: PROJECT_FILE_TREE_PAGE_SIZE/,
  );
  assert.match(implementation, /role="search"/);
  assert.match(implementation, /搜索文件名或路径/);
  assert.match(implementation, /继续加载搜索结果/);
  assert.match(implementation, /Agent 新建/);
  assert.match(implementation, /Agent 已修改/);
  assert.match(
    implementation,
    /api\.imageUrl\(\{ conversationId, path: activePath \}\)/,
  );
  assert.match(implementation, /<img[\s\S]*src=\{selectedImageUrl\}/);
  assert.match(implementation, /onError=\{\(\) => setImageLoadFailed\(true\)\}/);
  assert.match(
    implementation,
    /PROJECT_FILE_IMAGE_PATTERN\.test\(path\)[\s\S]{0,240}return;/,
  );
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
    assert.match(html, /正在创建/);
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

test("a blocked auto-review change stays inspectable without an apply action", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        activeArtifactId: "changes",
        pendingChangeSet: {
          id: "change-set-blocked",
          status: "blocked",
          blockedReason: "change_set_line_limit",
          proposalHash: "sha256:blocked-proposal",
          files: [{
            id: "file-change-blocked",
            path: "src/app.js",
            operation: "modify",
            additions: 5_001,
            deletions: 1,
            actionable: false,
            selected: true,
            baseHash: "sha256:before",
            afterHash: "sha256:after",
            diff: ["--- a/src/app.js", "+++ b/src/app.js"],
          }],
        },
      }),
    }));

    assert.match(html, /修改已被替我审批阻止/);
    assert.match(html, /修改行数超出自动审批范围/);
    assert.match(html, /只可查看，不能应用/);
    assert.doesNotMatch(html, /确认应用所选修改/);
  }, { exposeArtifact: true });
});

test("a blocked auto-review verification is shown as never executed", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        activeArtifactId: "run_result",
        verificationRuns: [{
          id: "verification-blocked",
          status: "blocked",
          blockedReason: "verification_isolation_unavailable",
          command: "node --test",
          checks: [],
          logs: [],
        }],
      }),
    }));

    assert.match(html, /验证已阻止/);
    assert.match(html, /当前没有隔离运行环境，验证命令没有自动执行/);
    assert.match(html, /未启动本机进程/);
    assert.doesNotMatch(html, /命令没有产生输出/);
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
          outputCompression: {
            applied: true,
            rawBytes: 4096,
            compactBytes: 512,
          },
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
    assert.match(html, /查看完整已采集日志/);
    assert.match(html, /完整日志保留在这里/);
    assert.match(html, /4\.0 KB/);
    assert.match(html, /512 B/);
    assert.match(html, /退出码 1/);
    assert.match(html, /修复后验证通过/);
    assert.match(html, /1 test passed/);
    assert.match(html, /退出码 0/);
  }, { exposeArtifact: true });
});

test("pending changes can be verified inside the isolated workspace before apply", async () => {
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

    assert.match(html, />运行验证</);
    assert.match(html, /在隔离工作区运行/);
    assert.match(html, /待审阅修改不会提前写入真实项目/);
    assert.doesNotMatch(html, /先审阅修改|等待修改确认|验证才会变为可运行/);
  }, { exposeArtifact: true });
});

test("settled turns expose paged history, unread state, retry, and per-turn evidence", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        unreadCount: 2,
        latestMessageSeq: 10,
        lastReadMessageSeq: 7,
        readState: {
          latestAssistantMessageSeq: 10,
          unreadCount: 2,
        },
        messages: [{
          id: "message-user-5",
          role: "user",
          kind: "message",
          content: "检查失败后修复",
          messageSeq: 9,
          turnId: "turn-5",
          turnSeq: 5,
        }, {
          id: "message-assistant-5",
          role: "assistant",
          kind: "message",
          content: "已经修复并复测通过。",
          messageSeq: 10,
          turnId: "turn-5",
          turnSeq: 5,
          attempt: 2,
          turnEvidence: {
            providerId: "openai-codex",
            modelId: "gpt-5.3-codex",
            thinkingLevel: "high",
            usage: {
              totalTokens: 1536,
              costUsd: 0.0123,
            },
          },
        }],
      }),
    }));

    assert.match(html, /加载更早记录/);
    assert.match(html, /2 条未读/);
    assert.match(html, /重试上一轮/);
    assert.doesNotMatch(html, /class="project-agent-header"/);
    assert.ok(
      html.indexOf("透明模式") < html.indexOf('class="project-agent-stream"'),
      "transparent mode should live in the shared top bar",
    );
    assert.ok(
      html.indexOf("重试上一轮") < html.indexOf('class="project-agent-stream"'),
      "retry should live in the shared top bar",
    );
    assert.match(html, /openai-codex · gpt-5\.3-codex/);
    assert.match(html, /1,536 tokens/);
    assert.match(html, /\$0\.0123/);
    assert.match(html, /第 2 次回答/);
  });
});

test("interrupted verification repair waits for an explicit resume action", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        activeArtifactId: "run_result",
        operations: [{
          id: "operation-repair-1",
          type: "verification_repair",
          status: "interrupted",
          repairAttemptCount: 1,
          maxRepairAttempts: 2,
        }],
        verificationCommand: {
          id: "command-test-repair",
          label: "前端测试",
          displayCommand: "npm test",
          resolvedScript: "node --test",
          cwdLabel: "隔离工作区",
        },
      }),
    }));

    assert.match(html, /修复与复测尚未完成/);
    assert.match(html, /继续修复并复测/);
    assert.match(html, /继续会再次调用当前模型/);
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
    assert.match(html, /透明模式/);
    assert.doesNotMatch(html, /Harness 快照/);
    assert.match(html, /查看与检索了 1 次/);
    assert.equal((html.match(/思考完成/g) ?? []).length, 1);
    assert.doesNotMatch(html, /agent\.thinking|37 条记录/);
    assert.ok(
      html.indexOf('aria-label="Pi Agent 活动"') < html.indexOf("这是本轮最终答案。"),
      "completed activity should render before the final answer",
    );
  });
});

test("agent insight shows a safe harness snapshot and compact turn totals", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const events = [
      {
        seq: 1,
        type: "message.created",
        at: "2026-07-28T02:00:00.000Z",
      },
      {
        seq: 2,
        type: "harness.snapshot",
        at: "2026-07-28T02:00:00.100Z",
        data: {
          harnessVersion: "project-work-v1",
          providerId: "openai-codex",
          modelId: "gpt-5.3-codex",
          thinkingLevel: "high",
          activeTools: ["read", "grep"],
          skills: ["pi"],
          context: {
            workspace: "bound_project",
            snapshot: "current",
            projectRules: 1,
          },
          prompt: {
            layers: ["Pi SDK 基础提示", "项目审阅工作区规则", "当前回合指令"],
          },
        },
      },
      {
        seq: 3,
        type: "turn.started",
        at: "2026-07-28T02:00:00.200Z",
      },
      {
        seq: 4,
        type: "tool.started",
        toolName: "read",
        toolCallId: "read-1",
        at: "2026-07-28T02:00:01.000Z",
      },
      {
        seq: 5,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-1",
        status: "completed",
        at: "2026-07-28T02:00:02.000Z",
      },
      {
        seq: 6,
        type: "turn.completed",
        at: "2026-07-28T02:00:03.000Z",
        data: {
          usage: {
            totalTokens: 1_240,
          },
        },
      },
      {
        seq: 7,
        type: "conversation.read",
        at: "2026-07-31T02:00:03.000Z",
      },
    ];
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events,
      running: false,
      compact: true,
      transparentMode: true,
      onOpenArtifact: () => {},
    }));

    assert.match(html, /Agent 透视/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /1 轮模型 · 1 次工具 · 3 秒 · 1\.2k Token/);
    assert.match(html, /Harness 快照/);
    assert.match(html, /openai-codex \/ gpt-5\.3-codex/);
    assert.match(html, /读取文件、搜索内容/);
    assert.match(html, /本轮未启用 Skill|pi/);
    assert.match(html, /私有推理、密钥与未脱敏内容不会进入浏览器/);
  });
});

test("repeated file inspection stays in one public activity layer", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const events = [
      { seq: 1, type: "message.created", status: "accepted" },
      ...Array.from({ length: 8 }, (_, index) => ({
        seq: index + 2,
        type: "tool.completed",
        toolName: index % 2 === 0 ? "read" : "grep",
        toolCallId: `inspect-${index + 1}`,
        path: `src/file-${index + 1}.js`,
        status: "completed",
      })),
    ];
    const normalized = normalizeActivityEvents(events, false);

    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].type, "activity.research_summary");
    assert.equal(normalized[0].title, "查看与检索了 8 次");
    assert.equal(normalized[0].detail, "项目资料 8 次");
  });
});

test("activity normalization collapses tool lifecycles into counted public summaries", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "agent.thinking", status: "active" },
      {
        seq: 3,
        type: "tool.started",
        toolName: "read",
        toolCallId: "read-1",
        path: "src/a.js",
      },
      {
        seq: 4,
        type: "tool.progress",
        toolName: "read",
        toolCallId: "read-1",
        path: "src/a.js",
      },
      {
        seq: 5,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-1",
        path: "src/a.js",
        status: "completed",
      },
      {
        seq: 6,
        type: "tool.started",
        toolName: "grep",
        toolCallId: "grep-1",
      },
      {
        seq: 7,
        type: "tool.completed",
        toolName: "grep",
        toolCallId: "grep-1",
        status: "completed",
      },
      {
        seq: 8,
        type: "tool.completed",
        toolName: "read_document",
        toolCallId: "document-1",
        status: "completed",
      },
      {
        seq: 9,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-failed",
        path: "src/missing.js",
        status: "failed",
      },
      {
        seq: 10,
        type: "plan.updated",
        status: "completed",
      },
      {
        seq: 11,
        type: "change_set.ready",
        status: "clean",
        data: { stats: { files: 0 } },
      },
      { seq: 12, type: "agent.thinking", status: "finished" },
    ], false);

    assert.equal(normalized.length, 3);
    assert.equal(normalized[0].type, "activity.research_summary");
    assert.equal(normalized[0].title, "查看与检索了 3 次");
    assert.equal(normalized[0].detail, "项目资料 2 次 · 会话资料 1 次");
    assert.deepEqual(normalized[0].counts, {
      project: 2,
      document: 1,
      retrieval: 0,
    });
    assert.equal(normalized[1].toolCallId, "read-failed");
    assert.equal(normalized[1].status, "failed");
    assert.equal(normalized[2].type, "agent.thinking");
    assert.equal(normalized[2].status, "finished");
  });
});

test("activity normalization hides bookkeeping events without dropping public work", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "workspace.recorded", status: "completed" },
      { seq: 3, type: "conversation.read", status: "completed" },
      { seq: 4, type: "agent.thinking", status: "active" },
      {
        seq: 5,
        type: "tool.completed",
        toolName: "edit",
        toolCallId: "edit-1",
        path: "src/app.js",
        status: "completed",
      },
      {
        seq: 6,
        type: "change_set.ready",
        status: "ready",
        data: { stats: { files: 1 } },
      },
      { seq: 7, type: "agent.thinking", status: "finished" },
    ], false);

    assert.deepEqual(
      normalized.map((event) => event.type),
      ["tool.completed", "change_set.ready", "agent.thinking"],
    );
    assert.doesNotMatch(
      JSON.stringify(normalized),
      /workspace\.recorded|conversation\.read/,
    );
  });
});

test("a running turn always exposes a truthful public phase before tools or thinking arrive", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const starting = normalizeActivityEvents([
      { seq: 11, type: "message.created", status: "accepted" },
      { seq: 12, type: "agent.status", status: "running" },
    ], true);
    assert.equal(starting.length, 1);
    assert.equal(starting[0].type, "activity.preparing");
    assert.equal(starting[0].title, "正在准备本轮工作");
    assert.match(starting[0].detail, /已接收任务/);

    const submitting = normalizeActivityEvents([], true, "submitting");
    assert.equal(submitting[0].title, "正在提交本轮任务");
    assert.match(submitting[0].detail, /连接 Pi 会话/);

    const responding = normalizeActivityEvents([
      { seq: 20, type: "message.created", status: "accepted" },
      {
        seq: 21,
        type: "message.partial",
        messageId: "assistant-current",
        text: "正在形成回答",
      },
    ], true);
    assert.equal(responding[0].type, "activity.responding");
    assert.equal(responding[0].title, "正在生成公开回复");
  });
});

test("the latest safe partial answer renders as one replaceable streaming bubble", async () => {
  await withLiveWorkbench(({
    latestStreamingAssistant,
    LiveProjectWorkbench,
  }) => {
    const events = [
      { seq: 20, type: "message.created", status: "accepted" },
      {
        seq: 21,
        type: "message.partial",
        messageId: "assistant-current",
        text: "第一段",
      },
      {
        seq: 22,
        type: "message.partial",
        messageId: "assistant-current",
        text: "第一段和第二段",
      },
    ];
    assert.deepEqual(
      latestStreamingAssistant(events, [], true),
      {
        id: "assistant-current",
        text: "第一段和第二段",
        seq: 22,
        turnId: null,
      },
    );
    assert.equal(latestStreamingAssistant(events, [], false), null);
    assert.equal(
      latestStreamingAssistant(events, [{
        id: "assistant-current",
        role: "assistant",
        content: "最终回答",
      }], true),
      null,
    );

    const html = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          status: "running",
          turnStatus: "running",
          messages: [{ id: "message-user", role: "user", content: "继续检查" }],
          events,
        }),
      },
    ));
    assert.match(html, /Pi Agent · 生成中/);
    assert.match(html, /第一段和第二段/);
    assert.match(html, /aria-label="Pi Agent 正在生成回复"/);
    assert.equal((html.match(/第一段和第二段/g) ?? []).length, 1);
  });
});

test("activity normalization distinguishes prepared and actually run verification commands", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      {
        seq: 2,
        type: "tool.started",
        toolName: "request_verification",
        toolCallId: "request-1",
      },
      {
        seq: 3,
        type: "tool.completed",
        toolName: "request_verification",
        toolCallId: "request-1",
        status: "completed",
      },
      {
        seq: 4,
        type: "verification.requested",
        eventId: "command-1",
        status: "requested",
      },
      {
        seq: 5,
        type: "verification.started",
        eventId: "run-1",
      },
      {
        seq: 6,
        type: "verification.completed",
        eventId: "run-1",
        status: "passed",
      },
      {
        seq: 7,
        type: "verification.completed",
        eventId: "run-failed",
        status: "failed",
      },
    ], false);

    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].type, "activity.command_summary");
    assert.equal(normalized[0].title, "运行了 1 条验证命令");
    assert.equal(normalized[0].detail, "已准备 1 条 · 已运行 1 条");
    assert.equal(normalized[1].type, "verification.completed");
    assert.equal(normalized[1].status, "failed");
    assert.doesNotMatch(JSON.stringify(normalized), /request_verification/);
  });
});

test("auto-review decisions state whether safe work was allowed or risky work blocked", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        executionPolicy: {
          mode: "auto_review",
          revision: 4,
          policyVersion: 1,
        },
        events: [{
          seq: 1,
          type: "auto_review.decision",
          decision: "allow",
          reasonCode: "safe_bounded_verification",
        }, {
          seq: 2,
          type: "auto_review.decision",
          decision: "deny",
          reasonCode: "verification_command_not_auto_safe",
        }],
      }),
    }));

    assert.match(html, /已自动放行安全操作/);
    assert.match(html, /验证命令已通过安全范围校验/);
    assert.match(html, /已阻止高风险操作/);
    assert.match(html, /验证命令不在自动审批的安全范围内/);
    assert.match(html, /安全修改会自动继续，高风险操作会被阻止/);
    assert.match(html, /安全修改自动继续/);
    assert.match(html, /高风险操作会阻止/);
    assert.match(html, /project-execution-policy-trigger is-auto/);
    assert.doesNotMatch(html, /完全访问/);
  });
});

test("auto-review explains when verification is blocked behind a denied change", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        events: [{
          seq: 1,
          type: "auto_review.decision",
          decision: "deny",
          reasonCode: "change_set_not_auto_applied",
        }],
      }),
    }));

    assert.match(html, /修改未通过自动审批，后续验证没有运行/);
  });
});

test("project stream follows only while the reader remains near the bottom", async () => {
  await withLiveWorkbench(({ isNearProjectStreamBottom }) => {
    assert.equal(isNearProjectStreamBottom({
      scrollHeight: 1_000,
      clientHeight: 500,
      scrollTop: 428,
    }), true);
    assert.equal(isNearProjectStreamBottom({
      scrollHeight: 1_000,
      clientHeight: 500,
      scrollTop: 427,
    }), false);
    assert.equal(isNearProjectStreamBottom({
      scrollHeight: 500,
      clientHeight: 500,
      scrollTop: 0,
    }), true);
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
    assert.match(html, /<details class="is-thinking" open="">/);
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
  assert.match(source, /role="listbox"/);
  assert.match(source, /aria-activedescendant=/);
  assert.doesNotMatch(source, /selectedFile\.lines\.map[\s\S]{0,600}<button/);
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

test("workspace status explains isolation and recovery without exposing runtime details", async () => {
  await withLiveWorkbench(({ ProjectWorkspaceStatus }) => {
    const readyHtml = renderToStaticMarkup(React.createElement(ProjectWorkspaceStatus, {
      workspace: {
        kind: "sparse_overlay",
        isolation: "review_overlay",
        recovery: "apply_journal_v1",
        status: "ready",
      },
    }));
    assert.match(readyHtml, /修改在隔离副本中准备/);
    assert.match(readyHtml, /真实项目只会在你确认更改后更新/);

    const recoveringHtml = renderToStaticMarkup(React.createElement(ProjectWorkspaceStatus, {
      workspace: { status: "recovering" },
    }));
    assert.match(recoveringHtml, /正在恢复上次文件操作/);
    assert.match(recoveringHtml, /完成核对前不会继续写入项目文件/);

    const blockedHtml = renderToStaticMarkup(React.createElement(ProjectWorkspaceStatus, {
      workspace: { status: "recovery_blocked" },
    }));
    assert.match(blockedHtml, /上次文件操作需要检查/);
    assert.match(blockedHtml, /role="alert"/);

    const combinedHtml = `${readyHtml}${recoveringHtml}${blockedHtml}`;
    assert.doesNotMatch(
      combinedHtml,
      /sparse_overlay|review_overlay|apply_journal_v1|\/Users\//,
    );
  });
});

test("change evidence keeps Git read-only and offers one confirmed apply undo", async () => {
  await withLiveWorkbench(({ ChangeEvidencePanel }) => {
    const applyRecord = {
      id: "apply-1",
      status: "applied",
      files: [
        { id: "file-1", path: "src/App.jsx" },
        { id: "file-2", path: "src/styles.css" },
      ],
      undo: {
        status: "available",
        hash: "sha256:undo-1",
      },
    };
    let undoTarget = null;
    const props = {
      gitEvidence: {
        available: true,
        branch: "codex/runtime",
        head: "1234567890abcdef",
        staged: ["src/staged.js"],
        unstaged: ["src/changed.js"],
        untracked: ["src/new.js"],
        truncated: false,
      },
      gitStatus: "ready",
      onRefreshGit: () => {},
      workspace: { status: "ready" },
      applyJournal: [applyRecord],
      onUndoApply: (record) => {
        undoTarget = record;
      },
    };
    const panel = ChangeEvidencePanel(props);
    const html = renderToStaticMarkup(panel);

    assert.match(html, /Git 只读状态/);
    assert.match(html, /codex\/runtime · 12345678/);
    assert.match(html, /已暂存/);
    assert.match(html, /src\/staged\.js/);
    assert.match(html, /未暂存/);
    assert.match(html, /src\/changed\.js/);
    assert.match(html, /未跟踪/);
    assert.match(html, /src\/new\.js/);
    assert.match(html, /这里只读查看，不会暂存、提交或推送/);
    assert.match(html, /文件应用记录/);
    assert.match(html, /已应用并核验/);
    assert.match(html, /撤销这次应用/);
    assert.doesNotMatch(html, /sparse_overlay|review_overlay|apply_journal_v1|\/Users\//);

    const undoButton = findElement(
      panel,
      (node) => (
        node.type === "button"
        && React.Children.toArray(node.props.children).includes("撤销这次应用")
      ),
    );
    assert.ok(undoButton);
    undoButton.props.onClick();
    assert.equal(undoTarget, applyRecord);
  });
});

test("change evidence loads only for its artifact and binds undo to the durable hash", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const artifactStart = source.indexOf("function ArtifactPane");
  const artifactEnd = source.indexOf("export function LiveProjectWorkbench", artifactStart);
  const artifactImplementation = source.slice(artifactStart, artifactEnd);
  const undoStart = source.indexOf("const undoAppliedChanges = useCallback");
  const undoEnd = source.indexOf("const runVerification", undoStart);
  const undoImplementation = source.slice(undoStart, undoEnd);

  assert.notEqual(artifactStart, -1);
  assert.match(artifactImplementation, /activeArtifactId !== "changes"/);
  assert.match(artifactImplementation, /api\.fetchGitEvidence/);
  assert.match(artifactImplementation, /onRefreshGit=\{loadGitEvidence\}/);
  assert.match(undoImplementation, /window\.confirm/);
  assert.match(undoImplementation, /api\.undoApply/);
  assert.match(undoImplementation, /undoHash: record\.undo\.hash/);
  assert.match(undoImplementation, /任何外部变化都会阻止撤销/);
  assert.match(undoImplementation, /不会暂存、提交或推送/);
  assert.doesNotMatch(undoImplementation, /git\s+(?:add|commit|push)/i);
});

test("large project files keep one bounded listbox focus surface", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const fileArtifactStart = source.indexOf("const PROJECT_FILE_VISIBLE_LINE_LIMIT = 400");
  const fileArtifactEnd = source.indexOf(
    "const GIT_EVIDENCE_VISIBLE_PATHS",
    fileArtifactStart,
  );
  const fileArtifact = source.slice(fileArtifactStart, fileArtifactEnd);

  assert.notEqual(fileArtifactStart, -1);
  assert.match(fileArtifact, /\.slice\(0, PROJECT_FILE_VISIBLE_LINE_LIMIT\)/);
  assert.match(fileArtifact, /role="listbox"/);
  assert.match(fileArtifact, /tabIndex=\{0\}/);
  assert.match(fileArtifact, /aria-activedescendant=/);
  assert.match(fileArtifact, /role="option"/);
  assert.match(fileArtifact, /visibleFileLines\.map/);
  assert.doesNotMatch(
    fileArtifact,
    /visibleFileLines\.map\([\s\S]{0,500}<button/,
  );
  assert.doesNotMatch(fileArtifact, /role="option"[\s\S]{0,160}tabIndex=/);
});
