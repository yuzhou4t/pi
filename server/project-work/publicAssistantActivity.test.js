import assert from "node:assert/strict";
import test from "node:test";
import {
  publicCommentaryText,
  publicFinalAnswerText,
  publicReasoningSummary,
  publicTextPhase,
} from "./publicAssistantActivity.js";

function textBlock(text, phase = null) {
  return {
    type: "text",
    text,
    ...(phase ? {
      textSignature: JSON.stringify({ v: 1, id: `${phase}-1`, phase }),
    } : {}),
  };
}

test("Codex commentary stays public progress and out of the final answer", () => {
  const message = {
    content: [
      textBlock("我先核对运行入口。", "commentary"),
      textBlock("已经修复并完成验证。", "final_answer"),
    ],
  };
  assert.equal(publicTextPhase(message.content[0]), "commentary");
  assert.equal(publicCommentaryText(message), "我先核对运行入口。");
  assert.equal(publicFinalAnswerText(message), "已经修复并完成验证。");
});

test("unphased provider text remains a normal final answer", () => {
  const message = { content: [textBlock("DeepSeek 最终回答")] };
  assert.equal(publicCommentaryText(message), "");
  assert.equal(publicFinalAnswerText(message), "DeepSeek 最终回答");
  assert.equal(
    publicFinalAnswerText({ content: "字符串形式的最终回答" }),
    "字符串形式的最终回答",
  );
});

test("only an explicit provider reasoning summary is public", () => {
  const block = {
    type: "thinking",
    thinking: "private raw reasoning",
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "已定位到事件恢复边界。" },
        { type: "summary_text", text: "下一步核对失败路径。" },
      ],
      content: [{ type: "reasoning_text", text: "must stay private" }],
    }),
  };
  assert.equal(
    publicReasoningSummary(block),
    "已定位到事件恢复边界。\n\n下一步核对失败路径。",
  );
});

test("raw, redacted, or malformed thinking is never exposed", () => {
  assert.equal(publicReasoningSummary({
    type: "thinking",
    thinking: "raw chain of thought",
  }), "");
  assert.equal(publicReasoningSummary({
    type: "thinking",
    thinking: "visible looking text",
    visibility: "public",
    redacted: true,
  }), "");
  assert.equal(publicReasoningSummary({
    type: "thinking",
    thinking: "raw chain of thought",
    thinkingSignature: "{bad-json",
  }), "");
});

test("future adapters can explicitly mark a normalized summary public", () => {
  assert.equal(publicReasoningSummary({
    type: "thinking",
    thinking: "公开的推理摘要",
    visibility: "public",
  }), "公开的推理摘要");
  assert.equal(publicReasoningSummary({
    type: "thinking",
    thinking: "private raw reasoning",
    thinkingSignature: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "对象形式的公开摘要" }],
    },
  }), "对象形式的公开摘要");
});
