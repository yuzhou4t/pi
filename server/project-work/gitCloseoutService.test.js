import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createGitCloseoutBinding,
  createGitCloseoutService,
} from "./gitCloseoutService.js";

const execFileAsync = promisify(execFile);

function contentHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sequentialId(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function git(root, ...args) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, ...args],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return stdout;
}

async function createRepository(t, prefix = "pi-git-closeout-") {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const projectRoot = path.join(temporaryRoot, "project");
  const storageRoot = path.join(temporaryRoot, "storage");
  await execFileAsync("mkdir", [projectRoot]);
  await git(projectRoot, "init", "-b", "main");
  await git(projectRoot, "config", "user.name", "Pi Agent Test");
  await git(projectRoot, "config", "user.email", "pi-agent@example.invalid");
  await writeFile(path.join(projectRoot, "task.txt"), "initial task\n", "utf8");
  await writeFile(path.join(projectRoot, "other.txt"), "initial other\n", "utf8");
  await git(projectRoot, "add", "--", "task.txt", "other.txt");
  await git(projectRoot, "commit", "-m", "initial");
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  return { projectRoot, storageRoot };
}

function passedVerification(id = "verification-run-1") {
  return {
    id,
    commandId: "verification-1",
    status: "passed",
    exitCode: 0,
    changeSetId: "changes-1",
    changeSetHash: `sha256:${"c".repeat(64)}`,
    commandBindingHash: "sha256:command",
    completedAt: "2026-07-30T08:00:00.000Z",
  };
}

function closeoutOwnership(overrides = {}) {
  return {
    conversationId: "conversation-1",
    turnId: "turn-1",
    changeSetId: "changes-1",
    changeSetHash: `sha256:${"c".repeat(64)}`,
    baseFiles: [{
      path: "task.txt",
      baseExists: true,
      baseHash: contentHash("initial task\n"),
      baseMode: 0o644,
    }],
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test("Git closeout creates one exact local commit and leaves excluded work unstaged", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  const oldHead = (await git(projectRoot, "rev-parse", "HEAD")).trim();
  await writeFile(path.join(projectRoot, "task.txt"), "completed task\n", "utf8");
  await writeFile(path.join(projectRoot, "other.txt"), "unrelated work\n", "utf8");
  const service = createGitCloseoutService({
    storageRoot,
    idFactory: sequentialId("commit"),
  });

  const proposal = await service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: complete exact task",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  });

  assert.equal(proposal.status, "ready");
  assert.equal(proposal.branch, "main");
  assert.equal(proposal.head, oldHead);
  assert.match(proposal.proposalHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    proposal.files.map(({ path: filePath, exists }) => ({ filePath, exists })),
    [{ filePath: "task.txt", exists: true }],
  );
  assert.equal(proposal.verificationEvidence[0].id, "verification-run-1");
  assert.equal(proposal.files[0].baseHash, contentHash("initial task\n"));
  assert.equal(proposal.files[0].baseMode, 0o644);

  const committed = await service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
  });

  assert.equal(committed.status, "committed");
  assert.notEqual(committed.commitHash, oldHead);
  assert.equal(
    (await git(projectRoot, "show", "-s", "--format=%s", "HEAD")).trim(),
    "fix: complete exact task",
  );
  assert.deepEqual(
    (await git(
      projectRoot,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "HEAD",
    )).split("\0").filter(Boolean),
    ["task.txt"],
  );
  assert.equal(
    await git(projectRoot, "status", "--short"),
    " M other.txt\n",
  );
  assert.equal((await service.listGitCloseouts({
    projectRoot,
    conversationId: "conversation-1",
  })).length, 1);
});

