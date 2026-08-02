import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
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

let sharedWorkbench = null;
let sharedArtifactWorkbench = null;

async function createSharedWorkbench(exposeArtifact) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    plugins: exposeArtifact ? [artifactLayoutStub] : [],
    server: { middlewareMode: true },
  });
  try {
    return {
      vite,
      module: await vite.ssrLoadModule(COMPONENT_PATH),
    };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

async function withLiveWorkbench(callback, { exposeArtifact = false } = {}) {
  const key = exposeArtifact ? "artifact" : "standard";
  let workbench = exposeArtifact ? sharedArtifactWorkbench : sharedWorkbench;
  if (!workbench) {
    workbench = createSharedWorkbench(exposeArtifact);
    if (key === "artifact") sharedArtifactWorkbench = workbench;
    else sharedWorkbench = workbench;
  }
  const loaded = await workbench;
  return callback(loaded.module);
}

after(async () => {
  const workbenches = await Promise.all(
    [sharedWorkbench, sharedArtifactWorkbench].filter(Boolean),
  );
  await Promise.all(workbenches.map(({ vite }) => vite.close()));
});

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
    assert.match(emptyConversationHtml, /添加本地资料/);
    assert.match(emptyConversationHtml, /aria-label="选择要添加的本地资料"/);
    assert.match(emptyConversationHtml, /type="file" multiple=""/);
    assert.doesNotMatch(emptyConversationHtml, /accept=/);
    assert.match(emptyConversationHtml, /会话资料由 AI 按需读取/);
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

    const nativeHtml = renderToStaticMarkup(React.createElement(
      ProjectExecutionPolicyControl,
      {
        open: true,
        onOpenChange: () => {},
        executionPolicy: { mode: "native", revision: 1 },
        running: false,
        onChange: () => {},
      },
    ));
    assert.match(nativeHtml, /Pi 原生/);
    assert.match(nativeHtml, /可信 Workspace/);
    assert.match(nativeHtml, /disabled=""/);
    assert.doesNotMatch(nativeHtml, /role="dialog"/);
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

test("a pending model selection locks both thinking-strength entry points", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  assert.match(
    source,
    /const thinkingBusy = modelSelectionDisabled\s*\|\| conversationRunning/,
  );
  assert.match(
    source,
    /conversationRunning\s*\|\| modelSelectionDisabled\s*\|\| !snapshot\?\.id/,
  );
  assert.match(source, /thinkingDisabled=\{thinkingBusy \|\| thinkingSaving\}/);
  assert.match(source, /<ProjectThinkingLevelControl[\s\S]*?running=\{thinkingBusy\}/);
  assert.match(source, /&& !modelSelectionDisabled\s*&& uploadingAttachments/);
  assert.match(
    source,
    /\|\| action\s*\|\| modelSelectionDisabled\s*\|\| uploadingAttachments/,
  );
  assert.match(
    source,
    /<ProjectAgentPane[\s\S]*?modelSelectionDisabled=\{modelSelectionDisabled\}/,
  );

  await withLiveWorkbench(({ ProjectAgentPane }) => {
    const html = renderToStaticMarkup(React.createElement(ProjectAgentPane, {
      conversation: conversation(),
      draft: "这条消息必须等模型保存完成",
      onDraftChange: () => {},
      contextChips: [],
      onRemoveContext: () => {},
      selectedCapabilityIds: [],
      onRemoveCapability: () => {},
      selectedWorkflowId: null,
      onRemoveWorkflow: () => {},
      pendingImage: null,
      onRemoveImage: () => {},
      onSubmit: () => {},
      onOpenArtifact: () => {},
      action: null,
      modelSelectionDisabled: true,
    }));
    assert.match(html, /type="submit"[^>]*disabled=""/);
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
    assert.match(html, /GitHub 只读/);
    assert.match(html, /Vercel 只读/);
    assert.doesNotMatch(html, /Canva|可画|Figma|Sketch|Zotero|Obsidian/);
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
      localFileInputRef: { current: null },
      supportsImages: true,
      onSubmit: () => {},
      onAbort: () => {},
      onOpenArtifact: () => {},
      action: "message",
      error: null,
      modelLabel: "vision-model",
      thinkingLevelControl: null,
      contextUsageControl: null,
      uploadingPdf: null,
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
      /project-composer-attachment" type="button" disabled="" title="从电脑选择资料；未知后缀会按实际内容检查/,
    );
    assert.match(
      html,
      /type="file" multiple="" disabled="" aria-label="选择要添加的本地资料"/,
    );
    assert.doesNotMatch(html, /accept=/);
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
      localFileInputRef: { current: null },
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
      uploadingPdf: null,
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
      localFileInputRef: { current: null },
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
      uploadingPdf: null,
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

test("live workbench uses polling only while EventSource is unavailable or reconnecting", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const effectStart = source.indexOf(
    "function scheduleHydration()",
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
    /afterSeq: conversationEventResumeSeq\(snapshotRef\.current\)/,
  );
  assert.match(implementation, /mergeIncrementalConversationSnapshot/);
  assert.match(implementation, /applyProjectWorkEventDelta/);
  assert.match(implementation, /pendingStreamEvents\.push\(event\)/);
  assert.match(implementation, /window\.requestAnimationFrame/);
  assert.match(implementation, /flushPendingStreamEvents/);
  assert.match(implementation, /onConnectionState/);
  assert.match(implementation, /streamConnected = state === "connected"/);
  assert.match(implementation, /if \(!unsubscribe && shouldPollConversationRef\.current\)/);
  assert.match(implementation, /!streamConnected && shouldPollConversationRef\.current/);
  assert.doesNotMatch(implementation, /if \(shouldPollConversation\) \{\s*schedulePoll/);
  assert.match(implementation, /api\.fetchConversation/);
  assert.match(implementation, /includeActivity = false/);
  assert.match(implementation, /onHeartbeat/);
  assert.match(implementation, /lastStreamActivityAt/);
  assert.match(implementation, /refreshSnapshot\(\{ includeActivity: true \}\)/);
  assert.match(implementation, /unsubscribe\?\.\(\)/);
});

test("normal-work mobile views keep the old Agent conversation and artifact reachable", async () => {
  const appSource = await readFile(APP_URL, "utf8");
  const workbenchStart = appSource.indexOf("<LiveProjectWorkbench");
  const workbenchEnd = appSource.indexOf("/>", workbenchStart);
  const wiring = appSource.slice(workbenchStart, workbenchEnd);
  assert.match(wiring, /mobileActive=\{mobileView === "agent" \|\| mobileView === "artifact"\}/);
  assert.match(wiring, /mobileView=\{mobileView\}/);
  assert.match(wiring, /onMobileViewChange=\{setMobileView\}/);

  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const oldConversation = conversation({
      messages: [{
        id: "message-user",
        role: "user",
        content: "继续使用之前的会话窗",
      }, {
        id: "message-assistant",
        role: "assistant",
        content: "原生 Pi 和历史工件都还在。",
        status: "completed",
      }],
    });
    const agentHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: oldConversation,
        mobileActive: true,
        mobileView: "agent",
      },
    ));
    assert.match(agentHtml, /reading-workbench agent-artifact-layout is-mobile-active/);
    assert.match(agentHtml, /reading-agent-pane is-mobile-active/);
    assert.match(agentHtml, /继续使用之前的会话窗/);
    assert.match(agentHtml, /原生 Pi 和历史工件都还在/);

    const artifactHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: oldConversation,
        mobileActive: true,
        mobileView: "artifact",
      },
    ));
    assert.match(artifactHtml, /reading-artifact-pane is-mobile-active/);
    assert.match(artifactHtml, /aria-label="项目工件"/);
  });
});

test("workspace run logs load only while the run artifact is visible and explicitly expanded", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const effectStart = source.indexOf("const workspaceRunRevision");
  const effectEnd = source.indexOf("const removeFollowUp", effectStart);
  const implementation = source.slice(effectStart, effectEnd);

  assert.notEqual(effectStart, -1);
  assert.match(implementation, /workspaceRunsToLoad/);
  assert.match(implementation, /api\.fetchWorkspaceRun/);
  assert.match(implementation, /runArtifactVisible/);
  assert.match(implementation, /workspaceRunLogStateRef\.current\.delete\(runId\)/);
  assert.doesNotMatch(implementation, /\.filter\(\(run\) => run\.runId\);/);

  await withLiveWorkbench(({ workspaceRunGitSummary, workspaceRunsToLoad }) => {
    const completed = {
      id: "request-completed",
      runId: "run-completed",
      status: "succeeded",
      output: "x".repeat(10 * 1024 * 1024),
    };
    const running = {
      id: "request-running",
      runId: "run-running",
      status: "running",
    };
    assert.deepEqual(
      workspaceRunsToLoad([completed, running]).map((run) => run.runId),
      [],
    );
    assert.deepEqual(
      workspaceRunsToLoad(
        [completed, running],
        new Set(["run-completed"]),
      ).map((run) => run.runId),
      ["run-completed"],
    );
    assert.deepEqual(
      workspaceRunsToLoad(
        [completed, running],
        new Set(["run-running"]),
      ).map((run) => run.runId),
      ["run-running"],
    );
    assert.equal(workspaceRunGitSummary({
      available: true,
      branch: "main",
      head: "abcdef123456",
      staged: ["src/a.js"],
      unstaged: ["src/a.js", "src/b.js"],
      untracked: [],
      truncated: false,
    }), "main @ abcdef12 · 2 项变更");
  });
});

