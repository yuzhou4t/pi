import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/SettingsPanel.jsx";

async function withSettingsPanel(callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(COMPONENT_PATH));
  } finally {
    await vite.close();
  }
}

test("model usage settings explain subscription cost semantics and rate details", async () => {
  await withSettingsPanel(({ UsageModelRow, UsageSummary }) => {
    const summaryHtml = renderToStaticMarkup(React.createElement(UsageSummary, {
      values: {
        calls: 4,
        tasks: 1,
        totalTokens: 157_914,
        apiEquivalentCostUsd: 0.823295,
        unpricedCallCount: 0,
      },
      costNote: "不代表订阅实际扣费",
    }));
    assert.match(summaryHtml, /4 次/);
    assert.match(summaryHtml, /157,914/);
    assert.match(summaryHtml, /API 等价估算/);
    assert.match(summaryHtml, /\$0\.8233/);
    assert.match(summaryHtml, /不代表订阅实际扣费/);

    const modelHtml = renderToStaticMarkup(React.createElement(UsageModelRow, {
      model: {
        providerId: "openai-codex",
        providerName: "GPT · ChatGPT 订阅",
        modelId: "gpt-5.6-sol",
        modelName: "GPT-5.6 Sol",
        workflowScope: "project_work",
        billingKind: "chatgpt_subscription",
        calls: 4,
        tasks: 1,
        inputTokens: 156_565,
        outputTokens: 1_349,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 157_914,
        apiEquivalentCostUsd: 0.823295,
        currentPricing: {
          input: 5,
          output: 30,
          cacheRead: 0.5,
          cacheWrite: 6.25,
          tiers: [{
            inputTokensAbove: 272_000,
            input: 10,
            output: 45,
            cacheRead: 1,
            cacheWrite: 12.5,
          }],
        },
      },
    }));
    assert.match(modelHtml, /GPT-5\.6 Sol/);
    assert.match(modelHtml, /正常工作/);
    assert.match(modelHtml, /ChatGPT 订阅/);
    assert.match(modelHtml, /当前基础参考单价/);
    assert.match(modelHtml, /不是 ChatGPT 订阅的实际扣款/);
    assert.match(modelHtml, /输入用量（含缓存读写）超过 272,000 Tokens/);
    assert.match(modelHtml, /阶梯输出/);
    assert.match(modelHtml, /\$45/);

    const paperHtml = renderToStaticMarkup(React.createElement(UsageModelRow, {
      model: {
        providerId: "deepseek",
        providerName: "DeepSeek API",
        modelId: "deepseek-v4-pro",
        modelName: "DeepSeek V4 Pro",
        workflowScope: "paper_reading",
        billingKind: "api",
        calls: 62,
        inputTokens: 200_000,
        outputTokens: 20_000,
        cacheReadTokens: 21_690,
        cacheWriteTokens: 0,
        totalTokens: 241_690,
        apiEquivalentCostUsd: 0.07809,
        historicalBackfilledCallCount: 62,
        stepBreakdown: [
          { step: "paper_agent", calls: 58 },
          { step: "candidate_summaries", calls: 4 },
        ],
        currentPricing: {
          input: 0.435,
          output: 0.87,
          cacheRead: 0.003625,
          cacheWrite: null,
          tiers: [],
        },
      },
    }));
    assert.match(paperHtml, /论文精读/);
    assert.match(paperHtml, /论文 Agent · 58 次/);
    assert.match(paperHtml, /候选解释 · 4 次/);
    assert.match(paperHtml, /62 次历史调用按当前官方费率回算/);
  });
});

test("settings navigation exposes the local model usage surface", async () => {
  await withSettingsPanel(({ SettingsDialog }) => {
    const html = renderToStaticMarkup(React.createElement(SettingsDialog, {
      section: "usage",
      onSectionChange: () => {},
      providerName: "GPT · ChatGPT 订阅",
      model: "GPT-5.6 Sol",
      onOpenProvider: () => {},
      onClose: () => {},
    }));

    assert.match(html, /模型用量/);
    assert.match(html, /统一查看正常工作与论文精读/);
    assert.match(html, /全部消耗/);
    assert.match(html, /论文精读/);
    assert.match(html, /今日/);
    assert.match(html, /30 天/);
    assert.match(html, /正在读取本机用量记录/);
  });
});

test("settings exposes server-backed provider credentials and the Skill center entry", async () => {
  await withSettingsPanel(({ SettingsDialog }) => {
    const providerHtml = renderToStaticMarkup(React.createElement(SettingsDialog, {
      section: "providers",
      onSectionChange: () => {},
      providerName: "DeepSeek",
      model: "DeepSeek V4 Pro",
      onOpenProvider: () => {},
      onConnectionsChanged: () => {},
      onOpenSkills: () => {},
      installedSkillCount: 3,
      onClose: () => {},
    }));
    assert.match(providerHtml, /模型服务商/);
    assert.match(providerHtml, /凭据只交给本机 Pi 服务保存/);
    assert.match(providerHtml, /连接 API 服务商/);
    assert.match(providerHtml, /正在读取 Pi 服务商目录/);
    assert.doesNotMatch(providerHtml, /localStorage|auth\.json/);

    const skillsHtml = renderToStaticMarkup(React.createElement(SettingsDialog, {
      section: "skills",
      onSectionChange: () => {},
      providerName: "DeepSeek",
      model: "DeepSeek V4 Pro",
      onOpenProvider: () => {},
      onConnectionsChanged: () => {},
      onOpenSkills: () => {},
      installedSkillCount: 3,
      onClose: () => {},
    }));
    assert.match(skillsHtml, /同步 Pi 官方目录/);
    assert.match(skillsHtml, /3 个/);
    assert.match(skillsHtml, /启用不开放 Extension/);
    assert.match(skillsHtml, /Pi 官方 Skill 网站/);
    assert.match(skillsHtml, /href="https:\/\/pi\.dev\/packages\?type=skill"/);
  });
});

