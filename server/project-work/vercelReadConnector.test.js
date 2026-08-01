import assert from "node:assert/strict";
import test from "node:test";
import {
  VERCEL_READ_TOOL_NAMES,
  createVercelCliRunner,
  createVercelReadConnector,
  createVercelReadTools,
  getVercelReadCapability,
  probeVercelReadHealth,
} from "./vercelReadConnector.js";

const TOKEN = "vercel-token-that-must-never-appear";
const JSON_ARGS = ["--format=json", "--non-interactive", "--no-color"];

function createFakeExec(results) {
  const calls = [];
  const queue = [...results];
  const execFileImpl = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    const result = queue.shift() ?? {};
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
  };
  return { calls, execFileImpl };
}

function createQueueRunner(results) {
  const calls = [];
  const queue = [...results];
  return {
    calls,
    runner: {
      async run(args) {
        calls.push([...args]);
        return queue.shift() ?? { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
  };
}

test("Vercel health uses a fixed shell-free keychain contract without ambient token overrides", async () => {
  const fake = createFakeExec([{
    stdout: JSON.stringify({
      username: "private-user",
      email: "private@example.com",
      name: TOKEN,
    }),
  }]);
  const health = await probeVercelReadHealth({
    execFileImpl: fake.execFileImpl,
    binary: "/safe/vercel",
    cwd: "/safe/pi-agent",
    env: {
      VERCEL_TOKEN: TOKEN,
      VERCEL_ACCESS_TOKEN: "ambient-access-token",
      VERCEL_AUTH_TOKEN: "ambient-auth-token",
    },
  });
  assert.deepEqual(health, { available: true, reasonCode: "READY" });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].binary, "/safe/vercel");
  assert.deepEqual(fake.calls[0].args, ["whoami", ...JSON_ARGS]);
  assert.equal(fake.calls[0].options.cwd, "/safe/pi-agent");
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.timeout, 5_000);
  assert.equal(fake.calls[0].options.maxBuffer, 512 * 1024);
  assert.equal(fake.calls[0].options.env.VERCEL_TOKEN, undefined);
  assert.equal(fake.calls[0].options.env.VERCEL_ACCESS_TOKEN, undefined);
  assert.equal(fake.calls[0].options.env.VERCEL_AUTH_TOKEN, undefined);
  assert.equal(fake.calls[0].options.env.NO_UPDATE_NOTIFIER, "1");
  assert.equal(fake.calls[0].options.env.VERCEL_TELEMETRY_DISABLED, "1");

  const capability = getVercelReadCapability({ health });
  assert.deepEqual(capability, {
    id: "vercel_read",
    label: "Vercel 只读",
    available: true,
    enabledForTurn: false,
    defaultEnabled: false,
    activation: "per_turn",
    access: "read_only",
    effects: ["network_read"],
    toolNames: VERCEL_READ_TOOL_NAMES,
    reason: "Vercel CLI 已连接，需逐回合启用",
  });
  assert.doesNotMatch(JSON.stringify({ health, capability }), /private-user|private@example|vercel-token/u);
});

test("Vercel health maps missing, timeout, and malformed CLI results to safe status", async () => {
  const cases = [
    [{ missing: true, exitCode: 1 }, "CLI_MISSING", "本机未找到 Vercel CLI"],
    [{ timedOut: true, exitCode: 1 }, "CLI_TIMEOUT", "Vercel 连接健康检查超时"],
    [{ exitCode: 0, stdout: "not-json" }, "RESPONSE_INVALID", "Vercel CLI 健康检查返回异常"],
    [{ exitCode: 1, stderr: "token and account details" }, "AUTH_OR_UPSTREAM", "Vercel CLI 尚未登录或当前不可用"],
  ];
  for (const [result, reasonCode, reason] of cases) {
    const health = await probeVercelReadHealth({
      runner: { async run() { return result; } },
    });
    assert.equal(health.available, false);
    assert.equal(health.reasonCode, reasonCode);
    const capability = getVercelReadCapability({ health, enabledForTurn: true });
    assert.equal(capability.available, false);
    assert.equal(capability.enabledForTurn, false);
    assert.equal(capability.reason, reason);
    assert.doesNotMatch(JSON.stringify(capability), /account details|token/u);
  }
});

