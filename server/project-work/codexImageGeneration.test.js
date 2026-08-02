import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CODEX_IMAGE_MODEL_ID,
  CODEX_IMAGE_PROVIDER_ID,
  generateCodexSubscriptionImage,
  probeCodexImageGeneration,
} from "./codexImageGeneration.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1EAAAAASUVORK5CYII=",
  "base64",
);

function createSpawnMock(steps) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const step = steps[calls.length];
    if (!step) throw new Error("unexpected spawn");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      return true;
    };
    const call = { command, args, options, child };
    calls.push(call);
    step.onSpawn?.(call);
    setImmediate(() => {
      if (step.error) {
        child.emit(
          "error",
          Object.assign(new Error(step.error.message), {
            code: step.error.code,
          }),
        );
        return;
      }
      if (step.hang) return;
      if (step.stdout) child.stdout.write(step.stdout);
      if (step.stderr) child.stderr.write(step.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", step.exitCode ?? 0, step.signal ?? null);
    });
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

function completedJsonl({ operationId, sourcePath, usage } = {}) {
  return [
    JSON.stringify({
      type: "thread.started",
      thread_id: operationId,
    }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `Succeeded — \`${sourcePath}\``,
      },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: usage ?? {
        input_tokens: 350,
        cached_input_tokens: 120,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    }),
    "",
  ].join("\n");
}

async function createFixture(t, {
  sourceBytes = PNG_1X1,
  operationId = "019fa96b-718d-70d1-b295-3b53701e1112",
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-codex-image-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generatedImagesRoot = path.join(root, "generated_images");
  const operationDirectory = path.join(generatedImagesRoot, operationId);
  const sourcePath = path.join(operationDirectory, "call_test.png");
  await mkdir(operationDirectory, { recursive: true });
  await writeFile(sourcePath, sourceBytes);
  return {
    root,
    generatedImagesRoot,
    operationId,
    sourcePath,
    artifactDirectory: path.join(root, "artifacts"),
  };
}

test("generates one isolated image, validates it, and atomically stores safe metadata", async (t) => {
  const fixture = await createFixture(t);
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: completedJsonl({
        operationId: fixture.operationId,
        sourcePath: fixture.sourcePath,
      }),
    },
  ]);
  const result = await generateCodexSubscriptionImage({
    prompt: "A matte teal sphere on a warm ivory background.",
    requestId: "image-request-1",
    artifactDirectory: fixture.artifactDirectory,
    generatedImagesRoot: fixture.generatedImagesRoot,
    temporaryRoot: fixture.root,
    cliPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    env: {
      HOME: "/tmp/codex-home",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "must-not-pass",
      CODEX_ACCESS_TOKEN: "must-not-pass",
    },
    spawnImpl,
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, {
    providerId: CODEX_IMAGE_PROVIDER_ID,
    modelId: CODEX_IMAGE_MODEL_ID,
    operationId: fixture.operationId,
    billingMode: "subscription",
    pricingStatus: "unpriced",
    usage: {
      input_tokens: 350,
      cached_input_tokens: 120,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 370,
      image_generations: 1,
    },
    artifact: {
      id: "image-request-1",
      fileName: "image-request-1.png",
      mimeType: "image/png",
      byteLength: PNG_1X1.length,
      width: 1,
      height: 1,
      sha256: `sha256:${createHash("sha256").update(PNG_1X1).digest("hex")}`,
      requestedSize: "1024x1024",
      requestedQuality: "low",
    },
  });
  assert.deepEqual(
    await readFile(path.join(fixture.artifactDirectory, "image-request-1.png")),
    PNG_1X1,
  );
  assert.equal(JSON.stringify(result).includes(fixture.sourcePath), false);

  assert.equal(spawnImpl.calls.length, 2);
  assert.equal(
    spawnImpl.calls[0].command,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  );
  assert.deepEqual(spawnImpl.calls[0].args, ["login", "status"]);
  assert.equal(spawnImpl.calls[0].options.shell, false);
  assert.deepEqual(spawnImpl.calls[0].options.env, {
    HOME: "/tmp/codex-home",
    PATH: "/usr/bin",
  });

  const execCall = spawnImpl.calls[1];
  assert.equal(execCall.options.shell, false);
  assert.deepEqual(execCall.args.slice(0, 9), [
    "-a",
    "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
  ]);
  assert.equal(execCall.args[9], "workspace-write");
  const enableIndex = execCall.args.indexOf("image_generation");
  assert.ok(enableIndex > 0);
  assert.equal(execCall.args[enableIndex - 1], "--enable");
  assert.equal(
    execCall.args.some((value, index) => (
      value === "image_generation"
      && execCall.args[index - 1] === "--disable"
    )),
    false,
  );
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "browser_use",
    "computer_use",
    "multi_agent",
    "plugins",
    "skill_search",
    "workspace_dependencies",
  ]) {
    const index = execCall.args.indexOf(feature);
    assert.ok(index > 0);
    assert.equal(execCall.args[index - 1], "--disable");
  }
  for (const config of [
    "web_search=\"disabled\"",
    "skills.include_instructions=false",
    "model_reasoning_effort=\"low\"",
  ]) {
    const index = execCall.args.indexOf(config);
    assert.ok(index > 0);
    assert.equal(execCall.args[index - 1], "-c");
  }
  assert.match(execCall.args.at(-1), /image generation tool exactly once/i);
  assert.match(execCall.args.at(-1), /matte teal sphere/i);
  const workDirectory = execCall.args[execCall.args.indexOf("-C") + 1];
  assert.equal(execCall.options.cwd, workDirectory);
  await assert.rejects(stat(workDirectory), { code: "ENOENT" });
});