test("settings exposes Worker connections and keeps CLI health checks user-triggered", async () => {
  await withSettingsPanel(({
    SettingsDialog,
    SettingsQuickPanel,
    connectionStatusLabel,
  }) => {
    const html = renderToStaticMarkup(React.createElement(SettingsDialog, {
      section: "connections",
      onSectionChange: () => {},
      providerName: "DeepSeek",
      model: "DeepSeek V4 Pro",
      onClose: () => {},
    }));
    assert.match(html, /连接控制台/);
    assert.match(html, /飞书文档 Worker/);
    assert.match(html, /Agent 邮箱 Worker/);
    assert.match(html, /IMA 笔记 Worker/);
    assert.doesNotMatch(html, /Canva|可画|Figma|Sketch|Zotero|Obsidian/);
    assert.match(html, /尚未检查/);
    assert.match(html, /检查连接/);
    assert.match(html, /连接检查状态仅在本次 Pi Agent 运行期间保留/);
    assert.doesNotMatch(html, /上次保存的状态/);
    assert.match(html, /只有点击“检查连接”才会运行对应的本机 CLI 健康检查/);
    assert.match(html, /正常工作提醒/);
    assert.match(html, /正在读取提醒订阅/);
    assert.doesNotMatch(html, /已发送测试消息|自动检查/u);
    assert.equal(connectionStatusLabel("unavailable"), "连接不可用");
    assert.equal(connectionStatusLabel("unexpected"), "状态未知");

    const quickHtml = renderToStaticMarkup(React.createElement(SettingsQuickPanel, {
      providerName: "DeepSeek",
      model: "DeepSeek V4 Pro",
      onOpenFull: () => {},
      onClose: () => {},
    }));
    assert.match(quickHtml, /互联/);
    assert.match(quickHtml, /Worker 连接与飞书提醒/);
  });
});

test("usage loading state never labels stale period data as current", async () => {
  await withSettingsPanel(({
    beginUsageLoadState,
    failUsageLoadState,
  }) => {
    const ready = {
      status: "ready",
      data: { period: "30d", totals: { totalTokens: 100 } },
      error: null,
      loadedPeriod: "30d",
      loadedWorkflow: "all",
    };

    assert.deepEqual(beginUsageLoadState(ready, "today"), {
      status: "loading",
      data: null,
      error: null,
      loadedPeriod: null,
      loadedWorkflow: null,
    });
    const refreshing = beginUsageLoadState(ready, "30d");
    assert.equal(refreshing.status, "refreshing");
    assert.equal(refreshing.data, ready.data);
    assert.deepEqual(
      failUsageLoadState(refreshing, "today", "all", "网络失败"),
      {
        status: "error",
        data: null,
        error: "网络失败",
        loadedPeriod: null,
        loadedWorkflow: null,
      },
    );
    assert.equal(
      failUsageLoadState(refreshing, "30d", "all", "网络失败").data,
      ready.data,
    );
    assert.equal(
      beginUsageLoadState(ready, "30d", "paper_reading").data,
      null,
    );
  });
});

test("data settings expose explicit, bounded cleanup for migrated legacy copies", async () => {
  await withSettingsPanel(({
    SettingsDialog,
    formatLocalDataBytes,
    legacyArchiveBlockedLabel,
    legacyArchiveCleanupConfirmation,
  }) => {
    const html = renderToStaticMarkup(React.createElement(SettingsDialog, {
      section: "data",
      onSectionChange: () => {},
      providerName: "DeepSeek",
      model: "DeepSeek V4 Pro",
      onClose: () => {},
    }));
    assert.match(html, /旧工作副本/);
    assert.match(html, /迁移完成后不再执行，仅在你明确确认时清理/);
    assert.match(html, /正在统计旧工作副本/);
    assert.equal(formatLocalDataBytes(213 * 1024 * 1024), "213.0 MB");
    assert.equal(legacyArchiveBlockedLabel("needs_review"), "需要先处理旧修改");
    const confirmation = legacyArchiveCleanupConfirmation([{
      title: "旧 TTS 验证",
      bytes: 213 * 1024 * 1024,
    }]);
    assert.match(confirmation, /确认清理 “旧 TTS 验证”/);
    assert.match(confirmation, /base\/workspace/);
    assert.match(confirmation, /Pi Session 和当前真实 Workspace 都会保留/);
    assert.match(confirmation, /无法撤销/);
    assert.doesNotMatch(confirmation, /\/Users\//);
  });
});
