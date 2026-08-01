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

test("add project dialog offers an existing folder and a new project folder", async () => {
  await withViteModule("/src/components/BindProjectDialog.jsx", ({ BindProjectDialog }) => {
    const html = renderToStaticMarkup(React.createElement(BindProjectDialog, {
      open: true,
      workspaceMode: "project_work",
      onClose() {},
      onBind() {},
    }));

    assert.match(html, /正常工作/);
    assert.match(html, /添加项目/);
    assert.match(html, /选择本地文件夹/);
    assert.match(html, /新建项目文件夹/);
    assert.match(html, /关闭添加项目/);
    assert.doesNotMatch(html, /fixture|模拟|演示/);
  });
});

test("add project dialog stays absent while closed", async () => {
  await withViteModule("/src/components/BindProjectDialog.jsx", ({ BindProjectDialog }) => {
    const html = renderToStaticMarkup(React.createElement(BindProjectDialog, {
      open: false,
      workspaceMode: "paper_reading",
    }));

    assert.equal(html, "");
  });
});