test("live workbench resumes incomplete event history from the delivered cursor", async () => {
  await withLiveWorkbench(({ conversationEventResumeSeq }) => {
    assert.equal(conversationEventResumeSeq({
      lastEventSeq: 10_501,
      deliveredEventSeq: 10_000,
      hasMoreEvents: true,
      events: [{ seq: 10_000 }],
    }), 10_000);
    assert.equal(conversationEventResumeSeq({
      lastEventSeq: 10_501,
      deliveredEventSeq: 10_000,
      hasMoreEvents: true,
      events: [{ seq: 10_500 }],
    }), 10_500);
    assert.equal(conversationEventResumeSeq({
      lastEventSeq: 10_501,
      deliveredEventSeq: 10_501,
      hasMoreEvents: false,
      events: [{ seq: 10_501 }],
    }), 10_501);
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

test("completed Word and Excel outputs stay in Files with verified previews and downloads", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const revision = `sha256:${"c".repeat(64)}`;
    const html = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          activeArtifactId: "files",
          generatedOfficeArtifacts: [{
            id: "office-word-1",
            turnId: "turn-office-1",
            kind: "word",
            status: "completed",
            title: "项目报告",
            summary: "包含结论和下一步。",
            fileName: "项目报告.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            byteLength: 4096,
            revision,
            previewText: "title=项目报告\nheading=结论\n项目保持稳定。",
            structureVerified: true,
            renderVerified: true,
            pageCount: 2,
          }, {
            id: "office-excel-1",
            turnId: "turn-office-1",
            kind: "excel",
            status: "completed",
            title: "项目数据",
            summary: "包含一张汇总表。",
            fileName: "项目数据.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            byteLength: 8192,
            revision: `sha256:${"d".repeat(64)}`,
            previewText: "sheet=汇总\nA1=项目\nB1=数量",
            structureVerified: true,
            renderVerified: true,
            sheetCount: 1,
          }],
        }),
      },
    ));

    assert.match(html, /会话生成/);
    assert.match(html, /项目报告\.docx/);
    assert.match(html, /2 页/);
    assert.match(html, /项目数据\.xlsx/);
    assert.match(html, /1 个工作表/);
    assert.doesNotMatch(html, /Users\//);
    assert.match(source, /generatedOfficeDownloadUrl/);
    assert.match(source, /结构、渲染与哈希读回均通过/);
    assert.match(source, /下载文件/);
  }, { exposeArtifact: true });
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

test("saved verification runs in the current Workspace and reuses its toolchain", async () => {
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
    assert.match(html, /在当前 Workspace 运行/);
    assert.match(html, /复用项目工具链与构建缓存/);
    assert.doesNotMatch(html, /先审阅修改|等待修改确认|验证才会变为可运行/);
  }, { exposeArtifact: true });
});

test("settled turns expose paged history, unread state, one path entry, and one visible attempt", async () => {
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
        sessionPath: {
          activeLeafCheckpointId: "checkpoint-5b",
          checkpoints: [{
            id: "checkpoint-5a",
            turnId: "turn-5",
            turnSeq: 5,
            userMessageId: "message-user-5",
            assistantMessageId: "message-assistant-5a",
            attempt: 1,
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
            status: "completed",
            branchable: true,
          }, {
            id: "checkpoint-5b",
            turnId: "turn-5",
            turnSeq: 5,
            userMessageId: "message-user-5",
            assistantMessageId: "message-assistant-5b",
            attempt: 2,
            providerId: "openai-codex",
            modelId: "gpt-5.3-codex",
            status: "completed",
            branchable: true,
          }],
        },
        messages: [{
          id: "message-user-5",
          role: "user",
          kind: "message",
          content: "检查失败后修复",
          messageSeq: 8,
          turnId: "turn-5",
          turnSeq: 5,
        }, {
          id: "message-assistant-5a",
          role: "assistant",
          kind: "message",
          content: "这是较早的 DeepSeek 方案。",
          messageSeq: 9,
          turnId: "turn-5",
          turnSeq: 5,
          attempt: 1,
          turnEvidence: {
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
          },
        }, {
          id: "message-assistant-5b",
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
    assert.match(html, />路径</);
    assert.doesNotMatch(html, /重试上一轮/);
    assert.doesNotMatch(html, /这是较早的 DeepSeek 方案/);
    assert.match(html, /已经修复并复测通过/);
    assert.doesNotMatch(html, /class="project-agent-header"/);
    assert.ok(
      html.indexOf("透明模式") < html.indexOf('class="project-agent-stream"'),
      "transparent mode should live in the shared top bar",
    );
    assert.ok(
      html.indexOf(">路径<") < html.indexOf('class="project-agent-stream"'),
      "the compact path entry should live in the shared top bar",
    );
    assert.match(html, /openai-codex · gpt-5\.3-codex/);
    assert.match(html, /1,536 tokens/);
    assert.match(html, /\$0\.0123/);
    assert.match(html, /方案 2\/2/);
  });
});

test("checkpoint selection is a local projection and preserves an unloaded older turn fallback", async () => {
  await withLiveWorkbench(({ projectSessionMessageView }) => {
    const messages = [{
      id: "user-1",
      role: "user",
      turnId: "turn-1",
      turnSeq: 1,
      content: "给出两种方案",
    }, {
      id: "assistant-1a",
      role: "assistant",
      turnId: "turn-1",
      turnSeq: 1,
      attempt: 1,
      content: "DeepSeek 方案",
    }, {
      id: "assistant-1b",
      role: "assistant",
      turnId: "turn-1",
      turnSeq: 1,
      attempt: 2,
      content: "GPT 方案",
    }, {
      id: "user-2",
      role: "user",
      turnId: "turn-2",
      turnSeq: 2,
      content: "继续",
    }, {
      id: "assistant-2-visible",
      role: "assistant",
      turnId: "turn-2",
      turnSeq: 2,
      attempt: 2,
      content: "当前已加载回答",
    }];
    const sessionPath = {
      activeLeafCheckpointId: "checkpoint-1b",
      checkpoints: [{
        id: "checkpoint-1a",
        turnId: "turn-1",
        turnSeq: 1,
        assistantMessageId: "assistant-1a",
        attempt: 1,
      }, {
        id: "checkpoint-1b",
        turnId: "turn-1",
        turnSeq: 1,
        assistantMessageId: "assistant-1b",
        attempt: 2,
      }, {
        id: "checkpoint-2-unloaded",
        turnId: "turn-2",
        turnSeq: 2,
        assistantMessageId: "assistant-2-not-loaded",
        attempt: 1,
      }],
    };

    const olderAttempt = projectSessionMessageView(
      messages,
      sessionPath,
      "checkpoint-1a",
    );
    assert.deepEqual(
      olderAttempt.messages.filter((message) => message.role === "assistant")
        .map((message) => message.id),
      ["assistant-1a", "assistant-2-visible"],
    );

    const latestAttempt = projectSessionMessageView(messages, sessionPath, null);
    assert.deepEqual(
      latestAttempt.messages.filter((message) => message.role === "assistant")
        .map((message) => message.id),
      ["assistant-1b", "assistant-2-visible"],
    );
  });
});

