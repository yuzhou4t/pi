import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/ProviderMenu.jsx";

async function withProviderMenu(callback) {
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

const gptProvider = {
  id: "openai-codex",
  name: "GPT · ChatGPT 订阅",
  available: true,
  hint: "已连接 · 下轮消息生效",
  models: ["gpt-5.3-codex-spark"],
};

test("normal-work GPT menu shows its supported thinking strengths", async () => {
  await withProviderMenu(({ ProviderMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProviderMenu, {
      open: true,
      onOpenChange: () => {},
      providers: [gptProvider],
      providerId: gptProvider.id,
      model: gptProvider.models[0],
      onProviderChange: () => {},
      onModelChange: () => {},
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      thinkingLevel: "high",
      supportsThinking: true,
      thinkingDisabled: false,
      onThinkingLevelChange: () => {},
    }));

    assert.match(html, /GPT · ChatGPT 订阅 · 思考 · 高/);
    assert.match(html, /aria-label="思考强度"/);
    assert.match(html, /思考 · 关闭/);
    assert.match(html, /思考 · 极低/);
    assert.match(html, /思考 · 很高/);
    assert.doesNotMatch(html, /思考 · 最高/);
  });
});

test("a newly cataloged provider gets the same thinking control without UI adaptation", async () => {
  await withProviderMenu(({ ProviderMenu }) => {
    const provider = {
      id: "provider-x",
      name: "新模型 API",
      available: true,
      hint: "已连接",
      models: ["reasoning-model-x"],
    };
    const html = renderToStaticMarkup(React.createElement(ProviderMenu, {
      open: true,
      onOpenChange: () => {},
      providers: [provider],
      providerId: provider.id,
      model: provider.models[0],
      onProviderChange: () => {},
      onModelChange: () => {},
      thinkingLevels: ["off", "high", "max"],
      thinkingLevel: "max",
      supportsThinking: true,
      thinkingDisabled: false,
      onThinkingLevelChange: () => {},
    }));

    assert.match(html, /新模型 API · 思考 · 最高/);
    assert.match(html, /aria-label="思考强度"/);
    assert.match(html, /思考 · 高/);
    assert.match(html, /思考 · 最高/);
    assert.doesNotMatch(html, /GPT 订阅思考强度/);
  });
});

test("shared provider menus omit normal-work thinking settings by default", async () => {
  await withProviderMenu(({ ProviderMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProviderMenu, {
      open: true,
      onOpenChange: () => {},
      providers: [gptProvider],
      providerId: gptProvider.id,
      model: gptProvider.models[0],
      onProviderChange: () => {},
      onModelChange: () => {},
    }));

    assert.doesNotMatch(html, /aria-label="思考强度"/);
    assert.doesNotMatch(html, /思考 · 高/);
  });
});

test("model selection controls disable while one configuration request is pending", async () => {
  await withProviderMenu(({ ProviderMenu }) => {
    const html = renderToStaticMarkup(React.createElement(ProviderMenu, {
      open: true,
      onOpenChange: () => {},
      providers: [gptProvider],
      providerId: gptProvider.id,
      model: gptProvider.models[0],
      onProviderChange: () => {},
      onModelChange: () => {},
      selectionDisabled: true,
    }));

    assert.match(
      html,
      /<button[^>]*class="provider-option is-selected"[^>]*disabled=""/,
    );
    assert.match(html, /<select id="model-select" disabled=""/);
  });
});