test("Git closeout rejects user edits that already existed before the Pi snapshot", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  const userBase = "user edit before Pi\n";
  await writeFile(path.join(projectRoot, "task.txt"), userBase, "utf8");
  await writeFile(
    path.join(projectRoot, "task.txt"),
    `${userBase}Pi edit\n`,
    "utf8",
  );
  const service = createGitCloseoutService({ storageRoot });

  await expectCode(service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership({
      baseFiles: [{
        path: "task.txt",
        baseExists: true,
        baseHash: contentHash(userBase),
        baseMode: 0o644,
      }],
    }),
    commitMessage: "fix: do not include prior user work",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  }), "GIT_CLOSEOUT_BASE_NOT_HEAD");

  assert.equal(await git(projectRoot, "diff", "--cached", "--name-only"), "");
  assert.equal((await service.listGitCloseouts({
    projectRoot,
    conversationId: "conversation-1",
  })).length, 0);
});

test("Git closeout rejects a pre-snapshot executable-mode change", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await chmod(path.join(projectRoot, "task.txt"), 0o755);
  await writeFile(path.join(projectRoot, "task.txt"), "Pi edit after chmod\n", "utf8");
  const service = createGitCloseoutService({ storageRoot });

  await expectCode(service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership({
      baseFiles: [{
        path: "task.txt",
        baseExists: true,
        baseHash: contentHash("initial task\n"),
        baseMode: 0o755,
      }],
    }),
    commitMessage: "fix: do not include prior mode change",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  }), "GIT_CLOSEOUT_BASE_NOT_HEAD");
});

test("Git closeout binds a Pi-created file to its prior nonexistence", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await writeFile(path.join(projectRoot, "new.txt"), "created by Pi\n", "utf8");
  const service = createGitCloseoutService({ storageRoot });
  const proposal = await service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership({
      baseFiles: [{
        path: "new.txt",
        baseExists: false,
        baseHash: null,
        baseMode: null,
      }],
    }),
    commitMessage: "feat: add exact file",
    paths: ["new.txt"],
    verificationEvidence: [passedVerification()],
  });

  assert.equal(proposal.files[0].baseExists, false);
  assert.equal(proposal.files[0].baseHash, null);
  const committed = await service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
  });
  assert.equal(committed.status, "committed");
  assert.equal(
    await git(projectRoot, "show", "HEAD:new.txt"),
    "created by Pi\n",
  );
});

test("Git closeout rejects a file that was already untracked at Pi snapshot time", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  const userBase = "untracked user file\n";
  await writeFile(path.join(projectRoot, "new.txt"), userBase, "utf8");
  await writeFile(path.join(projectRoot, "new.txt"), `${userBase}Pi edit\n`, "utf8");
  const service = createGitCloseoutService({ storageRoot });

  await expectCode(service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership({
      baseFiles: [{
        path: "new.txt",
        baseExists: true,
        baseHash: contentHash(userBase),
        baseMode: 0o644,
      }],
    }),
    commitMessage: "fix: do not claim user file",
    paths: ["new.txt"],
    verificationEvidence: [passedVerification()],
  }), "GIT_CLOSEOUT_BASE_NOT_HEAD");
});

test("Git closeout records stay bound to their conversation, turn, and change set", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await writeFile(path.join(projectRoot, "task.txt"), "scoped work\n", "utf8");
  const service = createGitCloseoutService({
    storageRoot,
    idFactory: sequentialId("scope"),
  });
  const proposal = await service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: scoped task",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  });

  assert.deepEqual(
    await service.listGitCloseouts({
      projectRoot,
      conversationId: "conversation-2",
    }),
    [],
  );
  await expectCode(service.getGitCloseout({
    projectRoot,
    proposalId: proposal.id,
    conversationId: "conversation-2",
  }), "GIT_CLOSEOUT_PROPOSAL_NOT_FOUND");
  await expectCode(service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
    conversationId: "conversation-2",
  }), "GIT_CLOSEOUT_BINDING_MISMATCH");
  await expectCode(service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
    turnId: "turn-2",
  }), "GIT_CLOSEOUT_BINDING_MISMATCH");
  await expectCode(service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
    changeSetHash: `sha256:${"d".repeat(64)}`,
  }), "GIT_CLOSEOUT_BINDING_MISMATCH");
  await expectCode(service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
    files: createGitCloseoutBinding(proposal).files.map((file) => ({
      ...file,
      baseHash: `sha256:${"d".repeat(64)}`,
    })),
  }), "GIT_CLOSEOUT_BINDING_MISMATCH");

  assert.equal(
    (await service.getGitCloseout({
      projectRoot,
      proposalId: proposal.id,
      conversationId: "conversation-1",
    })).status,
    "ready",
  );
});