test("activity follows the selected model attempt instead of stacking sibling tool traces", async () => {
  await withLiveWorkbench(({ activityEventsForTurnAttempt }) => {
    const turn = { id: "user-7", turnId: "turn-7", turnSeq: 7 };
    const events = [{
      seq: 1,
      type: "message.created",
      messageId: "user-7",
      turnId: "turn-7",
      turnSeq: 7,
      attempt: 1,
    }, {
      seq: 2,
      type: "turn.started",
      turnId: "turn-7",
      turnSeq: 7,
      attempt: 1,
    }, {
      seq: 3,
      type: "tool.completed",
      turnId: "turn-7",
      attempt: 1,
      title: "DeepSeek 文件读取",
    }, {
      seq: 4,
      type: "operation.started",
      turnId: "turn-7",
      turnSeq: 7,
      attempt: 2,
    }, {
      seq: 5,
      type: "turn.started",
      turnId: "turn-7",
      turnSeq: 7,
      attempt: 2,
    }, {
      seq: 6,
      type: "tool.completed",
      turnId: "turn-7",
      attempt: 2,
      title: "GPT 文件读取",
    }];

    assert.deepEqual(
      activityEventsForTurnAttempt(events, turn, 1).map((event) => event.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      activityEventsForTurnAttempt(events, turn, 2).map((event) => event.seq),
      [4, 5, 6],
    );
  });
});

test("activity keeps every internal model turn in one logical attempt", async () => {
  await withLiveWorkbench(({ activityEventsForTurnAttempt }) => {
    const turn = { id: "user-9", turnId: "turn-9", turnSeq: 9 };
    const events = [{
      seq: 1,
      type: "message.created",
      data: { id: "user-9", turnId: "turn-9", turnSeq: 9, attempt: 1 },
    }, {
      seq: 2,
      type: "turn.started",
      data: { turnId: "turn-9", turnSeq: 9, attempt: 1 },
    }, {
      seq: 3,
      type: "agent.progress",
      data: { turnId: "turn-9", attempt: 1, summary: "先确认项目入口。" },
    }, {
      seq: 4,
      type: "tool.completed",
      data: { turnId: "turn-9", attempt: 1 },
      toolName: "read",
      toolCallId: "read-1",
      status: "completed",
    }, {
      seq: 5,
      type: "turn.started",
      data: { turnId: "turn-9", turnSeq: 9, attempt: 1 },
    }, {
      seq: 6,
      type: "agent.progress",
      data: { turnId: "turn-9", attempt: 1, summary: "入口已确认，继续核对状态。" },
    }, {
      seq: 7,
      type: "tool.completed",
      data: { turnId: "turn-9", attempt: 1 },
      toolName: "grep",
      toolCallId: "grep-1",
      status: "completed",
    }, {
      seq: 8,
      type: "turn.completed",
      data: { turnId: "turn-9", turnSeq: 9, attempt: 1 },
    }];

    assert.deepEqual(
      activityEventsForTurnAttempt(events, turn, 1).map((event) => event.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });
});

test("path actions wire checkpoint retry, read-only planning branch, and isolated fork", async () => {
  const source = await readFile(COMPONENT_URL, "utf8");
  const appSource = await readFile(APP_URL, "utf8");

  assert.match(source, /api\.retryCheckpoint\(\{[\s\S]*?checkpointId/);
  assert.match(source, /api\.forkCheckpoint\(\{[\s\S]*?checkpointId/);
  assert.match(source, /checkpointId: branchTarget\?\.id/);
  assert.match(source, /workflowId: branchTarget \? "planning" : selectedWorkflowId/);
  assert.match(source, /onConversationForked\?\.\(forkedConversation\)/);
  assert.doesNotMatch(source, /canRetryFromHeader|const retryLastTurn/);
  assert.match(appSource, /activateForkedProjectConversation/);
  assert.match(appSource, /onConversationForked=\{activateForkedProjectConversation\}/);
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

test("latest settled activity is coalesced and remains open above the final answer", async () => {
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

    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /class="project-activity-body">/);
    assert.match(html, /已完成/);
    assert.match(html, /4 项 · 查看过程/);
    assert.match(html, /透明模式/);
    assert.doesNotMatch(html, /Harness 快照/);
    assert.match(html, /查看与检索了 1 次/);
    assert.equal((html.match(/思考完成/g) ?? []).length, 0);
    assert.doesNotMatch(html, /agent\.thinking|37 条记录/);
    assert.ok(
      html.indexOf('aria-label="Pi Agent 活动"') < html.indexOf("这是本轮最终答案。"),
      "completed activity should render before the final answer",
    );
  });
});

test("non-final assistant messages render once in the activity timeline", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const intermediate = "目录已确认，现在写入修复。";
    const finalAnswer = "修复已经完成。";
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        messages: [
          {
            id: "message-user",
            role: "user",
            turnId: "turn-1",
            turnSeq: 1,
            content: "修复入口",
          },
          {
            id: "message-progress",
            role: "assistant",
            turnId: "turn-1",
            turnSeq: 1,
            content: intermediate,
            isFinal: false,
          },
          {
            id: "message-final",
            role: "assistant",
            turnId: "turn-1",
            turnSeq: 1,
            content: finalAnswer,
            isFinal: true,
          },
        ],
        events: [
          {
            seq: 1,
            type: "message.created",
            data: { id: "message-user", turnId: "turn-1", turnSeq: 1 },
          },
          {
            seq: 2,
            type: "message.completed",
            data: { text: intermediate, isFinal: false, turnId: "turn-1" },
          },
          {
            seq: 3,
            type: "tool.completed",
            toolName: "write",
            toolCallId: "write-1",
            path: "src/app.js",
            status: "completed",
          },
          {
            seq: 4,
            type: "message.completed",
            data: { text: finalAnswer, isFinal: true, turnId: "turn-1" },
          },
        ],
      }),
    }));

    assert.equal((html.match(new RegExp(intermediate, "g")) ?? []).length, 1);
    assert.equal((html.match(new RegExp(finalAnswer, "g")) ?? []).length, 1);
    assert.ok(
      html.indexOf(intermediate) < html.indexOf(finalAnswer),
      "intermediate narration should stay in the activity before the final answer",
    );
  });
});

test("activity events are split by executed turns and ignore queued follow-ups", async () => {
  await withLiveWorkbench(({ activityEventsForTurn }) => {
    const events = [
      {
        seq: 1,
        type: "message.created",
        data: { id: "user-1", turnId: "turn-1", turnSeq: 1 },
      },
      {
        seq: 2,
        type: "agent.progress",
        data: { turnId: "turn-1", summary: "第一轮公开进展" },
      },
      {
        seq: 3,
        type: "follow_up.queued",
        data: { messageId: "user-2" },
      },
      {
        seq: 4,
        type: "follow_up.delivered",
        data: { messageId: "user-2" },
      },
      {
        seq: 5,
        type: "agent.progress",
        data: { turnId: "user-2", summary: "第二轮公开进展" },
      },
    ];

    assert.deepEqual(
      activityEventsForTurn(events, { id: "user-1", turnId: "turn-1", turnSeq: 1 })
        .map((event) => event.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      activityEventsForTurn(events.slice(0, 3), {
        id: "user-2",
        turnId: "user-2",
        turnSeq: 2,
      }),
      [],
      "a queued follow-up must not become an executed activity turn",
    );
    assert.deepEqual(
      activityEventsForTurn(events, {
        id: "user-2",
        turnId: "user-2",
        turnSeq: 2,
      }).map((event) => event.seq),
      [4, 5],
    );
  });
});

test("loaded historical turns restore their durable activity events", async () => {
  await withLiveWorkbench(({ mergeTurnHistoryEvents }) => {
    const merged = mergeTurnHistoryEvents([{
      id: "turn-1",
      events: [
        { seq: 1, type: "message.created" },
        { seq: 2, type: "agent.progress", data: { summary: "旧轮进展" } },
      ],
    }], [
      { seq: 2, type: "agent.progress", data: { summary: "重放后的旧轮进展" } },
      { seq: 10, type: "message.created" },
    ]);

    assert.deepEqual(merged.map((event) => event.seq), [1, 2, 10]);
    assert.equal(merged[1].data.summary, "重放后的旧轮进展");
  });
});

test("every executed turn keeps its activity while only history starts collapsed", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        messages: [
          {
            id: "user-1",
            role: "user",
            turnId: "turn-1",
            turnSeq: 1,
            content: "检查第一处",
          },
          {
            id: "assistant-1",
            role: "assistant",
            turnId: "turn-1",
            turnSeq: 1,
            content: "第一处已经检查。",
          },
          {
            id: "user-2",
            role: "user",
            turnId: "turn-2",
            turnSeq: 2,
            content: "继续检查第二处",
          },
          {
            id: "assistant-2",
            role: "assistant",
            turnId: "turn-2",
            turnSeq: 2,
            content: "第二处已经检查。",
          },
        ],
        events: [
          {
            seq: 1,
            type: "message.created",
            data: { id: "user-1", turnId: "turn-1", turnSeq: 1 },
          },
          {
            seq: 2,
            type: "agent.progress",
            data: { summary: "正在核对第一处。", turnId: "turn-1" },
          },
          {
            seq: 3,
            type: "message.completed",
            data: { turnId: "turn-1" },
          },
          {
            seq: 4,
            type: "message.created",
            data: { id: "user-2", turnId: "turn-2", turnSeq: 2 },
          },
          {
            seq: 5,
            type: "agent.progress",
            data: { summary: "正在核对第二处。", turnId: "turn-2" },
          },
          {
            seq: 6,
            type: "message.completed",
            data: { turnId: "turn-2" },
          },
        ],
      }),
    }));

    assert.equal((html.match(/aria-label="Pi Agent 活动"/g) ?? []).length, 2);
    assert.equal(
      (html.match(/class="project-activity-body" hidden=""/g) ?? []).length,
      1,
    );
    assert.match(html, /正在核对第一处/);
    assert.match(html, /正在核对第二处/);
    assert.ok(html.indexOf("检查第一处") < html.indexOf("正在核对第一处"));
    assert.ok(html.indexOf("正在核对第一处") < html.indexOf("第一处已经检查"));
    assert.ok(html.indexOf("继续检查第二处") < html.indexOf("正在核对第二处"));
    assert.ok(html.indexOf("正在核对第二处") < html.indexOf("第二处已经检查"));
  });
});

