import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("reader rail dedicates full height to paper Agent, reading notes, and project context", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const {
      WorkflowContextRail,
      createReaderSelectionReference,
    } = await vite.ssrLoadModule("/src/components/WorkflowContextRail.jsx");
    const paper = {
      id: "paper-live-1",
      title: "Paper title",
      shortTitle: "Paper",
      venue: "AAAI",
      publishedAt: "2026-07-23",
      evidenceScope: "全文已解析",
    };
    const readerContext = {
      key: "run-live-1:paper-live-1",
      runId: "run-live-1",
      paperId: paper.id,
      purpose: "close-reading",
      status: "ready",
      paper,
      activeBlockId: "block-1",
      activeStage: "research-question",
      document: {
        revision: "sha256:document",
        title: paper.title,
        sections: [],
        blocks: [{
          id: "block-1",
          sectionId: "section-1",
          kind: "paragraph",
          text: "FULL_ONLY_MARKER **active paragraph** with $\\pi(q,e)=1$.",
          path: ["Paper title", "Introduction"],
          ordinal: 1,
        }, {
          id: "block-2",
          sectionId: "section-1",
          kind: "paragraph",
          text: "Second paragraph.",
          path: ["Paper title", "Introduction"],
          ordinal: 2,
        }],
      },
      reading: {
        documentRevision: "sha256:document",
        stages: {
          "research-question": {
            status: "ready",
            result: {
              answer: "论文研究如何让长流程 Agent 保持可核验状态。",
              evidence: [{
                blockId: "block-1",
                path: ["Paper title", "Introduction"],
                ordinal: 1,
                support: "研究问题来源",
              }],
              openQuestions: ["跨项目迁移是否成立？"],
            },
          },
        },
        chat: {
          status: "ready",
          turns: [{
            id: "chat-turn-1",
            clientRequestId: "client-1",
            question: "这段方法是什么意思？",
            status: "answered",
            reference: null,
            answer: "它描述了一个分阶段处理方法。",
            citations: [{
              blockId: "block-1",
              path: ["Paper title", "Introduction"],
              ordinal: 1,
              quote: "active paragraph",
              support: "方法来源",
            }],
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
            projectContextStatus: "available",
            includeProjectContext: true,
            answeredAt: "2026-07-23T00:00:00.000Z",
          }],
        },
      },
    };
    const common = {
      run: {
        status: "reading",
        selectedPaperIds: [paper.id],
        activePaperId: paper.id,
      },
      papers: [paper],
      preferredPaperId: paper.id,
      readerContext,
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        available: true,
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
      }],
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      projectContextState: {
        status: "ready",
        data: {
          status: "available",
          sourcePath: "project_state.md",
          revision: "sha256:project-context",
          title: "Pi Agent 项目状态",
          goal: "验证真实论文工作流",
          decisions: ["工作流推进项目"],
          openQuestions: ["真实质量如何？"],
          nextActions: ["完成一次真实试跑"],
        },
        error: null,
      },
      onActiveViewChange() {},
      onOpenReaderBlock() {},
      onReaderReadingChange() {},
    };

    const contextHtml = renderToStaticMarkup(React.createElement(WorkflowContextRail, {
      ...common,
      activeView: "agent",
    }));
    assert.match(contextHtml, /论文 Agent/);
    assert.match(contextHtml, /阅读笔记/);
    assert.match(contextHtml, />项目</);
    assert.match(contextHtml, /当前论文/);
    assert.doesNotMatch(contextHtml, /FULL_ONLY_MARKER/);
    assert.match(contextHtml, /解释、翻译、比较，或让 Agent 整理一份草稿/);
    assert.match(contextHtml, /结合项目/);
    assert.match(contextHtml, /DeepSeek/);
    assert.match(contextHtml, /deepseek-v4-pro/);
    assert.match(contextHtml, /已结合项目状态/);
    assert.match(contextHtml, /整理到 Obsidian 笔记/);
    assert.doesNotMatch(contextHtml, /<button[^>]*>\s*翻译\s*<\/button>/);

    const stateHtml = renderToStaticMarkup(React.createElement(WorkflowContextRail, {
      ...common,
      activeView: "state",
    }));
    assert.match(stateHtml, /project_state\.md/);
    assert.match(stateHtml, /验证真实论文工作流/);
    assert.match(stateHtml, /工作流推进项目/);
    assert.match(stateHtml, /真实质量如何/);
    assert.match(stateHtml, /完成一次真实试跑/);

    const proposalContext = {
      ...readerContext,
      reading: {
        ...readerContext.reading,
        chat: {
          ...readerContext.reading.chat,
          turns: [{
            ...readerContext.reading.chat.turns[0],
            noteAction: {
              proposalId: "agent-note-1",
              turnId: "chat-turn-1",
              status: "draft",
              targetPath: "/Vault/Paper.md",
              operationLabel: "追加到 Agent 补充笔记",
              proposalHash: "sha256:proposal",
              contentHash: "sha256:content",
              targetVersionOrHash: "sha256:target",
              preview: ["追加本次回答"],
              diff: { mode: "append", append_text: "### Agent 回答" },
            },
          }],
        },
      },
    };
    const proposalHtml = renderToStaticMarkup(React.createElement(WorkflowContextRail, {
      ...common,
      readerContext: proposalContext,
      activeView: "agent",
    }));
    assert.match(proposalHtml, /待确认/);
    assert.match(proposalHtml, /\/Vault\/Paper\.md/);
    assert.match(proposalHtml, /查看精确差异/);
    assert.match(proposalHtml, /确认写入/);
    assert.match(proposalHtml, /不会推进精读阶段/);

    const notesHtml = renderToStaticMarkup(React.createElement(WorkflowContextRail, {
      ...common,
      activeView: "notes",
    }));
    assert.match(notesHtml, /1\/4 项研读结论/);
    assert.match(notesHtml, /如何让长流程 Agent 保持可核验状态/);
    assert.match(notesHtml, /跨项目迁移是否成立/);
    assert.match(notesHtml, /Introduction/);
    assert.doesNotMatch(notesHtml, /FULL_ONLY_MARKER/);

    assert.deepEqual(createReaderSelectionReference({
      documentRevision: "sha256:document",
      blockId: "block-emoji",
      blockText: "A😀BC",
      startOffset: 1,
      endOffset: 3,
      selectedText: "😀",
    }), {
      reference: {
        documentRevision: "sha256:document",
        blockId: "block-emoji",
        startOffset: 1,
        endOffset: 3,
        quote: "😀",
      },
      error: null,
    });
    assert.match(createReaderSelectionReference({
      documentRevision: "sha256:document",
      blockId: "block-long",
      blockText: "a".repeat(4_001),
      startOffset: 0,
      endOffset: 4_001,
      selectedText: "a".repeat(4_001),
    }).error, /最多引用 4000 个字符/);
  } finally {
    await vite.close();
  }
});

test("context rail without an active close-reading session stays unchanged", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowContextRail } = await vite.ssrLoadModule(
      "/src/components/WorkflowContextRail.jsx",
    );
    const html = renderToStaticMarkup(React.createElement(WorkflowContextRail, {
      run: { status: "review_ready" },
      papers: [{
        id: "paper-1",
        title: "Candidate",
        venue: "AAAI",
        publishedAt: "2026-07-23",
      }],
      activeView: "evidence",
      onActiveViewChange() {},
    }));
    assert.match(html, /当前依据/);
    assert.match(html, /项目状态/);
    assert.doesNotMatch(html, /workflow-context-tab-full/);
    assert.doesNotMatch(html, /论文 Agent/);
  } finally {
    await vite.close();
  }
});
