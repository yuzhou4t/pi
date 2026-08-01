import assert from "node:assert/strict";
import test from "node:test";
import { createLarkCliNotificationTransport } from "./larkCliTransport.js";

function createFakeExec(results) {
  const calls = [];
  const queue = [...results];
  const execFileImpl = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    const result = queue.shift() ?? {};
    callback(
      result.error ?? null,
      result.stdout ?? "",
      result.stderr ?? "",
    );
  };
  return { calls, execFileImpl };
}

const sendEnvelope = Object.freeze({
  target: Object.freeze({ type: "chat_id", id: "oc_safe_target" }),
  idempotencyKey: "lark:primary:conversation-1:17",
  message: Object.freeze({
    title: "Pi Agent 有内容等待审阅",
    text: "安全项目名 · 回到当前任务继续。",
    returnEntry: "http://127.0.0.1:4173/?work_type=project_work&conversation_id=conversation-1",
  }),
});

test("resolveIdentity uses the exact bot whoami argv and derives a stable fingerprint", async () => {
  const fake = createFakeExec([{
    stdout: JSON.stringify({
      ok: true,
      data: {
        tenant_key: "tenant_1",
        app: { app_id: "cli_app_1", name: "Pi Agent 提醒机器人" },
        bot: { open_id: "ou_bot_1" },
      },
    }),
  }]);
  const transport = createLarkCliNotificationTransport({
    execFileImpl: fake.execFileImpl,
    binary: "/fake/lark-cli",
    cwd: "/safe/worker-root",
  });
  const identity = await transport.resolveIdentity();
  assert.deepEqual(fake.calls[0].args, ["whoami", "--as", "bot"]);
  assert.equal(fake.calls[0].binary, "/fake/lark-cli");
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(identity.label, "Pi Agent 提醒机器人");
  assert.match(identity.fingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test("send requires a strict ok data envelope and includes only the controlled return entry", async () => {
  const fake = createFakeExec([{
    stdout: JSON.stringify({ ok: true, data: { message_id: "om_safe" } }),
  }]);
  const transport = createLarkCliNotificationTransport({
    execFileImpl: fake.execFileImpl,
  });
  assert.deepEqual(await transport.send(sendEnvelope), { messageId: "om_safe" });
  const args = fake.calls[0].args;
  assert.deepEqual(args.slice(0, 6), [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    "oc_safe_target",
  ]);
  const message = args[args.indexOf("--text") + 1];
  assert.match(message, /打开 Pi Agent：http:\/\/127\.0\.0\.1:4173\/\?work_type=project_work&conversation_id=conversation-1/u);
  assert.doesNotMatch(message, /Users|日志|凭据/u);
});

test("exit zero without an explicit ok data envelope fails closed", async () => {
  for (const stdout of [
    "",
    JSON.stringify({ data: { message_id: "om_ambiguous" } }),
    JSON.stringify({ ok: true }),
    "not-json",
  ]) {
    const fake = createFakeExec([{ stdout }]);
    const transport = createLarkCliNotificationTransport({
      execFileImpl: fake.execFileImpl,
    });
    await assert.rejects(
      transport.send(sendEnvelope),
      (error) => (
        error.code === "LARK_NOTIFICATION_SEND_FAILED"
        && error.retriable === false
      ),
    );
  }
});

test("bot identity requires a stable app or bot identifier", async () => {
  const fake = createFakeExec([{
    stdout: JSON.stringify({ ok: true, data: { name: "无标识机器人" } }),
  }]);
  const transport = createLarkCliNotificationTransport({
    execFileImpl: fake.execFileImpl,
  });
  await assert.rejects(
    transport.resolveIdentity(),
    (error) => error.code === "LARK_BOT_IDENTITY_INVALID",
  );
});