test("the active plan stays in a fixed dock while historical plans remain visible", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const messages = [
      {
        id: "user-plan-1",
        role: "user",
        turnId: "turn-plan-1",
        turnSeq: 1,
        content: "先检查入口",
      },
      {
        id: "assistant-plan-1",
        role: "assistant",
        turnId: "turn-plan-1",
        turnSeq: 1,
        content: "入口已经检查。",
      },
      {
        id: "user-plan-2",
        role: "user",
        turnId: "turn-plan-2",
        turnSeq: 2,
        content: "继续检查状态流",
      },
    ];
    const events = [
      {
        seq: 1,
        type: "message.created",
        data: { id: "user-plan-1", turnId: "turn-plan-1", turnSeq: 1 },
      },
      {
        seq: 2,
        type: "plan.updated",
        data: {
          steps: [{ id: "old-plan", text: "第一轮对应计划", status: "completed" }],
        },
      },
      {
        seq: 3,
        type: "message.completed",
        data: { turnId: "turn-plan-1" },
      },
      {
        seq: 4,
        type: "message.created",
        data: { id: "user-plan-2", turnId: "turn-plan-2", turnSeq: 2 },
      },
      {
        seq: 5,
        type: "plan.updated",
        data: {
          steps: [{ id: "new-plan", text: "第二轮对应计划", status: "in_progress" }],
        },
      },
      {
        seq: 6,
        type: "agent.progress",
        data: { summary: "正在检查第二轮。" },
      },
    ];
    const currentPlan = [{
      id: "new-plan",
      title: "第二轮对应计划",
      status: "in_progress",
    }];
    const runningHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          status: "running",
          turnStatus: "running",
          messages,
          events,
          plan: currentPlan,
        }),
      },
    ));

    assert.equal((runningHtml.match(/>第一轮对应计划<\/span>/g) ?? []).length, 1);
    assert.equal((runningHtml.match(/>第二轮对应计划<\/span>/g) ?? []).length, 1);
    assert.equal((runningHtml.match(/project-plan-dock is-running is-expanded/g) ?? []).length, 1);
    assert.equal((runningHtml.match(/project-plan-card is-history/g) ?? []).length, 1);

    const settledHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          status: "completed",
          turnStatus: "completed",
          messages: [
            ...messages,
            {
              id: "assistant-plan-2",
              role: "assistant",
              turnId: "turn-plan-2",
              turnSeq: 2,
              content: "状态流已经检查。",
            },
          ],
          events: [
            ...events,
            {
              seq: 7,
              type: "message.completed",
              data: { turnId: "turn-plan-2" },
            },
          ],
          plan: currentPlan,
        }),
      },
    ));

    assert.equal((settledHtml.match(/project-plan-card is-history/g) ?? []).length, 1);
    assert.match(settledHtml, /project-plan-dock is-settled/);
    assert.match(settledHtml, /aria-label="当前 Agent 计划"/);
    assert.match(settledHtml, /aria-expanded="false"/);
    assert.equal((settledHtml.match(/>第一轮对应计划<\/span>/g) ?? []).length, 1);
    assert.equal((settledHtml.match(/>第二轮对应计划<\/span>/g) ?? []).length, 1);

    const noNewPlanHtml = renderToStaticMarkup(React.createElement(
      LiveProjectWorkbench,
      {
        project,
        conversation: conversation({
          status: "running",
          turnStatus: "running",
          messages,
          events: events.filter((event) => event.seq !== 5),
          plan: [{
            id: "old-plan",
            title: "第一轮对应计划",
            status: "completed",
          }],
        }),
      },
    ));
    assert.equal((noNewPlanHtml.match(/>第一轮对应计划<\/span>/g) ?? []).length, 1);
    assert.match(noNewPlanHtml, /project-plan-dock is-running is-expanded/);
    assert.match(runningHtml, /aria-label="进行中：第二轮对应计划"/);
  });

  const styles = await readFile(STYLES_URL, "utf8");
  const dockStart = styles.indexOf(".project-plan-dock {");
  const dockEnd = styles.indexOf("}", dockStart);
  assert.notEqual(dockStart, -1);
  assert.match(styles.slice(dockStart, dockEnd), /flex: 0 0 auto/);
  const source = await readFile(COMPONENT_URL, "utf8");
  const paneStart = source.indexOf("export function ProjectAgentPane");
  const dockPosition = source.indexOf("<ProjectPlanDock", paneStart);
  const streamPosition = source.indexOf('className="project-agent-stream"', paneStart);
  assert.ok(dockPosition > paneStart && dockPosition < streamPosition);
});

test("the current executed turn expands while prior activity stays collapsed", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        status: "running",
        turnStatus: "running",
        messages: [
          { id: "user-1", role: "user", turnId: "turn-1", turnSeq: 1, content: "第一轮" },
          { id: "assistant-1", role: "assistant", turnId: "turn-1", turnSeq: 1, content: "完成" },
          { id: "user-2", role: "user", turnId: "turn-2", turnSeq: 2, content: "第二轮" },
        ],
        events: [
          {
            seq: 1,
            type: "message.created",
            data: { id: "user-1", turnId: "turn-1", turnSeq: 1 },
          },
          { seq: 2, type: "agent.progress", data: { summary: "第一轮过程" } },
          {
            seq: 3,
            type: "message.created",
            data: { id: "user-2", turnId: "turn-2", turnSeq: 2 },
          },
          { seq: 4, type: "agent.progress", data: { summary: "第二轮正在继续" } },
        ],
      }),
    }));

    assert.match(html, /project-activity is-settled is-completed is-compact/);
    assert.match(html, /project-activity is-running is-expanded/);
    assert.equal(
      (html.match(/class="project-activity-body" hidden=""/g) ?? []).length,
      1,
    );
  });
});

test("a failed turn without an answer keeps its process after its user message", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        status: "failed",
        turnStatus: "failed",
        messages: [
          { id: "user-1", role: "user", turnId: "turn-1", turnSeq: 1, content: "第一轮" },
          { id: "assistant-1", role: "assistant", turnId: "turn-1", turnSeq: 1, content: "第一轮回答" },
          { id: "user-2", role: "user", turnId: "turn-2", turnSeq: 2, content: "失败的第二轮" },
        ],
        events: [
          {
            seq: 1,
            type: "message.created",
            data: { id: "user-1", turnId: "turn-1", turnSeq: 1 },
          },
          { seq: 2, type: "agent.progress", data: { summary: "第一轮过程" } },
          {
            seq: 3,
            type: "message.created",
            data: { id: "user-2", turnId: "turn-2", turnSeq: 2 },
          },
          { seq: 4, type: "agent.progress", data: { summary: "失败前已经完成的检查" } },
          { seq: 5, type: "agent.status", data: { status: "failed" } },
        ],
      }),
    }));

    assert.equal((html.match(/aria-label="Pi Agent 活动"/g) ?? []).length, 2);
    assert.ok(html.indexOf("失败的第二轮") < html.indexOf("失败前已经完成的检查"));
    assert.ok(html.indexOf("第一轮回答") < html.indexOf("失败的第二轮"));
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

test("an aborted subagent tool is presented as stopped rather than failed", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        { seq: 1, type: "message.created", status: "accepted" },
        {
          seq: 2,
          type: "tool.started",
          toolName: "subagent",
          toolCallId: "subagent-stop",
        },
        {
          seq: 3,
          type: "tool.completed",
          toolName: "subagent",
          toolCallId: "subagent-stop",
          status: "aborted",
        },
      ],
      running: false,
      compact: true,
      onOpenArtifact: () => {},
    }));

    assert.match(html, /并行子智能体已停止/);
    assert.doesNotMatch(html, /并行子智能体失败/);
  });
});

