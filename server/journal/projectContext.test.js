import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProjectContextReader,
  ProjectContextError,
  summarizeProjectState,
} from "./projectContext.js";

test("project context reads only bounded, relevant Markdown sections inside the project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-project-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "state.md"), [
    "# 项目状态",
    "",
    "当前项目以长期工作流为中心。",
    "",
    "## 无关附录",
    "",
    "x".repeat(20_000),
    "",
    "## 权限与确认",
    "",
    "正式写入前必须展示精确预览。",
  ].join("\n"), "utf8");

  const context = await createProjectContextReader({
    projectRoot: root,
    projectStatePath: "state.md",
  }).read();

  assert.equal(context.source_path, "state.md");
  assert.match(context.revision, /^sha256:[a-f0-9]{64}$/);
  assert.match(context.content, /长期工作流/);
  assert.match(context.content, /精确预览/);
  assert.equal(context.content.length <= 12_000, true);
  assert.equal(context.byte_length > 0, true);
});

test("structured project state is parsed without inferring prose sections", () => {
  const summary = summarizeProjectState([
    "# 项目状态",
    "",
    "## 当前目标",
    "",
    "完成首个真实闭环。",
    "",
    "## 已确认决定",
    "",
    "- 工作流负责推进。",
    "- Agent 负责介入。",
    "",
    "## 开放问题",
    "",
    "- [ ] 如何验证质量？",
    "",
    "## 下一步",
    "",
    "1. 完成写入闭环。",
    "2. 开始真实测试。",
  ].join("\n"));

  assert.deepEqual(summary, {
    title: "项目状态",
    goal: "完成首个真实闭环。",
    decisions: ["工作流负责推进。", "Agent 负责介入。"],
    open_questions: ["如何验证质量？"],
    next_action: "完成写入闭环。",
    next_actions: ["完成写入闭环。", "开始真实测试。"],
    missing_sections: [],
  });
  assert.deepEqual(
    summarizeProjectState("# 讨论记录\n\n这不是结构化状态。").missing_sections,
    ["当前目标", "已确认决定", "开放问题", "下一步"],
  );
});

test("appended level-three headings cannot replace canonical level-two project state", () => {
  const summary = summarizeProjectState([
    "# 项目状态",
    "",
    "## 当前目标",
    "",
    "完成首个真实闭环。",
    "",
    "## 已确认决定",
    "",
    "- 保留 canonical 决定。",
    "",
    "## 开放问题",
    "",
    "- [ ] canonical 问题？",
    "",
    "## 下一步",
    "",
    "1. 完成 canonical 行动。",
    "",
    "### 已确认决定",
    "",
    "- 这只是追加记录，不得覆盖。",
    "",
    "### 开放问题",
    "",
    "- [ ] 这只是某次追加的问题。",
    "",
    "### 下一步",
    "",
    "1. 这只是某次追加的行动。",
  ].join("\n"));

  assert.deepEqual(summary.decisions, ["保留 canonical 决定。"]);
  assert.deepEqual(summary.open_questions, ["canonical 问题？"]);
  assert.deepEqual(summary.next_actions, ["完成 canonical 行动。"]);
});

test("project context rejects missing, non-Markdown, and symlink escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-project-context-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-project-context-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));

  await assert.rejects(createProjectContextReader({
    projectRoot: root,
    projectStatePath: "missing.md",
  }).read(), (error) => (
    error instanceof ProjectContextError
    && error.code === "PROJECT_STATE_NOT_CONFIGURED"
  ));

  await writeFile(path.join(root, "state.txt"), "state", "utf8");
  await assert.rejects(createProjectContextReader({
    projectRoot: root,
    projectStatePath: "state.txt",
  }).read(), (error) => error.code === "PROJECT_STATE_OUT_OF_SCOPE");

  await writeFile(path.join(outside, "state.md"), "# 外部状态", "utf8");
  await mkdir(path.join(root, "nested"));
  await symlink(path.join(outside, "state.md"), path.join(root, "nested", "state.md"));
  await assert.rejects(createProjectContextReader({
    projectRoot: root,
    projectStatePath: "nested/state.md",
  }).read(), (error) => error.code === "PROJECT_STATE_OUT_OF_SCOPE");
});
