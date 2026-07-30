import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  CODEX_ACCOUNT_MODEL_ID,
  CODEX_PROVIDER_ID,
  CODEX_SPARK_MODEL_ID,
  codexReasoningEffortFromThinking,
  isAllowedCodexModel,
  probeCodexSubscription,
  runCodexSubscription,
} from "./codexSubscription.js";

function createSpawnMock(steps) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const step = steps[calls.length];
    if (!step) throw new Error("unexpected spawn");

    const child = new EventEmitter();
    const stdinChunks = [];
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdinChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      return true;
    };

    const call = { command, args, options, child, stdinChunks };
    calls.push(call);
    setImmediate(() => {
      if (step.error) {
        child.emit("error", Object.assign(new Error(step.error.message), { code: step.error.code }));
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

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const completedJsonl = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify({ answer: "ok" }) },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4 },
  }),
  "",
].join("\n");

test("exports stable provider and account model ids", () => {
  assert.equal(CODEX_PROVIDER_ID, "codex-subscription");
  assert.equal(CODEX_ACCOUNT_MODEL_ID, "account-default");
  assert.equal(CODEX_SPARK_MODEL_ID, "gpt-5.3-codex-spark");
});

test("allows the account default plus any safe subscription model name, rejecting unsafe ones", () => {
  assert.equal(isAllowedCodexModel("account-default"), true);
  assert.equal(isAllowedCodexModel("gpt-5.3-codex-spark"), true);
  assert.equal(isAllowedCodexModel("gpt-5-codex"), true);
  assert.equal(isAllowedCodexModel("gpt-5.6"), true);
  assert.equal(isAllowedCodexModel(""), false);
  assert.equal(isAllowedCodexModel("bad model"), false);
  assert.equal(isAllowedCodexModel('gpt";rm -rf'), false);
  assert.equal(isAllowedCodexModel(null), false);
});

test("maps Pi thinking levels onto Codex reasoning efforts", () => {
  assert.equal(codexReasoningEffortFromThinking("off"), "low");
  assert.equal(codexReasoningEffortFromThinking("minimal"), "low");
  assert.equal(codexReasoningEffortFromThinking("low"), "low");
  assert.equal(codexReasoningEffortFromThinking("medium"), "medium");
  assert.equal(codexReasoningEffortFromThinking("high"), "high");
  assert.equal(codexReasoningEffortFromThinking("xhigh"), "xhigh");
  assert.equal(codexReasoningEffortFromThinking("max"), "xhigh");
  assert.equal(codexReasoningEffortFromThinking("ultra"), "xhigh");
  assert.equal(codexReasoningEffortFromThinking(null), null);
  assert.equal(codexReasoningEffortFromThinking("unknown"), null);
});

test("probe accepts only the exact ChatGPT login status", async () => {
  const readySpawn = createSpawnMock([{ stdout: "Logged in using ChatGPT\n" }]);
  const ready = await probeCodexSubscription({ env: {}, spawnImpl: readySpawn });
  assert.deepEqual(ready, {
    available: true,
    status: "ready",
    reasonCode: "CHATGPT_SUBSCRIPTION",
  });
  assert.deepEqual(readySpawn.calls[0].args, ["login", "status"]);
  assert.equal(readySpawn.calls[0].options.shell, false);

  const apiKeySpawn = createSpawnMock([{ stdout: "Logged in using an API key\n" }]);
  const apiKey = await probeCodexSubscription({ env: {}, spawnImpl: apiKeySpawn });
  assert.deepEqual(apiKey, {
    available: false,
    status: "unavailable",
    reasonCode: "CODEX_AUTH_NOT_CHATGPT",
  });

  const extraOutputSpawn = createSpawnMock([{ stdout: "Logged in using ChatGPT\nextra" }]);
  const extraOutput = await probeCodexSubscription({ env: {}, spawnImpl: extraOutputSpawn });
  assert.equal(extraOutput.available, false);
  assert.equal(extraOutput.reasonCode, "CODEX_AUTH_NOT_CHATGPT");
});

test("probe accepts the exact ChatGPT status when the CLI writes it to stderr", async () => {
  const spawnImpl = createSpawnMock([{ stdout: "", stderr: "Logged in using ChatGPT\n" }]);
  const status = await probeCodexSubscription({ env: {}, spawnImpl });
  assert.equal(status.available, true);
  assert.equal(status.reasonCode, "CHATGPT_SUBSCRIPTION");
});