test("public progress narration stays separate while its tool lifecycle remains hidden", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      {
        seq: 2,
        type: "tool.started",
        toolName: "report_progress",
        toolCallId: "progress-1",
      },
      {
        seq: 3,
        type: "agent.progress",
        data: {
          summary: "我先确认正常工作台怎样接收实时事件。",
          detail: "接下来核对活动归一化与最终回答的衔接。",
        },
      },
      {
        seq: 4,
        type: "tool.completed",
        toolName: "report_progress",
        toolCallId: "progress-1",
        status: "completed",
      },
      {
        seq: 5,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-1",
        path: "src/app.js",
        status: "completed",
      },
      { seq: 6, type: "agent.thinking", status: "active" },
      {
        seq: 7,
        type: "agent.progress",
        data: {
          summary: "已经定位到进展被压成计数的位置。",
          detail: "现在准备保留语义化旁白，同时维持工具审计。",
        },
      },
      { seq: 8, type: "agent.thinking", status: "finished" },
    ], true);

    assert.deepEqual(
      normalized.map((event) => event.type),
      [
        "agent.progress",
        "activity.research_summary",
        "agent.thinking",
        "agent.progress",
      ],
    );
    assert.equal(
      normalized.filter((event) => event.type === "agent.progress").length,
      2,
    );
    assert.doesNotMatch(JSON.stringify(normalized), /report_progress/);
  });
});

test("non-final assistant narration is interleaved with tools as public progress", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      {
        seq: 2,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-1",
        path: "src/app.js",
        status: "completed",
      },
      {
        seq: 3,
        type: "message.completed",
        data: {
          text: "已经确认入口，接下来写入修复。",
          isFinal: false,
        },
      },
      {
        seq: 4,
        type: "tool.completed",
        toolName: "write",
        toolCallId: "write-1",
        path: "src/app.js",
        status: "completed",
      },
      {
        seq: 5,
        type: "message.completed",
        data: { text: "修复完成。", isFinal: true },
      },
    ], false);

    assert.deepEqual(
      normalized.map((event) => event.type),
      ["activity.research_summary", "agent.progress", "tool.completed"],
    );
    assert.equal(normalized[1].data.summary, "已经确认入口，接下来写入修复。");
    assert.deepEqual(
      normalized.map((event) => event.firstSeq ?? event.seq),
      [2, 3, 4],
    );
  });
});

test("public narration splits tool summaries into their real contiguous batches", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      {
        seq: 2,
        type: "agent.progress",
        data: { summary: "先确认入口。" },
      },
      {
        seq: 3,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-before",
        status: "completed",
      },
      {
        seq: 4,
        type: "agent.progress",
        data: { summary: "入口已经确认，现在检查状态流。" },
      },
      {
        seq: 5,
        type: "tool.completed",
        toolName: "grep",
        toolCallId: "grep-after",
        status: "completed",
      },
    ], true);

    assert.deepEqual(
      normalized.map((event) => event.type),
      [
        "agent.progress",
        "activity.research_summary",
        "agent.progress",
        "activity.research_summary",
      ],
    );
    assert.deepEqual(
      normalized.map((event) => event.firstSeq),
      [2, 3, 4, 5],
    );
    assert.deepEqual(
      normalized.filter((event) => event.type === "activity.research_summary")
        .map((event) => event.counts.project),
      [1, 1],
    );
  });
});

test("the safe thinking lifecycle keeps its first chronological position", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "agent.thinking", status: "started" },
      {
        seq: 3,
        type: "agent.progress",
        data: { summary: "先确认入口。" },
      },
      {
        seq: 4,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-after-thinking",
        status: "completed",
      },
      {
        seq: 5,
        type: "agent.progress",
        data: { summary: "再检查状态流。" },
      },
      {
        seq: 6,
        type: "tool.completed",
        toolName: "grep",
        toolCallId: "grep-after-thinking",
        status: "completed",
      },
      { seq: 7, type: "agent.thinking", status: "finished" },
    ], false);

    assert.deepEqual(
      normalized.map((event) => event.type),
      [
        "agent.thinking",
        "agent.progress",
        "activity.research_summary",
        "agent.progress",
        "activity.research_summary",
      ],
    );
    assert.deepEqual(
      normalized.map((event) => event.firstSeq),
      [2, 3, 4, 5, 6],
    );
  });
});

test("reasoning cycles stay interleaved with their real tool batches", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "turn.started", providerId: "deepseek" },
      { seq: 3, type: "agent.thinking", status: "active" },
      { seq: 4, type: "agent.thinking", status: "finished" },
      {
        seq: 5,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-first",
        status: "completed",
      },
      { seq: 6, type: "turn.completed", providerId: "deepseek" },
      { seq: 7, type: "turn.started", providerId: "deepseek" },
      { seq: 8, type: "agent.thinking", status: "active" },
      { seq: 9, type: "agent.thinking", status: "finished" },
      {
        seq: 10,
        type: "tool.completed",
        toolName: "edit",
        toolCallId: "edit-after-read",
        status: "completed",
      },
      { seq: 11, type: "turn.completed", providerId: "deepseek" },
      { seq: 12, type: "turn.started", providerId: "deepseek" },
      { seq: 13, type: "agent.thinking", status: "active" },
      { seq: 14, type: "agent.thinking", status: "finished" },
      {
        seq: 15,
        type: "message.completed",
        data: { text: "处理完成。", isFinal: true },
      },
      { seq: 16, type: "turn.completed", providerId: "deepseek" },
    ], false);

    assert.deepEqual(
      normalized.map((event) => event.type),
      [
        "agent.thinking",
        "activity.research_summary",
        "agent.thinking",
        "tool.completed",
        "agent.thinking",
      ],
    );
    assert.deepEqual(
      normalized
        .filter((event) => event.type === "agent.thinking")
        .map((event) => event.firstSeq),
      [3, 8, 13],
    );
    assert.match(normalized[2].detail, /刚完成的文件与资料检查/);
    assert.match(normalized[4].detail, /工具结果/);
  });
});

test("providers without native reasoning receive deterministic safe phases", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const makeEvents = (providerId) => [
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "turn.started", providerId },
      {
        seq: 3,
        type: "message.completed",
        data: { text: "", isFinal: false },
      },
      {
        seq: 4,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-provider-neutral",
        status: "completed",
      },
      { seq: 5, type: "turn.completed", providerId },
      { seq: 6, type: "turn.started", providerId },
      {
        seq: 7,
        type: "message.completed",
        data: { text: "检查完成。", isFinal: true },
      },
      { seq: 8, type: "turn.completed", providerId },
    ];
    const presentations = ["openai-codex", "deepseek", "provider-x"].map(
      (providerId) => normalizeActivityEvents(makeEvents(providerId), false)
        .map((event) => ({
          type: event.type,
          title: event.title ?? null,
          detail: event.detail ?? null,
          status: event.status,
        })),
    );

    assert.deepEqual(presentations[1], presentations[0]);
    assert.deepEqual(presentations[2], presentations[0]);
    assert.deepEqual(
      presentations[0].map((event) => event.type),
      ["activity.phase", "activity.research_summary", "activity.phase"],
    );
    assert.equal(presentations[0][0].title, "已完成这一步分析");
    assert.equal(presentations[0][2].title, "已结合刚查看的资料");
  });
});

test("activity timeline adds bounded provider-neutral narration around real tools", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        { seq: 1, type: "message.created", status: "accepted" },
        { seq: 2, type: "turn.started", providerId: "deepseek" },
        { seq: 3, type: "agent.thinking", status: "active" },
        { seq: 4, type: "agent.thinking", status: "finished" },
        {
          seq: 5,
          type: "tool.completed",
          toolName: "read",
          toolCallId: "read-1",
          status: "completed",
        },
        { seq: 6, type: "turn.completed", providerId: "deepseek" },
        { seq: 7, type: "turn.started", providerId: "deepseek" },
        {
          seq: 8,
          type: "tool.completed",
          toolName: "grep",
          toolCallId: "grep-1",
          status: "completed",
        },
        { seq: 9, type: "turn.completed", providerId: "deepseek" },
      ],
      running: false,
      compact: false,
      onOpenArtifact: () => {},
    }));

    assert.match(html, /我先确认任务范围，再按需查看相关资料/);
    assert.match(html, /关键资料已经核对，正在整理结论与适用边界/);
    assert.match(html, /查看与检索了 2 次/);
    assert.doesNotMatch(html, /思考完成/);
    assert.equal((html.match(/<article class="project-activity-progress/g) ?? []).length, 2);
  });
});

