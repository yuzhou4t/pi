import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/ProjectGitCloseout.jsx";

function record(id, status, commitMessage) {
  return {
    id,
    status,
    commitMessage,
    branch: "main",
    head: "a".repeat(40),
    files: [{
      path: "src/app.js",
      hash: `sha256:${"b".repeat(64)}`,
      exists: true,
      mode: 0o644,
      baseHash: `sha256:${"a".repeat(64)}`,
      baseExists: true,
      baseMode: 0o644,
    }],
    verificationEvidence: [{ id: "verification-1", status: "passed" }],
    commitHash: status === "committed" ? "c".repeat(40) : null,
    error: status === "failed" ? { message: "提交失败" } : null,
  };
}

test("Git closeout keeps an older ready proposal actionable while showing newer history", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const {
      ProjectGitCloseout,
      selectGitCloseoutProposal,
    } = await vite.ssrLoadModule(COMPONENT_PATH);
    const records = [
      record("failed-new", "failed", "fix: failed newer"),
      record("committed-new", "committed", "fix: completed newer"),
      record("ready-old", "ready", "fix: actionable older"),
    ];

    assert.equal(selectGitCloseoutProposal(records).id, "ready-old");
    const html = renderToStaticMarkup(
      React.createElement(ProjectGitCloseout, {
        records,
        status: "ready",
      }),
    );

    assert.match(html, /fix: actionable older/);
    assert.match(html, /确认创建这一笔本地提交/);
    assert.match(html, /基线 a{12} → b{12}/);
    assert.match(html, /历史记录/);
    assert.match(html, /fix: failed newer/);
    assert.match(html, /fix: completed newer/);
  } finally {
    await vite.close();
  }
});

test("Git closeout surfaces recovery before completed history when nothing is ready", async () => {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { selectGitCloseoutProposal } = await vite.ssrLoadModule(
      COMPONENT_PATH,
    );
    assert.equal(selectGitCloseoutProposal([
      record("committed-new", "committed", "done"),
      {
        ...record("recovery-old", "recovery_blocked", "recover"),
        error: { message: "恢复需要人工检查" },
      },
    ]).id, "recovery-old");
  } finally {
    await vite.close();
  }
});
