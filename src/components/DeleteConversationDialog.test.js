import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

async function withViteModule(path, callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(path));
  } finally {
    await vite.close();
  }
}

test("delete conversation dialog names the session and explains the irreversible scope", async () => {
  await withViteModule(
    "/src/components/DeleteConversationDialog.jsx",
    ({ DeleteConversationDialog }) => {
      const html = renderToStaticMarkup(React.createElement(DeleteConversationDialog, {
        conversation: {
          id: "conversation-1",
          title: "检查登录页",
          pendingChangeFileCount: 2,
        },
        onClose() {},
        onConfirm() {},
      }));

      assert.match(html, /删除工作会话/);
      assert.match(html, /检查登录页/);
      assert.match(html, /不可恢复/);
      assert.match(html, /2 个尚未应用的修改文件/);
      assert.match(html, /不会删除项目文件夹/);
      assert.match(html, /不会回滚已经确认写入的修改/);
      assert.match(html, />取消</);
      assert.match(html, /删除会话/);
      assert.doesNotMatch(html, /\/Users\/|rootLabel|绝对路径/);
    },
  );
});

test("delete conversation dialog stays absent without a target", async () => {
  await withViteModule(
    "/src/components/DeleteConversationDialog.jsx",
    ({ DeleteConversationDialog }) => {
      const html = renderToStaticMarkup(React.createElement(DeleteConversationDialog, {
        conversation: null,
      }));
      assert.equal(html, "");
    },
  );
});

test("standalone deletion names the private draft scope without implying a bound project", async () => {
  await withViteModule(
    "/src/components/DeleteConversationDialog.jsx",
    ({ DeleteConversationDialog }) => {
      const html = renderToStaticMarkup(React.createElement(DeleteConversationDialog, {
        conversation: {
          id: "standalone-1",
          projectId: null,
          scope: "standalone",
          workspaceKind: "scratch",
          title: "整理需求",
          pendingChangeFileCount: 1,
        },
        onClose() {},
        onConfirm() {},
      }));

      assert.match(html, /私有草稿区/);
      assert.match(html, /随这个对话一起删除/);
      assert.doesNotMatch(html, /不会删除项目文件夹|不会回滚已经确认写入/);
    },
  );
});

test("delete confirmation stays disabled while preflight is pending or the latest session is busy", async () => {
  await withViteModule(
    "/src/components/DeleteConversationDialog.jsx",
    ({ DeleteConversationDialog }) => {
      const checkingHtml = renderToStaticMarkup(React.createElement(DeleteConversationDialog, {
        conversation: {
          id: "conversation-1",
          title: "检查登录页",
          checking: true,
        },
      }));
      assert.match(checkingHtml, /正在核对最新会话状态/);
      assert.match(checkingHtml, /正在核对/);
      assert.match(checkingHtml, /disabled/);

      const busyHtml = renderToStaticMarkup(React.createElement(DeleteConversationDialog, {
        conversation: {
          id: "conversation-1",
          title: "检查登录页",
          checking: false,
          deleteBlocked: true,
        },
      }));
      assert.match(busyHtml, /请先停止当前运行/);
      assert.match(busyHtml, /请先停止运行/);
      assert.match(busyHtml, /disabled/);

      const failedHtml = renderToStaticMarkup(React.createElement(DeleteConversationDialog, {
        conversation: {
          id: "conversation-1",
          title: "检查登录页",
          checking: false,
          checkError: "无法核对会话状态，请取消后重试",
        },
      }));
      assert.match(failedHtml, /无法核对会话状态/);
      assert.match(failedHtml, /无法核对状态/);
      assert.match(failedHtml, /disabled/);
    },
  );
});