test("probe accepts only an exact ChatGPT subscription login", async () => {
  const warning = "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)";
  const readySpawn = createSpawnMock([{
    stderr: `${warning}\nLogged in using ChatGPT\n`,
  }]);
  const ready = await probeCodexImageGeneration({
    env: {},
    cliPath: "codex-test",
    spawnImpl: readySpawn,
  });
  assert.deepEqual(ready, {
    available: true,
    status: "ready",
    reasonCode: "CHATGPT_SUBSCRIPTION",
  });

  const apiKeySpawn = createSpawnMock([{
    stdout: "Logged in using an API key\n",
  }]);
  const unavailable = await probeCodexImageGeneration({
    env: {},
    spawnImpl: apiKeySpawn,
  });
  assert.deepEqual(unavailable, {
    available: false,
    status: "unavailable",
    reasonCode: "CODEX_AUTH_NOT_CHATGPT",
  });
});

test("generation refuses non-ChatGPT auth before starting a model turn", async (t) => {
  const fixture = await createFixture(t);
  const spawnImpl = createSpawnMock([{
    stdout: "Logged in using an API key\n",
  }]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: fixture.artifactDirectory,
      generatedImagesRoot: fixture.generatedImagesRoot,
      temporaryRoot: fixture.root,
      env: {},
      spawnImpl,
    }),
    (error) => (
      error.code === "CODEX_AUTH_NOT_CHATGPT"
      && error.retryable === false
    ),
  );
  assert.equal(spawnImpl.calls.length, 1);
});

test("generation rejects source paths outside the operation-owned image directory", async (t) => {
  const fixture = await createFixture(t);
  const outsidePath = path.join(fixture.root, "outside.png");
  await writeFile(outsidePath, PNG_1X1);
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: completedJsonl({
        operationId: fixture.operationId,
        sourcePath: outsidePath,
      }),
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: fixture.artifactDirectory,
      generatedImagesRoot: fixture.generatedImagesRoot,
      temporaryRoot: fixture.root,
      env: {},
      spawnImpl,
    }),
    (error) => (
      error.code === "CODEX_IMAGE_SOURCE_REJECTED"
      && error.retryable === false
    ),
  );
});

test("generation rejects symlink sources and malformed PNG bytes", async (t) => {
  const symlinkFixture = await createFixture(t);
  const outsidePath = path.join(symlinkFixture.root, "outside.png");
  await writeFile(outsidePath, PNG_1X1);
  await rm(symlinkFixture.sourcePath);
  await symlink(outsidePath, symlinkFixture.sourcePath);
  const symlinkSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: completedJsonl({
        operationId: symlinkFixture.operationId,
        sourcePath: symlinkFixture.sourcePath,
      }),
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: symlinkFixture.artifactDirectory,
      generatedImagesRoot: symlinkFixture.generatedImagesRoot,
      temporaryRoot: symlinkFixture.root,
      env: {},
      spawnImpl: symlinkSpawn,
    }),
    (error) => error.code === "CODEX_IMAGE_SOURCE_REJECTED",
  );

  const malformedFixture = await createFixture(t, {
    sourceBytes: Buffer.from("not-a-png"),
    operationId: "019fa96b-718d-70d1-b295-3b53701e2223",
  });
  const malformedSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: completedJsonl({
        operationId: malformedFixture.operationId,
        sourcePath: malformedFixture.sourcePath,
      }),
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: malformedFixture.artifactDirectory,
      generatedImagesRoot: malformedFixture.generatedImagesRoot,
      temporaryRoot: malformedFixture.root,
      env: {},
      spawnImpl: malformedSpawn,
    }),
    (error) => error.code === "CODEX_IMAGE_INVALID",
  );
});