test("Vercel CLI runner rejects deploy, link, env, domain, logs, wait, and arbitrary arguments before exec", async () => {
  const fake = createFakeExec([]);
  const runner = createVercelCliRunner({ execFileImpl: fake.execFileImpl });
  const blocked = [
    ["deploy", ...JSON_ARGS],
    ["link", ...JSON_ARGS],
    ["env", "ls", ...JSON_ARGS],
    ["domains", "ls", ...JSON_ARGS],
    ["logs", "example.vercel.app", ...JSON_ARGS],
    ["inspect", "example.vercel.app", "--logs", ...JSON_ARGS],
    ["inspect", "example.vercel.app", "--wait", ...JSON_ARGS],
    ["inspect", "https://evil.example", ...JSON_ARGS],
    ["list", "--all", "--token", TOKEN, ...JSON_ARGS],
  ];
  for (const args of blocked) {
    await assert.rejects(
      runner.run(args),
      { code: "PROJECT_WORK_VERCEL_COMMAND_BLOCKED", status: 403 },
    );
  }
  assert.equal(fake.calls.length, 0);
});

test("Vercel connector and tools stay disabled until explicitly enabled for one turn", async () => {
  let runCalls = 0;
  const connector = createVercelReadConnector({
    enabledForTurn: false,
    runner: { async run() { runCalls += 1; } },
  });
  await assert.rejects(
    connector.listProjects(),
    { code: "PROJECT_WORK_VERCEL_DISABLED", status: 403 },
  );
  assert.equal(runCalls, 0);
  assert.deepEqual(createVercelReadTools({ enabledForTurn: false }), []);
});

test("listProjects uses the exact bounded CLI argv and omits account context and unknown fields", async () => {
  const queued = createQueueRunner([{
    exitCode: 0,
    stdout: JSON.stringify({
      projects: [{
        id: "prj_safe",
        name: `pi-${TOKEN}`,
        latestProductionUrl: "https://pi-agent.vercel.app",
        updatedAt: 1_785_548_800_000,
        nodeVersion: "24.x",
        accountId: "team-private",
        token: TOKEN,
      }],
      pagination: { next: 1_785_500_000_000 },
      contextName: "private-team",
      elapsed: 22,
    }),
  }]);
  const connector = createVercelReadConnector({
    enabledForTurn: true,
    runner: queued.runner,
    env: { VERCEL_TOKEN: TOKEN },
  });
  const result = await connector.listProjects({ next: 1_785_600_000_000 });
  assert.deepEqual(queued.calls[0], [
    "project",
    "list",
    "--next",
    "1785600000000",
    ...JSON_ARGS,
  ]);
  assert.equal(result.access, "read_only");
  assert.equal(result.trust, "untrusted_external_content");
  assert.equal(result.projects[0].name, "pi-[redacted]");
  assert.equal(result.projects[0].latest_production_url, "https://pi-agent.vercel.app/");
  assert.equal(result.projects[0].accountId, undefined);
  assert.equal(result.contextName, undefined);
  assert.equal(result.next, 1_785_500_000_000);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(result), /private-team|team-private/u);
});

test("listDeployments always uses --all or one validated project and strips creator and metadata", async () => {
  const queued = createQueueRunner([{
    exitCode: 0,
    stdout: JSON.stringify({
      deployments: [{
        id: "dpl_safe",
        name: "pi-agent",
        url: "pi-agent-123.vercel.app",
        state: "READY",
        target: "production",
        customEnvironment: { id: "env_private", slug: "production" },
        createdAt: 1_785_548_800_000,
        ready: 1_785_548_801_000,
        creator: { uid: "user-private", username: "private-user" },
        meta: { token: TOKEN },
      }],
      pagination: {},
    }),
  }, {
    exitCode: 0,
    stdout: JSON.stringify({ deployments: [], pagination: { next: 1_785_000_000_000 } }),
  }]);
  const connector = createVercelReadConnector({
    enabledForTurn: true,
    runner: queued.runner,
    env: { VERCEL_TOKEN: TOKEN },
  });

  const all = await connector.listDeployments();
  assert.deepEqual(queued.calls[0], ["list", "--all", ...JSON_ARGS]);
  assert.equal(all.deployments[0].url, "https://pi-agent-123.vercel.app/");
  assert.equal(all.deployments[0].creator, undefined);
  assert.equal(all.deployments[0].meta, undefined);
  assert.equal(all.deployments[0].custom_environment, "production");
  assert.doesNotMatch(JSON.stringify(all), /private-user|user-private|env_private/u);

  const project = await connector.listDeployments({
    project: "pi-agent",
    next: 1_785_100_000_000,
  });
  assert.deepEqual(queued.calls[1], [
    "list",
    "pi-agent",
    "--next",
    "1785100000000",
    ...JSON_ARGS,
  ]);
  assert.equal(project.next, 1_785_000_000_000);
});

