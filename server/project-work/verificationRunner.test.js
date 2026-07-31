import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createVerificationRunner,
  macOSVerificationSandboxProfile,
} from "./verificationRunner.js";

function fakeChild({ onKill } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    onKill?.(signal, child);
    return true;
  };
  return child;
}

test("verification runner captures a successful bounded command without a shell", async () => {
  const calls = [];
  let clock = 100;
  const runner = createVerificationRunner({
    now: () => {
      clock += 5;
      return clock;
    },
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end("all checks passed\n");
        child.stderr.end("");
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    workspaceRoot: "/tmp/safe-workspace",
    cwd: "/tmp/safe-workspace/packages/app",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.stdout, "all checks passed\n");
  assert.equal(result.durationMs, 5);
  assert.equal(result.isolation, "pi-agent-verification.v1");
  assert.equal(calls[0].file, "/usr/bin/sandbox-exec");
  assert.equal(calls[0].args[0], "-p");
  assert.match(calls[0].args[1], /\(deny network\*\)/);
  assert.match(
    calls[0].args[1],
    /\(allow file-write\* \(subpath "\/tmp\/safe-workspace"\)/,
  );
  assert.deepEqual(calls[0].args.slice(2), ["node", "--test"]);
  assert.equal(calls[0].options.cwd, "/tmp/safe-workspace/packages/app");
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(calls[0].options.env.CI, "1");
  assert.equal(
    calls[0].options.env.TMPDIR,
    "/tmp/safe-workspace/.pi-verification-tmp",
  );
});

test("verification runner ignores arbitrary user PATH roots and scopes known user toolchains", async () => {
  const calls = [];
  const runner = createVerificationRunner({
    platform: "darwin",
    baseEnvironment: {
      PATH: [
        "/Users/alice/private-tools/bin",
        "/Users/alice/.nvm/versions/node/v24.14.0/bin",
        "/usr/bin",
      ].join(":"),
      LANG: "en_US.UTF-8",
    },
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });

  await runner({
    file: "node",
    args: ["--test"],
    workspaceRoot: "/private/tmp/pi-run/workspace",
    cwd: "/private/tmp/pi-run/workspace",
    temporaryDirectory: "/private/tmp/pi-run/tmp",
  });

  const profile = calls[0].args[1];
  assert.doesNotMatch(profile, /\/Users\/alice\/private-tools/);
  assert.doesNotMatch(profile, /\(subpath "\/Users\/alice"\)/);
  assert.match(
    profile,
    /\(subpath "\/Users\/alice\/\.nvm\/versions\/node\/v24\.14\.0"\)/,
  );
  assert.doesNotMatch(
    calls[0].options.env.PATH,
    /\/Users\/alice\/private-tools/,
  );
  assert.match(
    calls[0].options.env.PATH,
    /^\/Users\/alice\/\.nvm\/versions\/node\/v24\.14\.0\/bin:/,
  );
});

test("macOS verification sandbox allows writes only in the private workspace and temp root", () => {
  const profile = macOSVerificationSandboxProfile({
    workspaceRoot: "/private/tmp/pi workspace",
    temporaryDirectory: "/private/tmp/pi tmp",
    file: "node",
    pathValue: "/usr/bin:/bin",
  });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny network\*\)/);
  assert.doesNotMatch(profile, /^\(allow file-read\*\)$/m);
  assert.doesNotMatch(profile, /\(allow mach-lookup\)/);
  assert.doesNotMatch(profile, /\(allow ipc-posix\*\)/);
  assert.match(profile, /^\(allow file-read-data \(literal "\/"\)\)$/m);
  assert.doesNotMatch(profile, /\(subpath "\/"\)/);
  assert.match(
    profile,
    /\(allow file-read\*\n  \(subpath "\/private\/tmp\/pi workspace"\)/,
  );
  assert.match(
    profile,
    /\(allow file-write\* \(subpath "\/private\/tmp\/pi workspace"\) \(subpath "\/private\/tmp\/pi tmp"\)\)/,
  );
  assert.doesNotMatch(profile, /\(allow file-write\*\)\s*$/m);
});

test("verification runner rejects a cwd or executable outside the private workspace and toolchains", () => {
  let spawnCalls = 0;
  const runner = createVerificationRunner({
    platform: "darwin",
    baseEnvironment: { PATH: "/Users/alice/private-tools/bin:/usr/bin" },
    spawnImpl: () => {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });
  assert.throws(
    () => runner({
      file: "node",
      args: ["--test"],
      workspaceRoot: "/private/tmp/pi-run/workspace",
      cwd: "/private/tmp/pi-run/other",
      temporaryDirectory: "/private/tmp/pi-run/tmp",
    }),
    { code: "PROJECT_WORK_VERIFICATION_SANDBOX_INVALID" },
  );
  assert.throws(
    () => runner({
      file: "/Users/alice/private-tools/bin/node",
      args: ["--test"],
      workspaceRoot: "/private/tmp/pi-run/workspace",
      cwd: "/private/tmp/pi-run/workspace",
      temporaryDirectory: "/private/tmp/pi-run/tmp",
    }),
    { code: "PROJECT_WORK_VERIFICATION_COMMAND_INVALID" },
  );
  assert.equal(spawnCalls, 0);
});

test("verification runner resolves only the registered project Gradle wrapper", async () => {
  const calls = [];
  const runner = createVerificationRunner({
    platform: "darwin",
    baseEnvironment: { PATH: "/usr/bin:/bin" },
    spawnImpl: (file, args) => {
      calls.push({ file, args });
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });

  await runner({
    file: "./gradlew",
    args: ["--offline", "test"],
    workspaceRoot: "/private/tmp/pi-run/workspace",
    cwd: "/private/tmp/pi-run/workspace/android",
    temporaryDirectory: "/private/tmp/pi-run/tmp",
  });
  assert.equal(calls[0].file, "/usr/bin/sandbox-exec");
  assert.deepEqual(
    calls[0].args.slice(2),
    ["/private/tmp/pi-run/workspace/android/gradlew", "--offline", "test"],
  );

  assert.throws(
    () => runner({
      file: "../gradlew",
      args: ["test"],
      workspaceRoot: "/private/tmp/pi-run/workspace",
      cwd: "/private/tmp/pi-run/workspace/android",
      temporaryDirectory: "/private/tmp/pi-run/tmp",
    }),
    { code: "PROJECT_WORK_VERIFICATION_COMMAND_INVALID" },
  );
});

test("verification runner fails closed when the macOS sandbox is unavailable", () => {
  const runner = createVerificationRunner({
    platform: "linux",
    spawnImpl: () => {
      throw new Error("must not spawn");
    },
  });
  assert.throws(
    () => runner({
      file: "node",
      args: ["--test"],
      workspaceRoot: "/tmp/safe-workspace",
      cwd: "/tmp/safe-workspace",
    }),
    { code: "PROJECT_WORK_VERIFICATION_SANDBOX_UNAVAILABLE" },
  );
});

test("verification runner propagates sandbox startup failure without running a fallback command", async () => {
  const calls = [];
  const runner = createVerificationRunner({
    platform: "darwin",
    baseEnvironment: { PATH: "/usr/bin:/bin" },
    spawnImpl: (file, args) => {
      calls.push({ file, args });
      throw new Error("sandbox-exec unavailable");
    },
  });
  await assert.rejects(
    runner({
      file: "node",
      args: ["--test"],
      workspaceRoot: "/private/tmp/pi-run/workspace",
      cwd: "/private/tmp/pi-run/workspace",
      temporaryDirectory: "/private/tmp/pi-run/tmp",
    }),
    /sandbox-exec unavailable/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/sandbox-exec");
  assert.deepEqual(calls[0].args.slice(2), ["node", "--test"]);
});

test("verification runner accepts only registered offline recipe environment", async () => {
  const calls = [];
  const runner = createVerificationRunner({
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.end("");
        child.stderr.end("");
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  await runner({
    file: "go",
    args: ["test", "./..."],
    workspaceRoot: "/tmp/safe-workspace",
    cwd: "/tmp/safe-workspace",
    environment: {
      GOPROXY: "off",
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
    },
  });
  assert.equal(calls[0].options.env.GOPROXY, "off");
  assert.equal(calls[0].options.env.GOSUMDB, "off");
  assert.equal(calls[0].options.env.GOTOOLCHAIN, "local");

  await assert.rejects(
    runner({
      file: "go",
      args: ["test", "./..."],
      workspaceRoot: "/tmp/safe-workspace",
      cwd: "/tmp/safe-workspace",
      environment: {
        GOPROXY: "https://proxy.example.com",
      },
    }),
    (error) => {
      assert.equal(
        error.code,
        "PROJECT_WORK_VERIFICATION_ENVIRONMENT_BLOCKED",
      );
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("verification runner marks truncation and preserves the final diagnostic excerpt", async () => {
  const runner = createVerificationRunner({
    maxOutputBytes: 160,
    spawnImpl: () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write(`start marker\n${"progress\n".repeat(80)}`);
        child.stdout.end("AssertionError: final failure detail\n");
        child.stderr.end("");
        child.emit("close", 1, null);
      });
      return child;
    },
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    workspaceRoot: "/tmp/safe-workspace",
    cwd: "/tmp/safe-workspace",
  });

  assert.equal(result.truncated, true);
  assert.match(result.stdout, /^start marker/);
  assert.match(result.stdout, /验证输出达到安全采集上限/);
  assert.match(result.stdout, /AssertionError: final failure detail/);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 160);
});

test("verification runner terminates and marks a timed-out child", async () => {
  const signals = [];
  const runner = createVerificationRunner({
    timeoutMs: 5,
    spawnImpl: () => fakeChild({
      onKill: (signal, child) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      },
    }),
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    workspaceRoot: "/tmp/safe-workspace",
    cwd: "/tmp/safe-workspace",
  });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("verification runner honors a signal that was already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const signals = [];
  const runner = createVerificationRunner({
    timeoutMs: 1_000,
    spawnImpl: () => fakeChild({
      onKill: (signal, child) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      },
    }),
  });

  const result = await runner({
    file: "node",
    args: ["--test"],
    workspaceRoot: "/tmp/safe-workspace",
    cwd: "/tmp/safe-workspace",
    signal: controller.signal,
  });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});