test("generation fails closed on unexpected tool events and incomplete usage", async (t) => {
  const fixture = await createFixture(t);
  const toolSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: fixture.operationId,
        }),
        JSON.stringify({
          type: "item.started",
          item: { type: "command_execution" },
        }),
      ].join("\n"),
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: fixture.artifactDirectory,
      generatedImagesRoot: fixture.generatedImagesRoot,
      temporaryRoot: fixture.root,
      env: {},
      spawnImpl: toolSpawn,
    }),
    (error) => (
      error.code === "CODEX_IMAGE_TOOL_USE_REJECTED"
      && error.retryable === false
    ),
  );

  const invalidUsageSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: completedJsonl({
        operationId: fixture.operationId,
        sourcePath: fixture.sourcePath,
        usage: {
          input_tokens: -1,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
      }),
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: fixture.artifactDirectory,
      generatedImagesRoot: fixture.generatedImagesRoot,
      temporaryRoot: fixture.root,
      env: {},
      spawnImpl: invalidUsageSpawn,
    }),
    (error) => error.code === "CODEX_IMAGE_OUTPUT_INVALID",
  );

  for (const usage of [
    {},
    {
      input_tokens: 10,
      cached_input_tokens: 11,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
    {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 2,
    },
  ]) {
    const inconsistentUsageSpawn = createSpawnMock([
      { stdout: "Logged in using ChatGPT\n" },
      {
        stdout: completedJsonl({
          operationId: fixture.operationId,
          sourcePath: fixture.sourcePath,
          usage,
        }),
      },
    ]);
    await assert.rejects(
      generateCodexSubscriptionImage({
        prompt: "A simple circle.",
        artifactDirectory: fixture.artifactDirectory,
        generatedImagesRoot: fixture.generatedImagesRoot,
        temporaryRoot: fixture.root,
        env: {},
        spawnImpl: inconsistentUsageSpawn,
      }),
      (error) => error.code === "CODEX_IMAGE_OUTPUT_INVALID",
    );
  }

  const errorItemSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: [
        JSON.stringify({
          type: "thread.started",
          thread_id: fixture.operationId,
        }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "error", message: "image tool failed" },
        }),
      ].join("\n"),
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: fixture.artifactDirectory,
      generatedImagesRoot: fixture.generatedImagesRoot,
      temporaryRoot: fixture.root,
      env: {},
      spawnImpl: errorItemSpawn,
    }),
    (error) => error.code === "CODEX_IMAGE_MODEL_FAILED",
  );
});

test("generation honors timeout and AbortSignal by killing the Codex child", async (t) => {
  const timeoutFixture = await createFixture(t);
  const timeoutSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    { hang: true },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: timeoutFixture.artifactDirectory,
      generatedImagesRoot: timeoutFixture.generatedImagesRoot,
      temporaryRoot: timeoutFixture.root,
      env: {},
      spawnImpl: timeoutSpawn,
      timeoutMs: 15,
    }),
    (error) => (
      error.code === "CODEX_IMAGE_TIMEOUT"
      && error.retryable === true
    ),
  );
  assert.deepEqual(timeoutSpawn.calls[1].child.killSignals, ["SIGKILL"]);

  const abortFixture = await createFixture(t, {
    operationId: "019fa96b-718d-70d1-b295-3b53701e3334",
  });
  const controller = new AbortController();
  const abortSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      hang: true,
      onSpawn() {
        setImmediate(() => controller.abort());
      },
    },
  ]);
  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      artifactDirectory: abortFixture.artifactDirectory,
      generatedImagesRoot: abortFixture.generatedImagesRoot,
      temporaryRoot: abortFixture.root,
      env: {},
      spawnImpl: abortSpawn,
      signal: controller.signal,
      timeoutMs: 1_000,
    }),
    (error) => (
      error.code === "CODEX_IMAGE_ABORTED"
      && error.retryable === false
    ),
  );
  assert.deepEqual(abortSpawn.calls[1].child.killSignals, ["SIGKILL"]);
});

test("atomic artifact creation never overwrites an existing request", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.artifactDirectory, { recursive: true });
  const destination = path.join(fixture.artifactDirectory, "stable-request.png");
  await writeFile(destination, "existing");
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    {
      stdout: completedJsonl({
        operationId: fixture.operationId,
        sourcePath: fixture.sourcePath,
      }),
    },
  ]);

  await assert.rejects(
    generateCodexSubscriptionImage({
      prompt: "A simple circle.",
      requestId: "stable-request",
      artifactDirectory: fixture.artifactDirectory,
      generatedImagesRoot: fixture.generatedImagesRoot,
      temporaryRoot: fixture.root,
      env: {},
      spawnImpl,
    }),
    (error) => (
      error.code === "CODEX_IMAGE_ARTIFACT_EXISTS"
      && error.retryable === false
    ),
  );
  assert.equal(await readFile(destination, "utf8"), "existing");
});