test("inspectDeployment accepts only a deployment id or vercel.app host and never requests logs or wait", async () => {
  const queued = createQueueRunner([{
    exitCode: 1,
    stdout: JSON.stringify({
      id: "dpl_failed",
      name: "pi-agent",
      url: "pi-agent-failed.vercel.app",
      target: "preview",
      readyState: "ERROR",
      createdAt: 1_785_548_800_000,
      aliases: ["pi-agent.vercel.app", "https://www.example.com"],
      builds: [{ token: TOKEN }],
      routes: [{ src: "/secret" }],
      contextName: "private-team",
    }),
  }]);
  const connector = createVercelReadConnector({
    enabledForTurn: true,
    runner: queued.runner,
    env: { VERCEL_TOKEN: TOKEN },
  });
  const result = await connector.inspectDeployment({
    deployment: "https://pi-agent-failed.vercel.app/",
  });
  assert.deepEqual(queued.calls[0], [
    "inspect",
    "pi-agent-failed.vercel.app",
    ...JSON_ARGS,
  ]);
  assert.equal(queued.calls[0].includes("--logs"), false);
  assert.equal(queued.calls[0].includes("--wait"), false);
  assert.equal(result.deployment.state, "ERROR");
  assert.equal(result.deployment.builds, undefined);
  assert.equal(result.deployment.routes, undefined);
  assert.equal(result.contextName, undefined);
  assert.deepEqual(result.deployment.aliases, [
    "https://pi-agent.vercel.app/",
    "https://www.example.com/",
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test("Vercel connector rejects unsafe project and deployment targets before invoking the CLI", async () => {
  const queued = createQueueRunner([]);
  const connector = createVercelReadConnector({
    enabledForTurn: true,
    runner: queued.runner,
  });
  const calls = [
    () => connector.listProjects({ next: 0 }),
    () => connector.listDeployments({ project: "../pi-agent" }),
    () => connector.listDeployments({ project: "pi.agent" }),
    () => connector.inspectDeployment({ deployment: "--logs" }),
    () => connector.inspectDeployment({ deployment: "https://evil.example" }),
    () => connector.inspectDeployment({ deployment: "https://pi-agent.vercel.app/path" }),
    () => connector.inspectDeployment({ deployment: "https://user:pass@pi-agent.vercel.app" }),
  ];
  for (const call of calls) {
    await assert.rejects(call(), {
      code: "PROJECT_WORK_VERCEL_INPUT_INVALID",
      status: 400,
    });
  }
  assert.equal(queued.calls.length, 0);
});

test("Vercel connector fails closed on timeout, oversized output, nonzero list, and malformed JSON", async () => {
  const cases = [
    [{ timedOut: true, exitCode: 1 }, "PROJECT_WORK_VERCEL_TIMEOUT"],
    [{ tooLarge: true, exitCode: 1 }, "PROJECT_WORK_VERCEL_RESPONSE_TOO_LARGE"],
    [{ exitCode: 1, stderr: `private ${TOKEN}` }, "PROJECT_WORK_VERCEL_UPSTREAM_FAILED"],
    [{ exitCode: 0, stdout: "not-json" }, "PROJECT_WORK_VERCEL_RESPONSE_INVALID"],
  ];
  for (const [result, code] of cases) {
    const connector = createVercelReadConnector({
      enabledForTurn: true,
      runner: { async run() { return result; } },
    });
    await assert.rejects(
      connector.listProjects(),
      (error) => error.code === code && !String(error.message).includes(TOKEN),
    );
  }
});

test("Vercel tool definitions expose exactly the three bounded read-only actions", async () => {
  const queued = createQueueRunner([{
    exitCode: 0,
    stdout: JSON.stringify({ projects: [], pagination: {} }),
  }]);
  const tools = createVercelReadTools({
    enabledForTurn: true,
    runner: queued.runner,
  });
  assert.deepEqual(tools.map((tool) => tool.name), VERCEL_READ_TOOL_NAMES);
  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.doesNotMatch(tool.description, /deploy\b|write|link.*project/iu);
  }
  const result = await tools[0].execute("vercel-projects", {});
  assert.equal(result.details.access, "read_only");
  assert.equal(result.details.returned_count, 0);
});
