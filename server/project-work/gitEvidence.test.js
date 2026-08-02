import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectGitEvidence,
  parseGitStatusPorcelainV2,
} from "./gitEvidence.js";

test("git evidence separates staged, unstaged, renamed and untracked paths", () => {
  const status = [
    "# branch.oid abcdef123",
    "# branch.head codex/runtime",
    "1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/staged.js",
    "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/unstaged.js",
    "1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/both.js",
    "2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new name.js",
    "src/old name.js",
    "? src/new.js",
    "? .env",
    "",
  ].join("\0");

  assert.deepEqual(parseGitStatusPorcelainV2(status), {
    available: true,
    branch: "codex/runtime",
    head: "abcdef123",
    staged: ["src/both.js", "src/new name.js", "src/staged.js"],
    unstaged: ["src/both.js", "src/unstaged.js"],
    untracked: ["src/new.js"],
    truncated: false,
  });
});

test("git inspector fails closed without exposing command output or project paths", async () => {
  const result = await inspectGitEvidence("/private/project", {
    run: async () => {
      const error = new Error("/private/project is unavailable");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.deepEqual(result, {
    available: false,
    branch: null,
    head: null,
    staged: [],
    unstaged: [],
    untracked: [],
    truncated: false,
    reason: "git_unavailable",
  });
});