test("provider-neutral narration never announces completion while a turn is running", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        { seq: 1, type: "message.created", status: "accepted" },
        { seq: 2, type: "turn.started", providerId: "deepseek" },
        {
          seq: 3,
          type: "tool.completed",
          toolName: "read",
          toolCallId: "read-running",
          status: "completed",
        },
      ],
      running: true,
      compact: false,
      onOpenArtifact: () => {},
    }));

    assert.match(html, /我先确认任务范围，再按需查看相关资料/);
    assert.doesNotMatch(html, /已经完成|已经核对|最终结果/);
    assert.equal(
      (html.match(/<article class="project-activity-progress/g) ?? []).length,
      1,
    );
  });
});

test("a completed model turn still presents an overall failed turn as incomplete", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "turn.started", providerId: "provider-x" },
      {
        seq: 3,
        type: "message.completed",
        status: "failed",
        data: { text: "", isFinal: true },
      },
      { seq: 4, type: "turn.completed", providerId: "provider-x" },
      { seq: 5, type: "agent.status", status: "failed" },
    ], false);

    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].type, "activity.phase");
    assert.equal(normalized[0].status, "incomplete");
    assert.equal(normalized[0].title, "分析未完成");
    assert.doesNotMatch(normalized[0].title, /已完成/);
  });
});

test("a native reasoning event keeps the provisional phase identity", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const prefix = [
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "turn.started", providerId: "provider-x" },
    ];
    const provisional = normalizeActivityEvents(prefix, true);
    const native = normalizeActivityEvents([
      ...prefix,
      { seq: 3, type: "agent.thinking", status: "active" },
    ], true);

    assert.equal(provisional.length, 1);
    assert.equal(native.length, 1);
    assert.equal(provisional[0].type, "activity.phase");
    assert.equal(native[0].type, "agent.thinking");
    assert.equal(native[0].activityKey, provisional[0].activityKey);
  });
});

test("long activity histories retain early failures instead of silently truncating", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      {
        seq: 2,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "early-failure",
        status: "failed",
      },
      ...Array.from({ length: 105 }, (_, index) => ({
        seq: index + 3,
        type: "agent.progress",
        data: { summary: `公开进展 ${index + 1}` },
      })),
      { seq: 108, type: "error", status: "failed" },
    ], false);

    assert.equal(normalized.length, 107);
    assert.equal(normalized[0].toolCallId, "early-failure");
    assert.equal(normalized[0].status, "failed");
    assert.equal(normalized.at(-1).type, "error");
  });
});

test("tool batches retain lifecycle anchors and stop at failures or approval decisions", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      {
        seq: 2,
        type: "tool.started",
        toolName: "read",
        toolCallId: "read-lifecycle",
      },
      {
        seq: 3,
        type: "tool.progress",
        toolName: "read",
        toolCallId: "read-lifecycle",
      },
      {
        seq: 4,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-lifecycle",
        status: "completed",
      },
      {
        seq: 5,
        type: "auto_review.decision",
        decision: "allow",
      },
      {
        seq: 6,
        type: "tool.completed",
        toolName: "grep",
        toolCallId: "grep-after-review",
        status: "completed",
      },
      {
        seq: 7,
        type: "tool.completed",
        toolName: "read",
        toolCallId: "read-failed",
        status: "failed",
      },
      {
        seq: 8,
        type: "tool.completed",
        toolName: "find",
        toolCallId: "find-after-failure",
        status: "completed",
      },
    ], false);

    assert.deepEqual(
      normalized.map((event) => event.type),
      [
        "activity.research_summary",
        "auto_review.decision",
        "activity.research_summary",
        "tool.completed",
        "activity.research_summary",
      ],
    );
    assert.equal(normalized[0].firstSeq, 2);
    assert.equal(normalized[0].lastSeq, 4);
    assert.equal(normalized[0].seq, 2);
    assert.equal(normalized[1].firstSeq, 5);
    assert.equal(normalized[2].firstSeq, 6);
    assert.equal(normalized[3].toolCallId, "read-failed");
    assert.equal(normalized[4].firstSeq, 8);
  });
});

test("running activity presents the latest public progress as natural narration", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        { seq: 1, type: "message.created", status: "accepted" },
        {
          seq: 2,
          type: "agent.progress",
          data: {
            summary: "我正在确认事件从服务端到界面的传递路径。",
          },
        },
        {
          seq: 3,
          type: "agent.progress",
          data: {
            summary: "已经找到僵硬文案的来源，正在调整公开进展层。",
            detail: "原始私有推理仍不会进入浏览器。",
          },
        },
      ],
      running: true,
      compact: false,
      onOpenArtifact: () => {},
    }));

    assert.match(html, /project-activity-progress/);
    assert.match(html, /project-activity-progress is-latest/);
    assert.match(html, /我正在确认事件从服务端到界面的传递路径/);
    assert.match(html, /已经找到僵硬文案的来源，正在调整公开进展层/);
    assert.match(html, /原始私有推理仍不会进入浏览器/);
    assert.match(html, /aria-live="polite"/);
    assert.doesNotMatch(html, /agent\.progress|#2|#3/);
  });
});

test("settled public progress remains inside the collapsed turn process", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        { seq: 1, type: "message.created", status: "accepted" },
        {
          seq: 2,
          type: "agent.progress",
          data: { summary: "本轮公开进展已经记录。" },
        },
      ],
      running: false,
      compact: true,
      onOpenArtifact: () => {},
    }));

    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /class="project-activity-body" hidden=""/);
    assert.match(html, /本轮公开进展已经记录/);
  });
});

test("quiet executed turns keep a safe durable terminal summary", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const cases = [{
      status: "awaiting_user",
      event: { seq: 2, type: "ask_user.requested", data: { id: "ask-1" } },
      className: "is-waiting",
      label: "等待你的回答",
    }, {
      status: "failed",
      event: { seq: 2, type: "agent.status", data: { status: "failed" } },
      className: "is-incomplete",
      label: "未完成",
    }, {
      status: "aborted",
      event: { seq: 2, type: "agent.status", data: { status: "aborted" } },
      className: "is-stopped",
      label: "已停止",
    }, {
      status: "idle",
      event: { seq: 2, type: "agent.status", data: { status: "idle" } },
      className: "is-completed",
      label: "已完成",
    }];

    for (const item of cases) {
      const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
        events: [
          {
            seq: 1,
            type: "message.created",
            data: { id: "user-1", turnId: "turn-1", turnSeq: 1 },
          },
          item.event,
        ],
        running: false,
        compact: true,
        terminalStatus: item.status,
        onOpenArtifact: () => {},
      }));

      assert.match(html, new RegExp(item.className));
      assert.match(html, new RegExp(`>${item.label}<`));
      assert.match(html, /本轮状态已记录/);
      assert.doesNotMatch(html, /thinking_delta|原始思维链|隐藏推理/);
    }
  });
});

test("an extremely early failure still has an incomplete activity card", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [{
        seq: 1,
        type: "message.created",
        data: { id: "user-early", turnId: "turn-early", turnSeq: 1 },
      }],
      running: false,
      compact: true,
      terminalStatus: "failed",
      onOpenArtifact: () => {},
    }));

    assert.match(html, /is-incomplete/);
    assert.match(html, />未完成</);
    assert.match(html, /失败前没有额外记录可安全展示的进展/);
    assert.doesNotMatch(html, />已完成</);
  });
});

test("thinking lifecycle copy follows waiting, stopped, and failed terminal states", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    for (const [status, title, detail] of [
      ["awaiting_user", "思考已暂停", "正在等待你的回答"],
      ["aborted", "思考已停止", "本轮思考已停止"],
      ["failed", "思考未完成", "本轮思考未完成"],
    ]) {
      const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
        events: [
          {
            seq: 1,
            type: "message.created",
            data: { id: "user-thinking", turnId: "turn-thinking", turnSeq: 1 },
          },
          { seq: 2, type: "agent.thinking", status: "active" },
          { seq: 3, type: "agent.thinking", status: "finished" },
        ],
        running: false,
        compact: false,
        terminalStatus: status,
        onOpenArtifact: () => {},
      }));

      assert.match(html, new RegExp(title));
      assert.match(html, new RegExp(detail));
      assert.doesNotMatch(html, /思考完成|本轮思考已完成/);
    }
  });
});

test("a retired verification failure follows the normalized conversation status", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        {
          seq: 1,
          type: "message.created",
          data: { id: "user-native", turnId: "turn-native", turnSeq: 1 },
        },
        { seq: 2, type: "agent.thinking", status: "active" },
        { seq: 3, type: "agent.thinking", status: "finished" },
        {
          seq: 4,
          type: "message.completed",
          status: "completed",
          data: { isFinal: true, text: "本轮回答已经完成" },
        },
        { seq: 5, type: "turn.completed", status: "completed" },
        { seq: 6, type: "agent.status", status: "verification_failed" },
      ],
      running: false,
      compact: false,
      transparentMode: true,
      terminalStatus: "idle",
      onOpenArtifact: () => {},
    }));

    assert.match(html, /Agent 透视 · 已完成/);
    assert.match(html, /已完成当前阶段的判断/);
    assert.doesNotMatch(html, /Agent 透视 · 未完成|本轮思考未完成/);
  });
});

