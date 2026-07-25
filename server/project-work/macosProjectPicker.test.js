import assert from "node:assert/strict";
import test from "node:test";
import { createMacOSProjectPicker } from "./macosProjectPicker.js";

test("macOS project picker returns an existing project root without exposing extra data", async () => {
  const calls = [];
  const picker = createMacOSProjectPicker({
    platform: "darwin",
    execute: async (...args) => {
      calls.push(args);
      return {
        stdout: "/Users/example/My Project/\n",
        stderr: "",
      };
    },
  });

  const result = await picker({ mode: "existing" });

  assert.deepEqual(result, { rootPath: "/Users/example/My Project" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.match(calls[0][1].join(" "), /选择要绑定的本地项目文件夹/);
  assert.equal(calls[0][2].timeout, 120_000);
});

test("macOS project picker returns the selected parent for project creation", async () => {
  const picker = createMacOSProjectPicker({
    platform: "darwin",
    execute: async () => ({
      stdout: "/Users/example/Projects/\n",
      stderr: "",
    }),
  });

  const result = await picker({ mode: "create" });

  assert.deepEqual(result, { parentPath: "/Users/example/Projects" });
});

test("macOS project picker reports user cancellation as a safe typed error", async () => {
  const picker = createMacOSProjectPicker({
    platform: "darwin",
    execute: async () => {
      const error = new Error("osascript failed");
      error.code = 1;
      error.stderr = "execution error: User canceled. (-128)";
      throw error;
    },
  });

  await assert.rejects(
    picker({ mode: "existing" }),
    (error) => {
      assert.equal(error.code, "PROJECT_WORK_PICKER_CANCELLED");
      assert.equal(error.status, 409);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});
