import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createViteServer } from "vite";

let sharedViteServerPromise = null;

async function createServer(options) {
  sharedViteServerPromise ??= createViteServer({
    ...options,
    server: {
      ...options.server,
      warmup: { clientFiles: [] },
    },
    optimizeDeps: {
      noDiscovery: true,
      include: [],
    },
  });
  const server = await sharedViteServerPromise;
  return {
    ssrLoadModule: server.ssrLoadModule.bind(server),
    close: async () => {},
  };
}

after(async () => {
  if (!sharedViteServerPromise) return;
  await (await sharedViteServerPromise).close();
});

test("live candidate review shows appended papers and a durable refresh failure", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const papers = Array.from({ length: 6 }, (_, index) => ({
      id: `paper-live-${index + 1}`,
      title: index === 5 ? "Newly appended sixth paper" : `Paper ${index + 1}`,
      authors: ["Author"],
      venue: "ACL",
      isDemo: false,
      isNew: true,
      publishedThisMonth: index !== 5,
      discoveryType: index === 5
        ? "本月补发现 · 非本月新论文"
        : "本月新论文",
      mineruStatus: "pdf_not_prepared",
      selectionSummary: "候选摘要",
      projectImpact: "项目关系待核验",
    }));
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers,
      run: {
        source: "live",
        runId: "run-live-six",
        status: "review_ready",
        selectedPaperIds: [],
        selectablePaperIds: [],
        proposals: [],
      },
      journalRunState: {
        status: "ready",
        run: {
          status: "review_ready",
          phase: "candidate_review",
          createdAt: "2026-08-01T00:00:00.000Z",
          candidates: papers,
          candidateRefresh: {
            lastScanObservedAt: "2026-08-02T20:05:00.000Z",
            lastError: { message: "后台刷新失败，请稍后重试" },
            lastScanSummary: {
              observed_at: "2026-08-02T20:05:00.000Z",
              source_count: 11,
              successful_source_count: 10,
              failed_source_ids: ["journal-jmlr"],
              raw_record_count: 30,
              topic_candidate_count: 7,
            },
            sourceStatuses: [{
              sourceId: "journal-jmlr",
              shortName: "JMLR",
              status: "failed",
              attempts: [
                { role: "primary", status: "failed", errorCode: "OFFICIAL_SOURCE_EMPTY" },
                { role: "fallback", status: "failed", errorCode: "SOURCE_ROUTE_EMPTY" },
              ],
            }],
          },
          scanSummary: {
            raw_record_count: 20,
            topic_candidate_count: 6,
            source_count: 11,
            successful_source_count: 9,
            failed_source_ids: ["journal-jmlr", "conference-iccv"],
          },
        },
      },
      candidateSummaryState: { items: [] },
      onRefreshCandidates() {},
    }));

    assert.match(html, /Newly appended sixth paper/);
    assert.match(html, /<strong>6<\/strong> 条重点候选/);
    assert.match(html, /后台刷新失败，请稍后重试/);
    assert.match(html, /2026年7月4日 – 8月3日/);
    assert.match(html, /上次刷新 2026-08-03/);
    assert.match(html, /来源成功 10\/11/);
    assert.match(html, /失败来源：JMLR（OFFICIAL_SOURCE_EMPTY \/ SOURCE_ROUTE_EMPTY）/);
    assert.doesNotMatch(html, /来源成功 9\/11/);
    assert.match(html, /is-classic[^>]*>本月补发现 · 非本月新论文/);
  } finally {
    await vite.close();
  }
});

test("failed guide generation keeps the paper selected and exposes a clear retry state", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const paper = {
      id: "paper-live-4",
      title: "How Memory Management Impacts LLM Agents",
      authors: ["Author"],
      venue: "arXiv",
      isDemo: false,
      mineruStatus: "ready",
      selectionSummary: "研究 Agent 记忆管理。",
      projectImpact: "用于验证长期记忆策略。",
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers: [paper],
      run: {
        source: "live",
        runId: "run-live-failed",
        status: "review_ready",
        selectedPaperIds: [paper.id],
        selectablePaperIds: [paper.id],
        preparedGuideIds: [],
        proposals: [],
        lastError: "why_read 长度不符合导读合同",
      },
      journalRunState: {
        status: "ready",
        run: {
          status: "review_ready",
          phase: "candidate_review",
          candidates: [paper],
          guides: {
            status: "failed",
            requestedPaperIds: [paper.id],
            papers: { [paper.id]: { status: "failed" } },
          },
        },
      },
      candidateSummaryState: { items: [] },
    }));

    assert.match(html, /上一次导读过长，已保留选择/);
    assert.match(html, /系统现在会自动收敛到展示长度/);
    assert.match(html, /已保留所选论文/);
    assert.match(html, /How Memory Management Impacts LLM Agents/);
    assert.match(html, /已选择 1\/2 篇/);
    assert.match(html, /重新生成五分钟导读/);
    assert.match(html, /type="checkbox"[^>]*checked=""/);
  } finally {
    await vite.close();
  }
});

