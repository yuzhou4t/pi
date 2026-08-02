import { notificationError } from "./contract.js";

export function createDisabledLarkTransport() {
  return Object.freeze({
    kind: "lark-disabled",
    async resolveIdentity() {
      throw notificationError(
        "LARK_BOT_IDENTITY_UNAVAILABLE",
        "飞书机器人身份尚未连接",
        { retriable: false },
      );
    },
    async send() {
      throw notificationError(
        "LARK_TRANSPORT_DISABLED",
        "飞书提醒传输尚未启用",
        { retriable: false },
      );
    },
  });
}

export function createInjectedLarkTransport(sendImpl, resolveIdentityImpl) {
  if (typeof sendImpl !== "function") {
    throw new TypeError("sendImpl must be a function");
  }
  const resolver = typeof resolveIdentityImpl === "function"
    ? resolveIdentityImpl
    : async () => {
        throw notificationError(
          "LARK_BOT_IDENTITY_UNAVAILABLE",
          "飞书机器人身份尚未注入",
          { retriable: false },
        );
      };
  return Object.freeze({
    kind: "lark-injected",
    async resolveIdentity() {
      return resolver();
    },
    async send(envelope) {
      return sendImpl(envelope);
    },
  });
}
