import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/SkillCenter.jsx";

test("Skill center defaults to installed items and keeps the broad catalog external", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const {
      SkillCenter,
      SkillInstallReview,
      installedSkillRow,
      packageStateLine,
    } = await vite.ssrLoadModule(COMPONENT_PATH);
    const html = renderToStaticMarkup(React.createElement(SkillCenter, {
      onStateChange: () => {},
      onClose: () => {},
    }));

    assert.match(html, /Pi Package Catalog/);
    assert.match(html, /查看 Pi 官方 Skill/);
    assert.match(html, /href="https:\/\/pi\.dev\/packages\?type=skill"/);
    assert.match(html, /只显示本机安装项和已经确认的候选/);
    assert.match(html, /已安装 0/);
    assert.match(html, /已确认候选 4/);
    assert.match(html, /没有安装任何 Skill/);
    assert.doesNotMatch(html, /正在同步 Pi Skill 目录|Superpowers|论文每月追踪/);
    assert.match(html, /安装不会自动启用/);
    assert.match(html, /不开放 Extension/);
    assert.doesNotMatch(html, /一键运行安装脚本|MCP 市场/);
    assert.deepEqual(
      installedSkillRow({
        id: "@counterposition/skill-pi",
        name: "@counterposition/skill-pi",
        enabled: false,
      }),
      {
        id: "@counterposition/skill-pi",
        name: "@counterposition/skill-pi",
        enabled: false,
        installed: true,
        installSupported: true,
        kind: "package",
      },
    );
    assert.match(packageStateLine({
      kind: "package",
      installSupported: true,
      installed: true,
      enabledPreference: true,
      runtimeCompatible: false,
      compatibilityReason: "当前运行时缺少：受控本地 Git 收尾事务",
    }), /当前不会加载.*Git 收尾事务/);

    const reviewHtml = renderToStaticMarkup(
      React.createElement(SkillInstallReview, {
        preview: {
          name: "@pi-agent/git-closeout",
          version: "1.1.0",
          skillCount: 1,
          source: "bundled:@pi-agent/git-closeout@1.1.0",
          archiveFileCount: 1,
          archiveBytes: 128,
          integrity: "sha256-demo",
          skillFiles: ["skills/git-closeout/SKILL.md"],
          reviewMode: "install",
          runtimeCompatible: false,
          compatibilityReason: "当前运行时缺少：受控本地 Git 收尾事务",
          requiredRuntimeCapabilities: [
            { id: "project_read", label: "受控读取项目文件" },
            {
              id: "git_closeout_transaction",
              label: "受控本地 Git 收尾事务",
            },
          ],
          effectScopes: [{
            id: "git_local_commit",
            label: "经确认后创建本地提交；默认不推送",
            confirmationRequired: true,
          }],
          skillDocuments: [{
            path: "skills/git-closeout/SKILL.md",
            content: "# Git closeout\n\nExact reviewed instructions.\n",
          }],
        },
        status: "review",
        error: null,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );
    assert.match(reviewHtml, /当前运行时不兼容/);
    assert.match(reviewHtml, /受控本地 Git 收尾事务/);
    assert.match(reviewHtml, /经确认后创建本地提交；默认不推送/);
    assert.match(reviewHtml, /查看完整 SKILL\.md/);
    assert.match(reviewHtml, /Exact reviewed instructions/);
  } finally {
    await vite.close();
  }
});
