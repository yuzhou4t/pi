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

test("rename conversation dialog starts from the safe conversation title", async () => {
  await withViteModule(
    "/src/components/RenameConversationDialog.jsx",
    ({ RenameConversationDialog }) => {
      const html = renderToStaticMarkup(React.createElement(RenameConversationDialog, {
        conversation: {
          id: "conversation-1",
          title: "新工作会话",
        },
        onClose() {},
        onConfirm() {},
      }));

      assert.match(html, /重命名工作会话/);
      assert.match(html, /value="新工作会话"/);
      assert.match(html, /maxLength="80"/);
      assert.match(html, /保存名称/);
      assert.doesNotMatch(html, /\/Users\/|rootLabel|绝对路径/);
    },
  );
});