test("a failed paper exposes a scoped full-text retry without implementation jargon", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const paper = {
      id: "paper-live-retry",
      title: "A paper awaiting full text",
      authors: ["Author"],
      venue: "arXiv",
      isDemo: false,
      mineruStatus: "parse_failed",
      mineruRunStatus: "partial",
      selectionSummary: "研究可恢复的论文处理流程。",
      projectImpact: "用于验证逐篇恢复。",
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers: [paper],
      run: {
        source: "live",
        runId: "run-live-retry",
        status: "review_ready",
        selectedPaperIds: [],
        selectablePaperIds: [],
        preparedGuideIds: [],
        proposals: [],
      },
      journalRunState: {
        status: "ready",
        run: {
          status: "review_ready",
          phase: "candidate_review",
          candidates: [paper],
          mineru: { status: "partial" },
        },
      },
      candidateSummaryState: { items: [] },
      onRetryPaperDocument() {},
    }));

    assert.match(html, /全文准备失败/);
    assert.match(html, /重试全文准备/);
    assert.doesNotMatch(html, /MinerU|PDF|上传|解析服务/);
  } finally {
    await vite.close();
  }
});

test("an old English guide is blocked until explicit Chinese regeneration while citations render LaTeX", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const paper = {
      id: "paper-live-english",
      title: "Memory Management for LLM Agents",
      venue: "arXiv",
      publishedAt: "2026-07-23",
      isDemo: false,
      mineruStatus: "ready",
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers: [paper],
      run: {
        source: "live",
        runId: "run-live-english",
        status: "guide_ready",
        selectedPaperIds: [paper.id],
        selectablePaperIds: [paper.id],
        preparedGuideIds: [paper.id],
        guideChoices: {},
        activePaperId: paper.id,
        proposals: [],
      },
      journalRunState: {
        status: "ready",
        run: { status: "guide_ready", phase: "guide_review" },
      },
      candidateSummaryState: { items: [] },
      guideState: {
        byPaperId: {
          [paper.id]: {
            problem: "The paper studies memory management.",
            whyRead: "It reports a useful evaluation.",
            intuition: "The policy chooses a memory operation.",
            evidence: "Experiments compare several baselines.",
            limitations: "Some settings remain untested.",
            questions: ["How stable are the results?", "What fails?"],
            references: [{
              blockId: "block-1",
              path: ["Paper", "Method"],
              ordinal: 3,
              excerpt: "The policy is $\\pi(q,e)=1$ when the memory is retained.",
            }],
          },
        },
        errorsByPaperId: {},
      },
      onPrepareGuides() {},
      onOpenPaper() {},
    }));

    assert.match(html, /这是一份旧版英文导读/);
    assert.match(html, /重新生成中文导读/);
    assert.doesNotMatch(html, /The paper studies memory management/);
    assert.doesNotMatch(html, /进入分阶段精读/);
    assert.match(html, /导读引用原文 · 点击查看完整段落/);
    assert.match(html, /class="katex"/);
    assert.doesNotMatch(html, /\$\\pi/);
    const reviewStep = html.match(/<button class="workflow-step-button"[^>]*aria-label="回看已完成步骤：候选"[^>]*>/)?.[0];
    assert.ok(reviewStep);
    assert.doesNotMatch(reviewStep, /disabled=/);
    assert.match(html, /aria-label="查看当前步骤：导读"/);
    assert.match(html, /disabled=""[^>]*aria-label="精读尚不可查看"/);
  } finally {
    await vite.close();
  }
});

