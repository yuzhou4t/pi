import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const COMPONENT_PATH = "/src/components/ProjectLoopNotifications.jsx";

async function withNotifications(callback) {
  const vite = await createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    return await callback(await vite.ssrLoadModule(COMPONENT_PATH));
  } finally {
    await vite.close();
  }
}

test("authorized event re-enable stays narrow while completed requires reauthorization", async () => {
  await withNotifications(({
    notificationEventChangeMode,
    notificationScopeExpansion,
  }) => {
    assert.deepEqual(
      notificationScopeExpansion(
        ["awaiting_user", "awaiting_review"],
        ["awaiting_user"],
      ),
      [],
    );
    assert.deepEqual(
      notificationScopeExpansion(
        ["awaiting_user", "awaiting_review"],
        ["awaiting_user", "awaiting_review"],
      ),
      [],
    );
    assert.deepEqual(
      notificationScopeExpansion(
        ["awaiting_user", "awaiting_review"],
        ["awaiting_user", "awaiting_review", "completed"],
      ),
      ["completed"],
    );
    assert.equal(
      notificationEventChangeMode(
        ["awaiting_user", "awaiting_review"],
        ["awaiting_user", "awaiting_review"],
      ),
      "update",
    );
    assert.equal(
      notificationEventChangeMode(
        ["awaiting_user", "awaiting_review"],
        ["awaiting_user", "awaiting_review", "completed"],
      ),
      "reauthorize",
    );
  });
});

test("binding form supports a fixed group or personal Feishu target", async () => {
  await withNotifications(({ NotificationBindingForm }) => {
    const html = renderToStaticMarkup(React.createElement(NotificationBindingForm, {
      mode: "create",
      busy: false,
      onCancel: () => {},
      onPreview: () => {},
    }));
    assert.match(html, /接收目标类型/);
    assert.match(html, /value="chat_id" selected=""/);
    assert.match(html, /群聊 · Chat ID/);
    assert.match(html, /value="open_id"/);
    assert.match(html, /个人 · Open ID/);
  });
});

test("normal-work header exposes one notification popover for local and Lark channels", async () => {
  await withNotifications(({ ProjectLoopNotificationControl }) => {
    const html = renderToStaticMarkup(React.createElement(
      ProjectLoopNotificationControl,
      {
        conversation: { id: "conversation-1", events: [] },
        defaultOpen: true,
      },
    ));
    assert.match(html, />通知</);
    assert.match(html, /role="dialog" aria-label="通知设置"/);
    assert.match(html, /本机通知/);
    assert.match(html, /飞书提醒/);
    assert.match(html, /正在读取提醒订阅/);
    assert.doesNotMatch(html, /发送测试消息/);
  });
});

test("Lark settings render a read-only loading state before subscription data arrives", async () => {
  await withNotifications(({ LarkNotificationSettings }) => {
    const html = renderToStaticMarkup(React.createElement(LarkNotificationSettings));
    assert.match(html, /由 Pi 服务端持久投递/);
    assert.match(html, /正在读取提醒订阅/);
    assert.doesNotMatch(html, /确认发送|立即发送/);
  });
});

test("settings select the latest settled delivery and make a failed send visible without retry controls", async () => {
  await withNotifications(({
    latestNotificationDelivery,
    NotificationDeliveryStatus,
  }) => {
    const delivery = latestNotificationDelivery([
      {
        id: "sent-old",
        status: "sent",
        updatedAt: "2026-08-01T08:00:00.000Z",
      },
      {
        id: "pending-new",
        status: "retry_wait",
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "failed-new",
        status: "failed",
        lastErrorCode: "LARK_BOT_IDENTITY_MISMATCH",
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
    ]);
    assert.equal(delivery.id, "failed-new");
    const html = renderToStaticMarkup(React.createElement(
      NotificationDeliveryStatus,
      { delivery },
    ));
    assert.match(html, /最近投递/);
    assert.match(html, /投递失败/);
    assert.match(html, /机器人身份已变化，已安全停止/);
    assert.doesNotMatch(html, /重试|重新发送/);
  });
});

test("binding and event expansion both render an explicit confirmation boundary", async () => {
  await withNotifications(({ NotificationConfirmation }) => {
    const bindingHtml = renderToStaticMarkup(React.createElement(
      NotificationConfirmation,
      {
        pending: {
          kind: "binding",
          mode: "create",
          target: { id: "oc_target", label: "个人提醒" },
        },
        busy: false,
        onCancel: () => {},
        onConfirm: () => {},
      },
    ));
    assert.match(bindingHtml, /role="alertdialog"/);
    assert.match(bindingHtml, /个人提醒（oc_target）/);
    assert.match(bindingHtml, /默认开启：等待回答、等待审阅、验证未通过、恢复受阻/);
    assert.match(bindingHtml, /工作完成保持关闭/);
    assert.match(bindingHtml, /明确确认/);

    const scopeHtml = renderToStaticMarkup(React.createElement(
      NotificationConfirmation,
      {
        pending: {
          kind: "scope",
          addedStates: ["completed"],
        },
        busy: false,
        onCancel: () => {},
        onConfirm: () => {},
      },
    ));
    assert.match(scopeHtml, /确认扩大提醒范围/);
    assert.match(scopeHtml, /将新增：工作完成/);
    assert.match(scopeHtml, /生成新的授权修订/);
    assert.match(scopeHtml, /不能代替任何审批/);
  });
});