test("Git closeout blocks a repository with existing staged work", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await writeFile(path.join(projectRoot, "other.txt"), "already staged\n", "utf8");
  await git(projectRoot, "add", "--", "other.txt");
  await writeFile(path.join(projectRoot, "task.txt"), "task work\n", "utf8");
  const service = createGitCloseoutService({ storageRoot });

  await expectCode(service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: task",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  }), "GIT_CLOSEOUT_EXISTING_STAGED_CHANGES");

  assert.equal(
    await git(projectRoot, "diff", "--cached", "--name-only"),
    "other.txt\n",
  );
});

test("Git closeout blocks mixed staged and unstaged files", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await writeFile(path.join(projectRoot, "task.txt"), "staged half\n", "utf8");
  await git(projectRoot, "add", "--", "task.txt");
  await writeFile(path.join(projectRoot, "task.txt"), "unstaged half\n", "utf8");
  const service = createGitCloseoutService({ storageRoot });

  await expectCode(service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: mixed task",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  }), "GIT_CLOSEOUT_MIXED_FILE");
});

test("Git closeout blocks unresolved conflicts", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await git(projectRoot, "checkout", "-b", "feature");
  await writeFile(path.join(projectRoot, "task.txt"), "feature\n", "utf8");
  await git(projectRoot, "add", "--", "task.txt");
  await git(projectRoot, "commit", "-m", "feature");
  await git(projectRoot, "checkout", "main");
  await writeFile(path.join(projectRoot, "task.txt"), "main\n", "utf8");
  await git(projectRoot, "add", "--", "task.txt");
  await git(projectRoot, "commit", "-m", "main");
  await assert.rejects(
    git(projectRoot, "merge", "feature"),
  );
  const service = createGitCloseoutService({ storageRoot });

  await expectCode(service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: resolve later",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  }), "GIT_CLOSEOUT_CONFLICT");
});

test("Git closeout rejects a confirmation after HEAD changes", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await writeFile(path.join(projectRoot, "task.txt"), "task work\n", "utf8");
  const service = createGitCloseoutService({
    storageRoot,
    idFactory: sequentialId("stale"),
  });
  const proposal = await service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: stale task",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  });

  await writeFile(path.join(projectRoot, "other.txt"), "independent commit\n", "utf8");
  await git(projectRoot, "add", "--", "other.txt");
  await git(projectRoot, "commit", "-m", "independent");

  await expectCode(service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
  }), "GIT_CLOSEOUT_HEAD_STALE");
  assert.equal(
    (await service.getGitCloseout({
      projectRoot,
      proposalId: proposal.id,
      conversationId: "conversation-1",
    })).status,
    "stale",
  );
});

test("Git closeout rolls back its exact index changes when commit creation fails", async (t) => {
  const { projectRoot, storageRoot } = await createRepository(t);
  await writeFile(path.join(projectRoot, "task.txt"), "task work\n", "utf8");
  const oldHead = (await git(projectRoot, "rev-parse", "HEAD")).trim();
  const service = createGitCloseoutService({
    storageRoot,
    idFactory: sequentialId("failure"),
    run: async (file, args, options) => {
      if (args.includes("commit-tree")) {
        throw new Error("simulated commit-tree failure");
      }
      return execFileAsync(file, args, options);
    },
  });
  const proposal = await service.requestGitCloseout({
    projectRoot,
    ...closeoutOwnership(),
    commitMessage: "fix: cannot commit",
    paths: ["task.txt"],
    verificationEvidence: [passedVerification()],
  });

  await expectCode(service.confirmGitCloseout({
    projectRoot,
    ...createGitCloseoutBinding(proposal),
  }), "GIT_CLOSEOUT_COMMIT_FAILED");
  assert.equal((await git(projectRoot, "rev-parse", "HEAD")).trim(), oldHead);
  assert.equal(await git(projectRoot, "diff", "--cached", "--name-only"), "");
  assert.equal(await git(projectRoot, "diff", "--name-only"), "task.txt\n");
  assert.equal(
    (await service.getGitCloseout({
      projectRoot,
      proposalId: proposal.id,
      conversationId: "conversation-1",
    })).status,
    "failed",
  );
});