test("a no-write completion exposes only the stages that the run actually visited", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers: [],
      run: {
        source: "live",
        runId: "run-no-write",
        status: "completed_no_write",
        selectedPaperIds: [],
        preparedGuideIds: [],
        guideChoices: {},
        readingStatusByPaperId: {},
        proposals: [],
      },
      journalRunState: {
        status: "ready",
        run: {
          status: "completed_no_write",
          candidates: [],
          guides: { requestedPaperIds: [], papers: {} },
        },
      },
      candidateSummaryState: { items: [] },
    }));

    assert.match(html, /aria-label="回看已完成步骤：候选"/);
    assert.match(html, /disabled=""[^>]*aria-label="导读尚不可查看"/);
    assert.match(html, /disabled=""[^>]*aria-label="精读尚不可查看"/);
    assert.match(html, /disabled=""[^>]*aria-label="预览尚不可查看"/);
    assert.match(html, /aria-label="查看当前步骤：完成"/);
  } finally {
    await vite.close();
  }
});

test("a persisted live reading run shows recovery instead of a fake empty paper list", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers: [],
      run: {
        source: "live",
        runId: "run-restoring",
        status: "reading",
        selectedPaperIds: ["paper-1"],
        preparedGuideIds: ["paper-1"],
        guideChoices: { "paper-1": "read" },
        readingStatusByPaperId: { "paper-1": "reading" },
        proposals: [],
      },
      journalRunState: {
        status: "restoring",
        run: null,
        error: null,
      },
      candidateSummaryState: { items: [] },
      onRestoreJournalRuns() {},
    }));

    assert.match(html, /正在恢复上次 Run 与论文正文/);
    assert.match(html, /不会先显示一个空的阅读列表/);
    assert.equal(html.includes("0/0 篇已整理"), false);
    assert.doesNotMatch(html, /选择一篇论文继续阅读/);
    assert.doesNotMatch(html, /Context Ledgers for Verifiable Long-Horizon Agents/);
    assert.doesNotMatch(html, /内置候选|示例论文/);
    assert.doesNotMatch(html, /workflow-step-flow/);
  } finally {
    await vite.close();
  }
});

