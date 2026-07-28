import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseApiPort,
  isPiAgentHealth,
  isPiAgentHtml,
  isPiRuntimeHealth,
} from "./pi-agent-local.mjs";

test("the page marker and health payload must both identify Pi Agent", () => {
  assert.equal(isPiAgentHtml(`
    <html>
      <head>
        <meta name="pi-agent-app" content="pi-agent-local" />
        <title>Pi Agent</title>
      </head>
    </html>
  `), true);
  assert.equal(isPiAgentHtml("<title>Other app</title>"), false);
  assert.equal(isPiAgentHealth({
    status: "ok",
    journal_workflow: "available",
    project_work: "available",
  }), true);
  assert.equal(isPiAgentHealth({
    status: "ok",
    journal_workflow: "available",
  }), false);
  assert.equal(isPiRuntimeHealth({
    status: "ok",
    project_work: "available",
    runtime_role: "worker",
  }), true);
  assert.equal(isPiRuntimeHealth({
    status: "ok",
    project_work: "available",
    runtime_role: "gateway",
  }), false);
});

test("the internal API skips occupied ports without changing the public URL", async () => {
  const checked = [];
  const port = await chooseApiPort({
    start: 47_880,
    end: 47_883,
    check: async (candidate) => {
      checked.push(candidate);
      return candidate === 47_882;
    },
  });

  assert.equal(port, 47_882);
  assert.deepEqual(checked, [47_880, 47_881, 47_882]);
});

test("the internal API reports exhaustion instead of reusing another service", async () => {
  await assert.rejects(
    chooseApiPort({
      start: 47_880,
      end: 47_881,
      check: async () => false,
    }),
    /内部端口 47880-47881 均被占用/,
  );
});