test("a current failed verification still keeps the completed model turn incomplete", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        {
          seq: 1,
          type: "message.created",
          data: { id: "user-failed", turnId: "turn-failed", turnSeq: 1 },
        },
        {
          seq: 2,
          type: "message.completed",
          status: "completed",
          data: { isFinal: true, text: "验证结果如下" },
        },
        {
          seq: 3,
          type: "verification.completed",
          status: "failed",
          data: { status: "failed" },
        },
        { seq: 4, type: "agent.status", status: "verification_failed" },
      ],
      running: false,
      compact: false,
      transparentMode: true,
      terminalStatus: "verification_failed",
      onOpenArtifact: () => {},
    }));

    assert.match(html, /Agent 透视 · 未完成/);
    assert.doesNotMatch(html, /Agent 透视 · 已完成/);
  });
});

test("public progress narration uses comfortable desktop working text", async () => {
  const styles = await readFile(STYLES_URL, "utf8");
  const progressStart = styles.indexOf(".project-activity-progress p {");
  const progressEnd = styles.indexOf("}", progressStart);
  const latestStart = styles.indexOf(".project-activity-progress.is-latest p {");
  const latestEnd = styles.indexOf("}", latestStart);

  assert.notEqual(progressStart, -1);
  assert.notEqual(latestStart, -1);
  assert.match(styles.slice(progressStart, progressEnd), /font-size: 14px/);
  assert.match(styles.slice(latestStart, latestEnd), /font-size: 14\.5px/);
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
    assert.equal(normalized[0].type, "agent.thinking");
    assert.equal(normalized[0].status, "finished");
    assert.equal(normalized[1].type, "activity.research_summary");
    assert.equal(normalized[1].title, "查看与检索了 3 次");
    assert.equal(normalized[1].detail, "项目资料 2 次 · 会话资料 1 次");
    assert.deepEqual(normalized[1].counts, {
      project: 2,
      document: 1,
      retrieval: 0,
    });
    assert.equal(normalized[2].toolCallId, "read-failed");
    assert.equal(normalized[2].status, "failed");
  });
});

test("activity normalization hides bookkeeping events without dropping public work", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const normalized = normalizeActivityEvents([
      { seq: 1, type: "message.created", status: "accepted" },
      { seq: 2, type: "workspace.recorded", status: "completed" },
      { seq: 3, type: "conversation.read", status: "completed" },
      { seq: 4, type: "apply_journal.prepared", status: "prepared" },
      { seq: 5, type: "agent.thinking", status: "active" },
      {
        seq: 6,
        type: "tool.completed",
        toolName: "edit",
        toolCallId: "edit-1",
        path: "src/app.js",
        status: "completed",
      },
      {
        seq: 7,
        type: "change_set.ready",
        status: "ready",
        data: { stats: { files: 1 } },
      },
      { seq: 8, type: "agent.thinking", status: "finished" },
    ], false);

    assert.deepEqual(
      normalized.map((event) => event.type),
      ["agent.thinking", "tool.completed", "change_set.ready"],
    );
    assert.doesNotMatch(
      JSON.stringify(normalized),
      /workspace\.recorded|conversation\.read|apply_journal\.prepared/,
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

test("streaming assistant appends final-answer deltas and keeps commentary out of the answer bubble", async () => {
  await withLiveWorkbench(({ latestStreamingAssistant }) => {
    const events = [{
      seq: 40,
      type: "message.created",
      data: { id: "turn-live", role: "user" },
    }, {
      seq: 41,
      type: "message.delta",
      data: {
        id: "assistant-live",
        turnId: "turn-live",
        delta: "我先查看项目。",
        revision: 1,
        contentIndex: 0,
        phase: "commentary",
      },
    }, {
      seq: 42,
      type: "message.delta",
      messageId: "assistant-live",
      turnId: "turn-live",
      delta: "已经修复",
      revision: 2,
      contentIndex: 1,
      phase: "final_answer",
    }, {
      seq: 43,
      type: "message.delta",
      data: {
        id: "assistant-live",
        turnId: "turn-live",
        delta: "，测试通过。",
        revision: 3,
        contentIndex: 1,
        phase: "final_answer",
      },
    }, {
      seq: 44,
      type: "message.delta",
      data: {
        id: "assistant-live",
        turnId: "turn-live",
        delta: "不应重复",
        revision: 3,
        contentIndex: 1,
        phase: "final_answer",
      },
    }];

    assert.deepEqual(latestStreamingAssistant(events, [], true), {
      id: "assistant-live",
      text: "已经修复，测试通过。",
      seq: 44,
      turnId: "turn-live",
    });
    assert.equal(
      latestStreamingAssistant([
        ...events,
        {
          seq: 45,
          type: "message.completed",
          data: { id: "assistant-live", role: "assistant" },
        },
      ], [], true),
      null,
    );
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
  assert.match(
    submitImplementation,
    /workflowId: branchTarget \? "planning" : selectedWorkflowId/,
  );
  assert.match(submitImplementation, /const submittedDraft = draft/);
  assert.match(submitImplementation, /setDraft\(""\)/);
  assert.match(submitImplementation, /PROJECT_WORK_NOT_RUNNING/);
  assert.match(submitImplementation, /includeActivity: true/);
  assert.match(submitImplementation, /startedNewTurn = true/);
  assert.match(submitImplementation, /setDraft\(\(current\) => current \|\| submittedDraft\)/);
  assert.match(submitImplementation, /replacePendingImage\(null\)/);
  assert.match(source, /useState\(\s*readLastArtifact\(/);
});

test("workspace status explains direct Workspace use and recovery without exposing runtime details", async () => {
  await withLiveWorkbench(({ ProjectWorkspaceStatus }) => {
    const readyHtml = renderToStaticMarkup(React.createElement(ProjectWorkspaceStatus, {
      workspace: {
        kind: "sparse_overlay",
        isolation: "review_overlay",
        recovery: "apply_journal_v1",
        status: "ready",
      },
    }));
    assert.match(readyHtml, /真实 Workspace 已连接/);
    assert.match(readyHtml, /读取、写入、构建与测试使用同一工作区/);

    const forkHtml = renderToStaticMarkup(React.createElement(ProjectWorkspaceStatus, {
      workspace: { status: "ready" },
      fork: { status: "ready" },
    }));
    assert.match(forkHtml, /已从检查点继续/);
    assert.match(forkHtml, /继承检查点上下文/);
    assert.match(forkHtml, /继续使用当前 Workspace/);

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

    const combinedHtml = `${readyHtml}${forkHtml}${recoveringHtml}${blockedHtml}`;
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
    assert.match(html, /状态读取保持只读；只有下方精确确认才会创建本地提交/);
    assert.match(html, /不会使用 git add \./);
    assert.match(html, /不会 push、建 PR 或改写历史/);
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

test("desktop title keeps a readable single-line allocation with a full tooltip", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const title = "优化 QQ 式快捷截图并核对跨模型工作台状态";
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({ title }),
    }));
    assert.match(html, new RegExp(`<h1 title="${title}">${title}</h1>`));
  });
  const styles = await readFile(STYLES_URL, "utf8");
  const allocationStart = styles.indexOf(
    ".reading-workbench-topbar > .workflow-title-block {",
  );
  const allocationEnd = styles.indexOf("}", allocationStart);
  const titleStart = styles.indexOf(
    ".reading-workbench-topbar .workflow-title-block h1 {",
  );
  const titleEnd = styles.indexOf("}", titleStart);
  assert.match(styles.slice(allocationStart, allocationEnd), /min-width: 260px/);
  assert.match(styles.slice(titleStart, titleEnd), /text-overflow: ellipsis/);
  assert.match(styles.slice(titleStart, titleEnd), /white-space: nowrap/);
});

test("activity keeps five hundred public events in event-sequence order", async () => {
  await withLiveWorkbench(({ normalizeActivityEvents }) => {
    const events = [
      { seq: 1, type: "message.created", status: "accepted" },
      ...Array.from({ length: 500 }, (_, index) => ({
        seq: index + 2,
        type: "agent.progress",
        data: { summary: `公开进展 ${index + 1}` },
      })).reverse(),
    ];
    const normalized = normalizeActivityEvents(events, true);
    assert.equal(normalized.length, 500);
    assert.deepEqual(
      normalized.map((event) => event.seq),
      Array.from({ length: 500 }, (_, index) => index + 2),
    );
  });
});

test("activity builds one event-sequence index for many interleaved turns", async () => {
  await withLiveWorkbench(({
    buildActivityTurnIndex,
    activityEventsForTurnAttemptFromIndex,
  }) => {
    const turnCount = 25;
    const eventsPerTurn = 24;
    const events = [];
    let seq = 1;
    for (let turn = 1; turn <= turnCount; turn += 1) {
      events.push({
        seq: seq++,
        type: "message.created",
        messageId: `message-${turn}`,
        turnId: `turn-${turn}`,
        turnSeq: turn,
        attempt: 1,
      });
      for (let item = 1; item < eventsPerTurn; item += 1) {
        events.push({
          seq: seq++,
          type: item % 2 === 0 ? "agent.progress" : "tool.updated",
          turnId: `turn-${turn}`,
          attempt: 1,
          toolCallId: `tool-${turn}-${item}`,
          data: { summary: `进展 ${turn}-${item}` },
        });
      }
    }

    const index = buildActivityTurnIndex(events.reverse());
    assert.equal(index.scopes.length, turnCount);
    const allTurnEvents = Array.from({ length: turnCount }, (_, offset) => (
      activityEventsForTurnAttemptFromIndex(index, {
        id: `message-${offset + 1}`,
        turnId: `turn-${offset + 1}`,
        turnSeq: offset + 1,
      }, 1)
    ));
    assert.equal(allTurnEvents.flat().length, turnCount * eventsPerTurn);
    for (const turnEvents of allTurnEvents) {
      assert.equal(turnEvents.length, eventsPerTurn);
      assert.deepEqual(
        turnEvents.map((event) => event.seq),
        [...turnEvents].map((event) => event.seq).sort((left, right) => left - right),
      );
    }
  });
});

test("native reasoning remains interleaved with public progress without repeated completion copy", async () => {
  await withLiveWorkbench(({ ActivityTimeline }) => {
    const html = renderToStaticMarkup(React.createElement(ActivityTimeline, {
      events: [
        { seq: 1, type: "message.created", status: "accepted" },
        { seq: 2, type: "agent.thinking", status: "active" },
        { seq: 3, type: "agent.progress", data: { summary: "先核对入口。" } },
        { seq: 4, type: "agent.thinking", status: "finished" },
        {
          seq: 5,
          type: "tool.completed",
          toolName: "read",
          toolCallId: "read-visible",
          path: "src/App.jsx",
          status: "completed",
        },
        { seq: 6, type: "agent.progress", data: { summary: "入口已核对。" } },
      ],
      running: false,
      compact: false,
      onOpenArtifact: () => {},
    }));
    assert.match(html, /先核对入口/);
    assert.match(html, /已完成这一步分析/);
    assert.match(html, /查看与检索了 1 次/);
    assert.match(html, /入口已核对/);
    assert.doesNotMatch(html, /思考完成/);
    assert.ok(html.indexOf("先核对入口") < html.indexOf("查看与检索了 1 次"));
  });
});

test("subagent task tree renders safe structured evidence in Run and a compact center card", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench, normalizeSubagentRun }) => {
    const unsafe = normalizeSubagentRun({
      seq: 2,
      status: "failed",
      data: {
        subagentRun: {
          index: 1,
          task: "检查工作台",
          status: "failed",
          currentTool: "read",
          currentPath: "/Users/private/project/src/App.jsx",
          modelRef: "deepseek/deepseek-v4-pro",
          toolCount: 4,
          turnCount: 2,
          tokens: 1_200,
          durationMs: 2_500,
          error: "failed at /Users/private/project sk-secret12345678",
          summary: "3/3 succeeded === Task 1: pi-agent-contained-scout === 已完成核对",
          children: [{ task: "检查标题", status: "completed", toolCount: 1 }],
        },
      },
    });
    assert.equal(unsafe.currentPath, "<workspace>");
    assert.doesNotMatch(JSON.stringify(unsafe), /Users\/private|sk-secret/);
    assert.match(unsafe.summary, /3\/3 个子任务已完成 子任务 1：已完成核对/u);
    assert.doesNotMatch(unsafe.summary, /pi-agent-contained-scout/u);

    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        activeArtifactId: "run_result",
        events: [
          { seq: 1, type: "message.created", status: "accepted" },
          {
            seq: 2,
            type: "tool.completed",
            toolName: "subagent",
            toolCallId: "subagent-structured",
            status: "failed",
            data: { subagentRun: unsafe },
          },
        ],
      }),
    }));
    assert.match(html, /子智能体任务/);
    assert.match(html, /检查工作台/);
    assert.match(html, /检查标题/);
    assert.match(
      html,
      /模型 deepseek\/deepseek-v4-pro · 4 次工具 · 2 轮 · 1\.2k Token · 2\.5 秒/,
    );
    assert.match(html, /查看运行/);
    assert.doesNotMatch(html, /Users\/private|sk-secret/);
  }, { exposeArtifact: true });
});

