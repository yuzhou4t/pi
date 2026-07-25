import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchProjectWorkFile,
  fetchProjectWorkTree,
  mapProjectWorkConversation,
} from "./projectWork.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("conversation mapping preserves a ready, hash-bound change set", () => {
  const mapped = mapProjectWorkConversation({
    conversation: {
      id: "conversation-1",
      project_id: "project-1",
      title: "修复设置页",
      status: "awaiting_confirmation",
      activeChangeSet: {
        id: "change-set-1",
        status: "ready",
        proposal_hash: "sha256:proposal",
        files: [{
          id: "change-file-1",
          path: "src/settings.css",
          operation: "modify",
          additions: 2,
          deletions: 1,
          diff: [
            "--- a/src/settings.css",
            "+++ b/src/settings.css",
            "@@ -1 +1,2 @@",
            "-position: fixed;",
            "+position: sticky;",
          ].join("\n"),
          base_hash: "sha256:before",
          after_hash: "sha256:after",
        }],
      },
      plan: {
        steps: [{ id: "step-1", text: "检查设置页布局", status: "completed" }],
      },
    },
    events: [{
      seq: 2,
      type: "tool_result",
      data: { name: "read", status: "completed", path: "src/settings.css" },
    }, {
      seq: 1,
      type: "plan_updated",
      data: { title: "计划已更新" },
    }],
  });

  assert.equal(mapped.pendingChangeSet.status, "ready");
  assert.equal(mapped.pendingChangeSet.proposalHash, "sha256:proposal");
  assert.equal(mapped.pendingChangeSet.files[0].baseHash, "sha256:before");
  assert.equal(mapped.pendingChangeSet.files[0].afterHash, "sha256:after");
  assert.deepEqual(mapped.pendingChangeSet.files[0].diff.slice(-2), [
    "-position: fixed;",
    "+position: sticky;",
  ]);
  assert.equal(mapped.plan[0].title, "检查设置页布局");
  assert.deepEqual(mapped.events.map((event) => event.seq), [1, 2]);
  assert.equal(mapped.events[1].toolName, "read");
  assert.equal(mapped.events[1].path, "src/settings.css");
});

test("string checks map across failed then passing runs while the command remains retryable", () => {
  const mapped = mapProjectWorkConversation({
    id: "conversation-verify",
    project_id: "project-1",
    verifications: [{
      id: "verification-command",
      command_id: "command-1",
      status: "ready",
      command: {
        file: "npm",
        args: ["test"],
        cwd: ".",
      },
      resolved_script: "node --test",
      checks: ["等待用户运行"],
    }, {
      id: "verification-failed",
      command_id: "command-1",
      status: "failed",
      command: "npm test",
      checks: ["设置页布局", "回归测试"],
      output: "AssertionError: footer overlaps content",
      exit_code: 1,
    }, {
      id: "verification-passed",
      command_id: "command-1",
      status: "passed",
      command: "npm test",
      checks: ["设置页布局", "回归测试"],
      output: ["2 tests passed"],
      exit_code: 0,
    }],
  });

  assert.deepEqual(mapped.verificationRuns[1].checks, [{
    id: "check-1",
    label: "设置页布局",
    status: "failed",
  }, {
    id: "check-2",
    label: "回归测试",
    status: "failed",
  }]);
  assert.deepEqual(
    mapped.verificationRuns[2].checks.map((check) => check.status),
    ["passed", "passed"],
  );
  assert.deepEqual(mapped.verificationRuns[1].logs, [
    "AssertionError: footer overlaps content",
  ]);
  assert.deepEqual(mapped.verificationRuns[2].logs, ["2 tests passed"]);
  assert.equal(mapped.verificationRuns[1].exitCode, 1);
  assert.equal(mapped.verificationRuns[2].exitCode, 0);

  assert.deepEqual(mapped.verificationCommand, {
    id: "command-1",
    label: "运行验证",
    executable: "npm",
    args: ["test"],
    displayCommand: "npm test",
    cwdLabel: ".",
    resolvedScript: "node --test",
    status: "ready",
  });
});

test("tree mapping flattens nested folders with stable paths and depths", async () => {
  const calls = [];
  const tree = await fetchProjectWorkTree({
    projectId: "project/with spaces",
    path: "src",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        path: "src",
        revision: "sha256:tree",
        next_cursor: "cursor-2",
        entries: [{
          name: "components",
          type: "directory",
          children: [{
            name: "Settings.jsx",
            type: "file",
            size: 512,
            hash: "sha256:file",
          }],
        }, {
          path: "src/index.js",
          kind: "file",
          depth: 1,
        }],
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project%2Fwith%20spaces/tree?path=src",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(tree, {
    path: "src",
    revision: "sha256:tree",
    cursor: "cursor-2",
    entries: [{
      id: "src/components",
      path: "src/components",
      name: "components",
      kind: "directory",
      size: null,
      contentHash: null,
      depth: 1,
    }, {
      id: "src/components/Settings.jsx",
      path: "src/components/Settings.jsx",
      name: "Settings.jsx",
      kind: "file",
      size: 512,
      contentHash: "sha256:file",
      depth: 2,
    }, {
      id: "src/index.js",
      path: "src/index.js",
      name: "index.js",
      kind: "file",
      size: null,
      contentHash: null,
      depth: 1,
    }],
  });
});

test("file mapping preserves bounded line coordinates and content hash", async () => {
  const calls = [];
  const file = await fetchProjectWorkFile({
    projectId: "project-1",
    path: "src/settings page.css",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        path: "src/settings page.css",
        language: "css",
        mime_type: "text/css",
        content: ".actions {\n  position: sticky;\n}",
        content_hash: "sha256:settings",
        start_line: 8,
        end_line: 10,
        total_lines: 24,
        byte_length: 34,
        truncated: false,
        binary: false,
      });
    },
  });

  assert.equal(
    calls[0].url,
    "/api/v1/project-work/projects/project-1/file?path=src%2Fsettings+page.css",
  );
  assert.equal(calls[0].options.method, "GET");
  assert.deepEqual(file.lines, [".actions {", "  position: sticky;", "}"]);
  assert.equal(file.contentHash, "sha256:settings");
  assert.equal(file.startLine, 8);
  assert.equal(file.endLine, 10);
  assert.equal(file.totalLines, 24);
  assert.equal(file.truncated, true);
  assert.equal(file.binary, false);
});
