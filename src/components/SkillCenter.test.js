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
      installedSkillRow,
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
    assert.match(html, /已确认候选 2/);
    assert.match(html, /没有安装任何 Skill/);
    assert.doesNotMatch(html, /正在同步 Pi Skill 目录|Superpowers|论文每周追踪/);
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
  } finally {
    await vite.close();
  }
});