test("an unresolved verification stays prominent and suppresses a false completed state", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench, verificationAttention }) => {
    const failed = conversation({
      status: "completed",
      turnStatus: "completed",
      verificationCommand: {
        id: "command-failed",
        label: "测试",
        displayCommand: "npm test",
        status: "saved",
      },
      verificationRuns: [{
        id: "run-failed",
        commandId: "command-failed",
        status: "failed",
        command: "npm test",
        summary: "仍有一个断言失败",
        checks: [],
        logs: ["failed"],
      }],
      events: [{
        seq: 1,
        type: "loop.lifecycle",
        lifecycleState: "completed",
      }],
    });
    assert.equal(verificationAttention(failed).status, "failed");
    assert.equal(verificationAttention(conversation({
      workspaceRuns: [{
        id: "old-failed",
        status: "failed",
        executable: "node",
        argv: ["--test"],
      }, {
        id: "latest-passed",
        status: "succeeded",
        executable: "node",
        argv: ["--test"],
      }],
    })), null);
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: failed,
    }));
    assert.match(html, /验证未通过/);
    assert.match(html, /仍有一个断言失败/);
    assert.match(html, /打开运行/);
    assert.doesNotMatch(html, /本轮已完成|Pi Agent 已完成本轮工作/);
  });
});

test("retired copied verification chains never reopen the verification card", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench, verificationAttention }) => {
    const retired = conversation({
      status: "verification_failed",
      verificationCommand: {
        id: "legacy-command",
        label: "Swift 测试",
        displayCommand: "swift test --disable-automatic-resolution",
        status: "legacy_superseded",
      },
      verificationRuns: [{
        id: "legacy-command",
        status: "legacy_superseded",
        command: "swift test --disable-automatic-resolution",
        logs: [],
        checks: [],
      }, {
        id: "legacy-attempt",
        commandId: "legacy-command",
        status: "failed",
        errorCode: "PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE",
        command: "swift test --disable-automatic-resolution",
        summary: "旧验证副本超过限制",
        logs: ["PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE"],
        checks: [],
      }],
    });
    assert.equal(verificationAttention(retired), null);
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: retired,
    }));
    assert.doesNotMatch(html, /验证未通过|打开运行/);
  });
});

test("pending Workspace writes keep exact diff confirmation in Changes and a compact center prompt", async () => {
  await withLiveWorkbench(({ LiveProjectWorkbench }) => {
    const html = renderToStaticMarkup(React.createElement(LiveProjectWorkbench, {
      project,
      conversation: conversation({
        activeArtifactId: "changes",
        workspaceWrites: [{
          id: "workspace-write-1",
          turnId: "turn-write-1",
          toolCallId: "tool-write-1",
          path: "src/App.jsx",
          operation: "update",
          status: "pending",
          approvalMode: "manual_review",
          baseHash: "sha256:workspace-before",
          afterHash: "sha256:workspace-after",
          patch: [
            "--- a/src/App.jsx",
            "+++ b/src/App.jsx",
            "@@ -1 +1 @@",
            "-旧标题",
            "+新标题",
          ].join("\n"),
        }],
      }),
    }));
    assert.match(html, /1 次文件写入等待确认/);
    assert.match(html, /核对精确 Diff/);
    assert.match(html, /Workspace 写入/);
    assert.match(html, /src\/App\.jsx/);
    assert.match(html, /精确 unified diff · 逐次确认/);
    assert.match(html, /旧标题/);
    assert.match(html, /新标题/);
    assert.match(html, /sha256:workspace-before/);
    assert.match(html, /sha256:workspace-after/);
    assert.match(html, /取消写入/);
    assert.match(html, /确认写入/);
    assert.match(html, /重新核对基础哈希/);
  }, { exposeArtifact: true });

  const source = await readFile(COMPONENT_URL, "utf8");
  assert.match(source, /api\.confirmWorkspaceWrite\(\{/);
  assert.match(source, /api\.cancelWorkspaceWrite\(\{/);
  assert.match(source, /writeId: write\.id/);
});