test("probe ignores only the known PATH aliases warning", async () => {
  const warning = "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)";
  const readySpawn = createSpawnMock([{
    stderr: `${warning}\nLogged in using ChatGPT\n`,
  }]);
  const ready = await probeCodexSubscription({ env: {}, spawnImpl: readySpawn });
  assert.deepEqual(ready, {
    available: true,
    status: "ready",
    reasonCode: "CHATGPT_SUBSCRIPTION",
  });

  const apiKeySpawn = createSpawnMock([{
    stderr: `${warning}\nLogged in using an API key\n`,
  }]);
  const apiKey = await probeCodexSubscription({ env: {}, spawnImpl: apiKeySpawn });
  assert.equal(apiKey.available, false);
  assert.equal(apiKey.reasonCode, "CODEX_AUTH_NOT_CHATGPT");

  const unknownOutputSpawn = createSpawnMock([{
    stderr: `${warning}\nLogged in using ChatGPT\nunexpected output\n`,
  }]);
  const unknownOutput = await probeCodexSubscription({
    env: {},
    spawnImpl: unknownOutputSpawn,
  });
  assert.equal(unknownOutput.available, false);
  assert.equal(unknownOutput.reasonCode, "CODEX_AUTH_NOT_CHATGPT");
});

test("probe never passes API keys into the Codex process", async () => {
  const spawnImpl = createSpawnMock([{ stdout: "Logged in using ChatGPT" }]);
  await probeCodexSubscription({
    env: {
      PATH: "/usr/bin",
      HOME: "/tmp/test-home",
      OPENAI_API_KEY: "must-not-pass",
      DEEPSEEK_API_KEY: "must-not-pass",
      CODEX_ACCESS_TOKEN: "must-not-pass",
      PI_CODEX_CLI_PATH: "/Applications/ChatGPT.app/Contents/Resources/codex",
      UNRELATED: "must-not-pass",
    },
    spawnImpl,
  });

  assert.equal(spawnImpl.calls[0].command, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.deepEqual(spawnImpl.calls[0].options.env, {
    HOME: "/tmp/test-home",
    PATH: "/usr/bin",
  });
});

test("run uses a shell-free ephemeral read-only Codex exec and parses JSONL", async () => {
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    { stdout: completedJsonl },
  ]);
  const result = await runCodexSubscription({
    prompt: "Return one answer.",
    schema,
    env: { PATH: "/usr/bin", HOME: "/tmp/test-home", OPENAI_API_KEY: "drop-me" },
    spawnImpl,
    timeoutMs: 1000,
  });

  assert.deepEqual(result, {
    text: JSON.stringify({ answer: "ok" }),
    operationId: "thread-test",
    usage: {
      input_tokens: 20,
      cached_input_tokens: 5,
      output_tokens: 4,
      total_tokens: 24,
    },
  });

  const execCall = spawnImpl.calls[1];
  assert.equal(execCall.command, "codex");
  assert.equal(execCall.options.shell, false);
  assert.deepEqual(execCall.args.slice(0, 10), [
    "-a", "never",
    "exec",
    "--ephemeral",
    "--sandbox", "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--json",
  ]);
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "multi_agent",
    "remote_plugin",
    "plugins",
    "hooks",
    "goals",
    "auth_elicitation",
    "tool_call_mcp_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "image_generation",
    "in_app_browser",
    "workspace_dependencies",
    "skill_search",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "enable_mcp_apps",
    "code_mode_host",
    "chronicle",
    "memories",
    "shell_snapshot",
  ]) {
    const featureIndex = execCall.args.indexOf(feature);
    assert.ok(featureIndex > 0);
    assert.equal(execCall.args[featureIndex - 1], "--disable");
  }
  const webSearchIndex = execCall.args.indexOf("web_search=\"disabled\"");
  assert.ok(webSearchIndex > 0);
  assert.equal(execCall.args[webSearchIndex - 1], "-c");
  const skillInstructionsIndex = execCall.args.indexOf("skills.include_instructions=false");
  assert.ok(skillInstructionsIndex > 0);
  assert.equal(execCall.args[skillInstructionsIndex - 1], "-c");
  const schemaIndex = execCall.args.indexOf("--output-schema");
  const cwdIndex = execCall.args.indexOf("-C");
  assert.ok(schemaIndex > 0);
  assert.ok(cwdIndex > schemaIndex);
  assert.equal(execCall.args.at(-1), "-");
  assert.notEqual(execCall.args[schemaIndex + 1], execCall.args[cwdIndex + 1]);
  assert.equal(Buffer.concat(execCall.stdinChunks).toString("utf8"), "Return one answer.");
  assert.equal("OPENAI_API_KEY" in execCall.options.env, false);

  await assert.rejects(stat(execCall.args[schemaIndex + 1]), { code: "ENOENT" });
  await assert.rejects(stat(execCall.args[cwdIndex + 1]), { code: "ENOENT" });
});

