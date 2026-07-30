export const PROJECT_WORK_CAPABILITIES = [
  {
    id: "web_search",
    label: "联网搜索",
    description: "检索当前网页资料，并保留来源链接。",
    toolNames: ["search_web"],
  },
  {
    id: "docs_search",
    label: "技术文档",
    description: "按库和版本查找 Context7 文档片段。",
    toolNames: ["resolve_library_id", "query_docs"],
  },
  {
    id: "image_generation",
    label: "生成图片",
    description: "本轮允许使用 GPT Image 2 生成一张会话图片。",
    toolNames: ["generate_image"],
  },
];

export const PROJECT_WORK_WORKFLOWS = [
  {
    id: "code_review",
    label: "代码审查",
    description: "优先找出缺陷、回归风险和缺失验证，并给出精确依据。",
  },
  {
    id: "bug_diagnosis",
    label: "Bug 诊断",
    description: "先复现和定位根因，再给出最小修复建议与验证方法。",
  },
  {
    id: "official_docs",
    label: "官方文档优先",
    description: "涉及库或 API 时先查当前文档，再据此实现或回答。",
    requiredCapabilities: ["docs_search"],
  },
  {
    id: "screenshot_review",
    label: "截图验收",
    description: "只依据所附截图检查界面问题、实现偏差和可见状态。",
    requiresImages: true,
  },
];

export function projectWorkCapability(id) {
  return PROJECT_WORK_CAPABILITIES.find((capability) => capability.id === id) ?? null;
}

export function projectWorkWorkflow(id) {
  return PROJECT_WORK_WORKFLOWS.find((workflow) => workflow.id === id) ?? null;
}