test("Git closeout recovers both pre-ref and post-ref crashes", async (t) => {
  await t.test("a crash after staging rolls the index back", async (t) => {
    const { projectRoot, storageRoot } = await createRepository(
      t,
      "pi-git-closeout-staged-crash-",
    );
    await writeFile(path.join(projectRoot, "task.txt"), "task work\n", "utf8");
    const oldHead = (await git(projectRoot, "rev-parse", "HEAD")).trim();
    const crashing = createGitCloseoutService({
      storageRoot,
      idFactory: sequentialId("staged-crash"),
      checkpoint: async (phase) => {
        if (phase !== "staged") return;
        const error = new Error("simulated process crash");
        error.simulatedCrash = true;
        throw error;
      },
    });
    const proposal = await crashing.requestGitCloseout({
      projectRoot,
      ...closeoutOwnership(),
      commitMessage: "fix: interrupted before commit",
      paths: ["task.txt"],
      verificationEvidence: [passedVerification()],
    });

    await assert.rejects(crashing.confirmGitCloseout({
      projectRoot,
      ...createGitCloseoutBinding(proposal),
    }), /simulated process crash/u);
    assert.equal(await git(projectRoot, "diff", "--cached", "--name-only"), "task.txt\n");

    const restarted = createGitCloseoutService({ storageRoot });
    const [recovered] = await restarted.recoverGitCloseouts({
      projectRoot,
      conversationId: "conversation-1",
    });
    assert.equal(recovered.status, "rolled_back");
    assert.equal((await git(projectRoot, "rev-parse", "HEAD")).trim(), oldHead);
    assert.equal(await git(projectRoot, "diff", "--cached", "--name-only"), "");
    assert.equal(await git(projectRoot, "diff", "--name-only"), "task.txt\n");
  });

  await t.test("a crash after the ref update finalizes the durable commit", async (t) => {
    const { projectRoot, storageRoot } = await createRepository(
      t,
      "pi-git-closeout-ref-crash-",
    );
    await writeFile(path.join(projectRoot, "task.txt"), "task work\n", "utf8");
    const oldHead = (await git(projectRoot, "rev-parse", "HEAD")).trim();
    const crashing = createGitCloseoutService({
      storageRoot,
      idFactory: sequentialId("ref-crash"),
      checkpoint: async (phase) => {
        if (phase !== "ref_updated") return;
        const error = new Error("simulated process crash");
        error.simulatedCrash = true;
        throw error;
      },
    });
    const proposal = await crashing.requestGitCloseout({
      projectRoot,
      ...closeoutOwnership(),
      commitMessage: "fix: interrupted after ref",
      paths: ["task.txt"],
      verificationEvidence: [passedVerification()],
    });

    await assert.rejects(crashing.confirmGitCloseout({
      projectRoot,
      ...createGitCloseoutBinding(proposal),
    }), /simulated process crash/u);
    assert.notEqual((await git(projectRoot, "rev-parse", "HEAD")).trim(), oldHead);

    const restarted = createGitCloseoutService({ storageRoot });
    const [recovered] = await restarted.recoverGitCloseouts({
      projectRoot,
      conversationId: "conversation-1",
    });
    assert.equal(recovered.status, "committed");
    assert.equal(recovered.commitHash, (await git(projectRoot, "rev-parse", "HEAD")).trim());
    assert.equal(await git(projectRoot, "status", "--short"), "");
  });
});
