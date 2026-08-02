import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveConversationTitle,
  legacyConversationTitleFromMessage,
  legacyTitleNeedsMigration,
} from "./conversationTitle.js";

test("long Chinese prompts become compact action-and-object titles", () => {
  assert.equal(
    deriveConversationTitle({
      text: "请检查这个项目中的登录流程，并修复所有会导致用户无法保存设置的问题，同时补充相关测试和验证说明",
      contextLabel: "国别智枢",
    }),
    "修复登录设置保存问题",
  );
  assert.equal(
    deriveConversationTitle({
      text: "理解一下这个项目和我们这个MVP架构对齐一下，不要修改我们的项目，然后给我讲解一下这个DRAWIO",
      contextLabel: "国别智枢",
    }),
    "对齐国别智枢与 MVP 架构",
  );
  assert.equal(
    deriveConversationTitle({
      text: "标题，我们像 Codex 一样，根据提示词提取一个经典标题，不要再重复整段提示词",
    }),
    "从提示词提取会话标题",
  );
});

test("failure prompts and English requests keep the useful subject", () => {
  assert.equal(
    deriveConversationTitle({
      text: "然后我现在用 DeepSeek，它还是不能够正常工作，和之前一模一样啊，你排查一下这什么问题",
    }),
    "排查 DeepSeek 工作异常",
  );
  assert.equal(
    deriveConversationTitle({
      text: "Please investigate why DeepSeek cannot call tools after switching models, then add regression tests.",
    }),
    "Investigate DeepSeek tool failures",
  );
  assert.equal(
    deriveConversationTitle({
      text: "GPT 正常，但 DeepSeek 无法工作，请排查原因",
    }),
    "排查 DeepSeek 工作异常",
  );
  assert.equal(
    deriveConversationTitle({
      text: "Investigate test failures with the attached screenshot.",
    }),
    "Investigate screenshot test failures",
  );
});

test("unstructured prompts still stay within one compact title line", () => {
  const title = deriveConversationTitle({
    text: "这是一个没有明确动作词但是包含很多很多背景说明和补充条件并且还会继续重复描述上下文的超长请求",
  });
  assert.ok(Array.from(title).length <= 21);
  assert.notEqual(title, legacyConversationTitleFromMessage(
    "这是一个没有明确动作词但是包含很多很多背景说明和补充条件并且还会继续重复描述上下文的超长请求",
  ));
  assert.equal(
    deriveConversationTitle({
      text: "需求：\n- 修复登录失败\n- 不修改接口\n- 补充测试",
    }),
    "修复登录失败",
  );
});

test("paths and attachments contribute only safe semantic file names", () => {
  assert.equal(
    deriveConversationTitle({
      text: "请阅读 /Users/example/My Project/MVP-architecture.drawio，并解释它",
    }),
    "解释 MVP-architecture 架构图",
  );
  assert.equal(
    deriveConversationTitle({
      text: "请理解这个项目，不要修改，然后讲解这个附件",
      contextLabel: "国别智枢",
      attachments: [{ fileName: "国别智枢_MVP总体架构_顶会机制图.drawio" }],
    }),
    "讲解国别智枢 MVP 架构图",
  );
  assert.equal(
    deriveConversationTitle({
      text: "",
      images: [{ fileName: "codex-clipboard-b1ac9fa1-792a-445c-a758-461a9c1e2f0e.png" }],
    }),
    "检查截图内容",
  );
  assert.equal(
    deriveConversationTitle({
      text: "请查看 https://example.com/private/report，然后分析里面的问题",
    }),
    "分析里面的问题",
  );
  assert.match(
    deriveConversationTitle({ text: "请修复 src/auth.js 中的登录问题" }),
    /src\/auth\.js/u,
  );
});

test("legacy migration recognizes only an exact oversized automatic prefix", () => {
  const text = "请检查这个项目中的登录流程，并修复所有会导致用户无法保存设置的问题，同时补充相关测试和验证说明";
  const automatic = {
    title: legacyConversationTitleFromMessage(text),
    messages: [{ role: "user", text }],
  };
  assert.equal(legacyTitleNeedsMigration(automatic), true);
  assert.equal(legacyTitleNeedsMigration({ ...automatic, titleOrigin: "manual" }), false);
  assert.equal(legacyTitleNeedsMigration({ ...automatic, title: "我的自定义会话" }), false);
});