test("live guide, paper workbench, and archive handoff render in the validated order", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const paper = {
      id: "paper-live-1",
      title: "Live paper",
      authors: ["Author"],
      venue: "AAAI",
      publishedAt: "2026-07-23",
      isDemo: false,
      mineruStatus: "ready",
    };
    const common = {
      papers: [paper],
      candidateSummaryState: { items: [] },
      journalRunState: {
        status: "ready",
        run: { status: "guide_ready", phase: "guide_review" },
      },
      guideState: {
        byPaperId: {
          [paper.id]: {
            problem: "问题",
            whyRead: "价值",
            intuition: "方法",
            evidence: "证据",
            limitations: "局限",
            questions: ["接下来验证什么？"],
            references: [],
          },
        },
        errorsByPaperId: {},
      },
      zoteroUiState: {
        targetStatus: "ready",
        selectedTargetId: "C1",
        targets: [{
          id: "C1",
          name: "AI 前沿论文",
          libraryName: "我的文库",
          level: 2,
          path: ["我的文库", "研究", "AI 前沿论文"],
          editable: true,
          filesEditable: true,
        }, {
          id: "C2",
          name: "AI 前沿论文",
          libraryName: "我的文库",
          level: 2,
          path: ["我的文库", "产品", "AI 前沿论文"],
          editable: true,
          filesEditable: true,
        }],
      },
      obsidianUiState: {
        runId: "run-live-1",
        status: "idle",
        preview: null,
        error: null,
      },
      projectStateUiState: {
        runId: "run-live-1",
        status: "idle",
        preview: null,
        error: null,
      },
      onSelectZoteroTarget() {},
      onRetryZoteroTargets() {},
      onGeneratePreview() {},
      onChooseGuideAction() {},
      onRestartFromGuide() {},
    };
    const guideHtml = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      ...common,
      run: {
        source: "live",
        runId: "run-live-1",
        status: "guide_ready",
        selectedPaperIds: [paper.id],
        preparedGuideIds: [paper.id],
        guideChoices: { [paper.id]: "read" },
        activePaperId: paper.id,
        proposals: [],
      },
    }));
    assert.doesNotMatch(guideHtml, /生成 Zotero 精确预览/);
    assert.match(guideHtml, /正在进入下一步/);

    const readingRun = {
      source: "live",
      runId: "run-live-1",
      status: "reading",
      selectedPaperIds: [paper.id],
      preparedGuideIds: [paper.id],
      guideChoices: { [paper.id]: "read" },
      activePaperId: paper.id,
      readingStatusByPaperId: { [paper.id]: "reading" },
      proposals: [],
    };
    const readingHtml = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      ...common,
      onOpenCloseReading() {},
      run: readingRun,
    }));
    // 精读进行中的默认落点现在是候选审阅页；研读入口在左栏论文列表。
    assert.match(readingHtml, /本月推荐的论文都在这里/);
    assert.match(readingHtml, /查看精读进度/);
    assert.doesNotMatch(readingHtml, /选择一篇论文继续阅读/);
    assert.doesNotMatch(readingHtml, /Zotero collection/);

    const readerHtml = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      ...common,
      run: readingRun,
      readerTarget: {
        runId: "run-live-1",
        paperId: paper.id,
        blockId: null,
        purpose: "close-reading",
      },
      onCloseReader() {},
      onReaderContextChange() {},
      onReaderSelectionChange() {},
    }));
    assert.match(readerHtml, /workflow-run-header is-artifact-mode/);
    assert.match(readerHtml, /论文工作台 · 研读中/);
    assert.match(readerHtml, /正在打开论文正文/);
    assert.doesNotMatch(readerHtml, /workflow-step-flow/);

    const archiveHtml = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      ...common,
      run: {
        source: "live",
        runId: "run-live-1",
        status: "draft_ready",
        selectedPaperIds: [paper.id],
        preparedGuideIds: [paper.id],
        guideChoices: { [paper.id]: "read" },
        activePaperId: paper.id,
        readingStatusByPaperId: { [paper.id]: "complete" },
        proposals: [],
      },
    }));
    assert.match(archiveHtml, /阅读阶段已完成，先核对归档目标/);
    assert.match(archiveHtml, /我的文库 \/ 研究 \/ AI 前沿论文/);
    assert.match(archiveHtml, /我的文库 \/ 产品 \/ AI 前沿论文/);
    assert.match(archiveHtml, /Obsidian 精读笔记/);
    assert.match(archiveHtml, /项目状态更新建议/);
    assert.ok(
      archiveHtml.indexOf("Obsidian 精读笔记")
        < archiveHtml.indexOf("项目状态更新建议"),
    );
    assert.ok(
      archiveHtml.indexOf("项目状态更新建议")
        < archiveHtml.indexOf("Zotero collection"),
    );
    assert.match(archiveHtml, /生成归档精确预览/);

    const readyObsidianPreview = {
      runId: "run-live-1",
      status: "ready",
      error: null,
      preview: {
        proposalHash: "sha256:obsidian",
        proposals: [{
          id: "obsidian-paper-live-1",
          paperIds: [paper.id],
          target: "obsidian",
          title: "2026-Author-Live-paper--abcd1234.md",
          targetLocator: "/vault/论文精读/2026-Author-Live-paper--abcd1234.md",
          preview: ["新建文件"],
          markdown: "# Live paper\n\n## 1. 研究问题\n",
          contentHash: "sha256:content",
          targetVersionOrHash: "sha256:target",
          actionable: true,
          selected: true,
        }],
      },
    };
    const readyProjectStatePreview = {
      runId: "run-live-1",
      status: "ready",
      error: null,
      preview: {
        proposalId: "project-state-preview-1",
        proposalHash: "sha256:project-state-preview",
        proposal: {
          id: "project-state-preview-1",
          paperIds: [paper.id],
          target: "project_state",
          title: "PRODUCT_MEETING.md",
          targetLocator: "/project/PRODUCT_MEETING.md",
          preview: ["追加 1 篇精读论文的项目影响与下一步"],
          markdown: "<!-- pi-agent:project-state-run:run-live-1 -->\n## 摘要正文\n",
          contentHash: "sha256:project-state-append",
          targetVersionOrHash: "sha256:project-state-target",
          actionable: true,
          selected: true,
          diff: {
            beforeHash: "sha256:project-state-before",
            afterHash: "sha256:project-state-after",
            appendText: "\n\n<!-- exact-append -->\n## 本轮确认的项目更新\n",
          },
        },
      },
    };
    const approvalHtml = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      ...common,
      obsidianUiState: readyObsidianPreview,
      projectStateUiState: readyProjectStatePreview,
      run: {
        source: "live",
        runId: "run-live-1",
        status: "awaiting_approval",
        selectedPaperIds: [paper.id],
        preparedGuideIds: [paper.id],
        guideChoices: { [paper.id]: "read" },
        activePaperId: paper.id,
        readingStatusByPaperId: { [paper.id]: "complete" },
        proposals: [{
          id: "zotero-paper-live-1",
          paperIds: [paper.id],
          target: "zotero",
          title: "新建题录并附加全文与导读",
          targetLocator: "我的文库 / 研究 / AI 前沿论文",
          preview: ["动作：新建题录"],
          selected: true,
          actionable: true,
          status: "draft",
        }],
      },
    }));
    assert.match(approvalHtml, /Obsidian 精读笔记/);
    assert.match(approvalHtml, /完整笔记正文、目标文件与内容哈希/);
    assert.match(approvalHtml, /项目状态更新/);
    assert.match(approvalHtml, /\/project\/PRODUCT_MEETING\.md/);
    assert.match(approvalHtml, /查看将追加的完整内容/);
    assert.match(approvalHtml, /exact-append/);
    assert.match(approvalHtml, /本轮确认的项目更新/);
    assert.doesNotMatch(approvalHtml, /摘要正文/);
    assert.match(approvalHtml, /sha256:project-state-before/);
    assert.match(approvalHtml, /sha256:project-state-after/);
    assert.ok(
      approvalHtml.indexOf("Obsidian 精读笔记")
        < approvalHtml.indexOf("项目状态更新"),
    );
    assert.ok(
      approvalHtml.indexOf("项目状态更新")
        < approvalHtml.indexOf("<h3>Zotero</h3>"),
    );
    assert.match(approvalHtml, /确认写入所选内容/);
    assert.match(approvalHtml, /写后逐项读回核验/);

    const partialRecoveryHtml = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      ...common,
      journalRunState: {
        status: "ready",
        run: {
          status: "partial",
          phase: "archive_commit",
          archiveBatch: { status: "failed" },
          obsidian: { status: "completed" },
          zotero: { status: "completed" },
          projectState: { status: "failed" },
        },
      },
      obsidianUiState: readyObsidianPreview,
      projectStateUiState: readyProjectStatePreview,
      onRetryFailed() {},
      run: {
        source: "live",
        runId: "run-live-1",
        status: "partial",
        selectedPaperIds: [paper.id],
        preparedGuideIds: [paper.id],
        guideChoices: { [paper.id]: "read" },
        activePaperId: paper.id,
        readingStatusByPaperId: { [paper.id]: "complete" },
        proposals: [{
          id: "zotero-paper-live-1",
          paperIds: [paper.id],
          target: "zotero",
          title: "新建题录并附加全文与导读",
          targetLocator: "我的文库 / 研究 / AI 前沿论文",
          preview: ["动作：新建题录"],
          selected: true,
          actionable: true,
          status: "committed",
        }],
      },
    }));
    assert.match(partialRecoveryHtml, /项目状态更新/);
    assert.match(partialRecoveryHtml, /确认写入所选内容/);
    assert.match(partialRecoveryHtml, /workflow-approval-stage/);
    assert.doesNotMatch(partialRecoveryHtml, /workflow-result-stage is-partial/);
  } finally {
    await vite.close();
  }
});