test("run pins an explicit Spark model and reasoning effort without user config", async () => {
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    { stdout: completedJsonl },
  ]);
  await runCodexSubscription({
    prompt: "Translate one batch.",
    schema,
    modelId: "gpt-5.3-codex-spark",
    reasoningEffort: "low",
    env: {},
    spawnImpl,
    timeoutMs: 1000,
  });

  const args = spawnImpl.calls[1].args;
  const modelIndex = args.indexOf("-m");
  const effortIndex = args.indexOf("model_reasoning_effort=\"low\"");
  assert.ok(modelIndex > 0);
  assert.equal(args[modelIndex + 1], "gpt-5.3-codex-spark");
  assert.ok(effortIndex > 0);
  assert.equal(args[effortIndex - 1], "-c");
  assert.ok(modelIndex < args.indexOf("exec"));
  assert.ok(effortIndex < args.indexOf("exec"));
});

test("run refuses non-ChatGPT login before executing a model turn", async () => {
  const spawnImpl = createSpawnMock([{ stdout: "Logged in using an API key" }]);
  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl }),
    (error) => error.code === "CODEX_AUTH_NOT_CHATGPT" && error.retryable === false,
  );
  assert.equal(spawnImpl.calls.length, 1);
});

test("run rejects incomplete JSONL lifecycle with a retryable coded error", async () => {
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
      ].join("\n"),
    },
  ]);

  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl }),
    (error) => error.code === "CODEX_OUTPUT_INVALID" && error.retryable === true,
  );
});

test("run rejects failed turns and any attempted tool use", async () => {
  const failedSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
        JSON.stringify({ type: "turn.failed", error: { message: "failed" } }),
      ].join("\n"),
    },
  ]);
  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl: failedSpawn }),
    (error) => error.code === "MODEL_FAILED" && error.retryable === true,
  );

  const toolSpawn = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    {
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
        JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
      ].join("\n"),
    },
  ]);
  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl: toolSpawn }),
    (error) => error.code === "CODEX_TOOL_USE_REJECTED" && error.retryable === false,
  );
});

test("non-zero Codex exits never expose stderr or local paths", async () => {
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    {
      stderr: "failed to load /Users/private/project/SKILL.md\nupstream detail",
      exitCode: 1,
    },
  ]);
  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl }),
    (error) => (
      error.code === "MODEL_FAILED"
      && error.retryable === true
      && error.message === "Codex 模型执行失败"
      && !error.message.includes("/Users/")
    ),
  );
});

test("run tolerates non-fatal CLI warning items when the turn still completes", async () => {
  const events = completedJsonl.trim().split("\n").map((line) => JSON.parse(line));
  events.splice(1, 0, {
    type: "item.completed",
    item: { type: "error", message: "non-fatal local warning" },
  });
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT\n" },
    { stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` },
  ]);
  const result = await runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl });
  assert.equal(result.operationId, "thread-test");
});

test("run caps child output and returns a coded non-retryable error", async () => {
  const spawnImpl = createSpawnMock([
    { stdout: "Logged in using ChatGPT" },
    { stdout: "x".repeat(1024 * 1024 + 1) },
  ]);
  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema, env: {}, spawnImpl }),
    (error) => error.code === "CODEX_OUTPUT_LIMIT_EXCEEDED" && error.retryable === false,
  );
  assert.deepEqual(spawnImpl.calls[1].child.killSignals, ["SIGKILL"]);
});

test("run reports unserializable schemas as a coded request error", async () => {
  const circularSchema = {};
  circularSchema.self = circularSchema;
  await assert.rejects(
    runCodexSubscription({ prompt: "test", schema: circularSchema, env: {}, spawnImpl: () => {} }),
    (error) => error.code === "CODEX_INVALID_REQUEST" && error.retryable === false,
  );
});

test("probe kills a hung status command on timeout", async () => {
  const spawnImpl = createSpawnMock([{ hang: true }]);
  const result = await probeCodexSubscription({ env: {}, spawnImpl, timeoutMs: 5 });
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, "CODEX_STATUS_TIMEOUT");
  assert.deepEqual(spawnImpl.calls[0].child.killSignals, ["SIGKILL"]);
});