test("a reading run lands on the weekly candidate page instead of the reading stage", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { WorkflowWorkspace } = await vite.ssrLoadModule(
      "/src/components/WorkflowWorkspace.jsx",
    );
    const paper = {
      id: "paper-live-reading",
      title: "Memory Management for Reading Runs",
      authors: ["Author"],
      venue: "arXiv",
      isDemo: false,
      mineruStatus: "ready",
      selectionSummary: "研究 Agent 记忆管理。",
      projectImpact: "用于验证长期记忆策略。",
    };
    const html = renderToStaticMarkup(React.createElement(WorkflowWorkspace, {
      papers: [paper],
      run: {
        source: "live",
        runId: "run-live-reading",
        status: "reading",
        selectedPaperIds: [paper.id],
        selectablePaperIds: [paper.id],
        preparedGuideIds: [paper.id],
        guideChoices: { [paper.id]: "read" },
        readingStatusByPaperId: { [paper.id]: "reading" },
        proposals: [],
      },
      journalRunState: {
        status: "ready",
        run: {
          status: "reading",
          phase: "close_reading",
          candidates: [paper],
          readings: { paperIds: [paper.id] },
        },
      },
      candidateSummaryState: { items: [] },
    }));

    // 固定落点：候选审阅页 + 引导提示，而不是研读阶段画面。
    assert.match(html, /本月推荐的论文都在这里/);
    assert.match(html, /查看精读进度/);
    assert.match(html, /Memory Management for Reading Runs/);
    assert.doesNotMatch(html, /选择一篇论文继续阅读/);
  } finally {
    await vite.close();
  }
});
