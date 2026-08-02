const DEFAULT_TITLE = "新工作会话";
const MAX_CJK_TITLE_WIDTH = 42;
const MAX_LATIN_TITLE_WIDTH = 48;

const ACTIONS = [
  { pattern: /(?:修复|修正|解决|fix|repair|resolve)/iu, score: 100 },
  { pattern: /(?:实现|开发|构建|搭建|添加|新增|增添|补充|implement|build|create|add)/iu, score: 92 },
  { pattern: /(?:排查|诊断|定位|debug|diagnose|investigate)/iu, score: 96 },
  { pattern: /(?:优化|改进|改善|重构|升级|optimi[sz]e|improve|refactor|upgrade)/iu, score: 84 },
  { pattern: /(?:对齐|迁移|转换|更新|调整|提交|align|migrate|convert|update|adjust|commit)/iu, score: 78 },
  { pattern: /(?:翻译|生成|提取|整理|测试|验证|translate|generate|extract|organize|test|verify)/iu, score: 72 },
  { pattern: /(?:分析|解读|讲解|解释|检查|审查|analyse|analyze|explain|review|inspect)/iu, score: 62 },
  { pattern: /(?:查看|阅读|理解|read)/iu, score: 56 },
];

const NEGATIVE_CLAUSE = /^(?:不要|别|无需|不用|不需要|不能|请勿|先不要|do not\b|don't\b|never\b|without\b)/iu;
const GENERIC_CONTEXT_LABEL = /^(?:项目|这个项目|当前项目|project|workspace|独立工作区|worker 私有任务)$/iu;
const OPAQUE_IMAGE_NAME = /^(?:codex-clipboard|clipboard|image|screenshot)[-_]?[0-9a-f_-]{20,}\.(?:png|jpe?g|webp)$/iu;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const INLINE_FILE_PATTERN = /(?:[A-Za-z]:[\\/]|(?<![\p{L}\p{N}._-])\/)[^，,。；;!?！？\n]*?\.[A-Za-z0-9]{1,12}(?=\s|$|[，,。；;!?！？])/gu;
const INLINE_BASENAME_PATTERN = /[^\\/\s，,。.!！?？;；:：]+\.[A-Za-z0-9]{1,12}(?=\s|$|[，,。；;!?！？])/gu;

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2060\ufeff]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function safeBasename(value) {
  const basename = normalizedText(value).split(/[\\/]/u).at(-1) ?? "";
  if (OPAQUE_IMAGE_NAME.test(basename)) return "截图.png";
  return basename
    .replace(UUID_PATTERN, "")
    .replace(/^[-_.\s]+|[-_.\s]+$/gu, "")
    .slice(0, 120);
}

function safeContextLabel(value) {
  const label = normalizedText(value);
  if (!label || label.length > 36 || GENERIC_CONTEXT_LABEL.test(label)) return "";
  return label.replace(UUID_PATTERN, "").trim();
}

function compactAbsolutePaths(value) {
  return value
    .replace(
      INLINE_FILE_PATTERN,
      (match) => safeBasename(match) || "文件",
    )
    .replace(
      /(?:[A-Za-z]:[\\/]|(?<![\p{L}\p{N}._-])\/)[^\s，,。；;!?！？]+/gu,
      (match) => safeBasename(match) || "文件",
    );
}

function titleWidth(value) {
  return Array.from(value).reduce((width, character) => (
    width + (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Extended_Pictographic}|[\u3000-\u303f\uff00-\uffef]/u.test(character)
      ? 2
      : 1)
  ), 0);
}

function truncateTitle(value) {
  const source = normalizedText(value)
    .replace(/^[“”‘’"'`]+|[“”‘’"'`，,。.!！?？;；:：\s]+$/gu, "");
  const containsCjk = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(source);
  const maxWidth = containsCjk ? MAX_CJK_TITLE_WIDTH : MAX_LATIN_TITLE_WIDTH;
  if (titleWidth(source) <= maxWidth) return source || DEFAULT_TITLE;
  let result = "";
  let width = 0;
  for (const character of Array.from(source)) {
    const characterWidth = titleWidth(character);
    if (width + characterWidth > maxWidth) break;
    result += character;
    width += characterWidth;
  }
  const lastSpace = result.lastIndexOf(" ");
  if (lastSpace >= Math.floor(result.length * 0.6)) {
    result = result.slice(0, lastSpace);
  }
  return result
    .replace(/(?:以及|并且|然后|同时|还有|和|与|的|to|and|with)$/iu, "")
    .replace(/[，,。.!！?？;；:：\s]+$/gu, "")
    || DEFAULT_TITLE;
}

function cleanAttachmentSubject(fileName, contextLabel = "") {
  const basename = safeBasename(fileName);
  if (!basename) return "";
  if (OPAQUE_IMAGE_NAME.test(basename)) return "截图";
  const extension = basename.match(/\.([A-Za-z0-9]{1,12})$/u)?.[1]?.toLowerCase() ?? "";
  let stem = extension ? basename.slice(0, -(extension.length + 1)) : basename;
  stem = stem
    .replace(UUID_PATTERN, "")
    .replace(/_+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (extension === "drawio") {
    if (contextLabel && /\bMVP\b/iu.test(stem)) {
      return `${contextLabel} MVP 架构图`;
    }
    stem = stem.replace(/(?:总体)?架构(?:图)?|(?:顶会)?机制图/gu, " ").trim();
    return `${stem || contextLabel || "项目"} 架构图`;
  }
  if (["png", "jpg", "jpeg", "webp"].includes(extension)) {
    return stem || "截图";
  }
  return basename;
}

function cleanClause(rawClause, contextLabel) {
  let clause = normalizedText(rawClause)
    .replace(/^(?:[#>*\-–—]+\s*|\d{1,3}[.)、]\s*)+/gu, "")
    .replace(/^(?:但是|不过|而且|并且|并|同时|另外|还有|最后|然后|接着|随后|就是|好像|似乎)\s*/gu, "")
    .replace(/^(?:(?:请(?:你)?|麻烦(?:你)?|劳烦(?:你)?|你可以|能否|可否|可以(?:帮我)?|帮(?:我)?|帮忙|我(?:想|希望|需要)(?:让|请)?你|给我|替我|please|could you|can you|help me|i need you to)\s*)+/giu, "")
    .replace(/(?:帮我|给我|替我)/gu, "")
    .replace(/(理解|了解|查看|阅读|检查|分析|排查|讲解|解释|解读|对齐|修复|实现|添加|优化|更新|整理|提交|测试|验证)(?:一?下|看看)/gu, "$1")
    .replace(/我们(?:这个|的)?/gu, "")
    .replace(/这个(?=[A-Za-z0-9])/gu, "")
    .replace(/所有会导致(?:用户)?(.+?)的问题/gu, "$1问题")
    .replace(/(?:是什么|是啥|这什么)(?:的)?问题/gu, "原因")
    .replace(/(?:一下|看看|就好|即可|怎么样|可以吗|了耶|吧)$/gu, "")
    .trim();

  clause = clause.replace(
    /[^\s，,。.!！?？;；:：]+\.drawio\b/giu,
    (fileName) => cleanAttachmentSubject(fileName, contextLabel),
  );

  clause = clause.replace(
    /(?:(?:当前|这个)?项目)(?:里|中|内|的)?/gu,
    contextLabel || "项目",
  );
  const weakLeadingAction = clause.match(/^(?:理解|了解|查看|阅读|分析)(?:一下)?/u)?.[0];
  if (weakLeadingAction) {
    const remainder = clause.slice(weakLeadingAction.length);
    if (/(?:修复|实现|添加|优化|排查|诊断|对齐|更新|调整|提交)/u.test(remainder)) {
      clause = remainder;
    }
  }
  const alignment = clause.match(/^(.{1,32}?)(?:和|与)(.{1,32}?)(?:做|进行)?对齐$/u);
  if (alignment) clause = `对齐${alignment[1]}与${alignment[2]}`;
  clause = clause
    .replace(/^(?:你|我)\s*/u, "")
    .replace(/(?:不能够?|没办法|不可以)工作/gu, "无法工作")
    .replace(/\s*([，,。.!！?？;；:：])\s*/gu, "$1")
    .replace(/[，,。.!！?？;；:：\s]+$/gu, "")
    .trim();
  return clause;
}

function actionScore(clause) {
  let score = 0;
  for (const action of ACTIONS) {
    const match = clause.match(action.pattern);
    if (match) score = Math.max(score, action.score + (match.index === 0 ? 5 : 0));
  }
  return score + Math.min(titleWidth(clause), 30) / 100;
}

function actionFromClause(clause) {
  return clause.match(/^(修复|排查|诊断|定位|分析|检查|解读|讲解|解释|查看|阅读|investigate|diagnose|analy[sz]e|inspect|explain|review)/iu)?.[1] ?? "";
}

function previousClauseSubject(clause) {
  return clause
    .replace(/^(?:修复|排查|诊断|定位|分析|检查|解读|讲解|解释|查看|阅读|理解)\s*/u, "")
    .replace(/^(?:但是|不过|好像|似乎)/u, "")
    .replace(/(?:不能够?|不能|不工作|没有反应|没反应|异常|失败|了)$/u, "")
    .trim();
}

function failingModelFromSource(source) {
  const failure = source.match(
    /(?:不能够?(?:正常)?工作|无法工作|不工作|没反应|没有反应|异常|失败|cannot|can't|does not|doesn't|fail(?:s|ed)?)/iu,
  );
  if (!failure || failure.index === undefined) return "";
  const prefix = source.slice(0, failure.index);
  const contextual = [...prefix.matchAll(
    /(?:用|换成|切换(?:到|成)|using)\s*([A-Za-z][A-Za-z0-9.+_-]{1,30})/giu,
  )].at(-1)?.[1];
  if (contextual) return contextual;
  return [...prefix.matchAll(
    /\b(?:[A-Z][a-z0-9.+_-]*[A-Z][A-Za-z0-9.+_-]*|[A-Z]{2,}[A-Za-z0-9.+_-]*)\b/gu,
  )].at(-1)?.[0] ?? "";
}

function formattedTitle(value) {
  const source = normalizedText(value)
    .replace(/([\p{Script=Han}])([A-Za-z0-9])/gu, "$1 $2")
    .replace(/([A-Za-z0-9])([\p{Script=Han}])/gu, "$1 $2")
    .replaceAll(/\s+/gu, " ")
    .trim();
  if (/^[a-z]/u.test(source)) {
    return `${source[0].toUpperCase()}${source.slice(1)}`;
  }
  return source;
}

export function legacyConversationTitleFromMessage(value) {
  return normalizedText(value).slice(0, 48) || DEFAULT_TITLE;
}

export function deriveConversationTitle({
  text,
  contextLabel,
  attachments = [],
  images = [],
  fallback = DEFAULT_TITLE,
} = {}) {
  const safeLabel = safeContextLabel(contextLabel);
  const attachmentSubject = [
    ...attachments.map((item) => item?.fileName ?? item?.file_name),
    ...images.map((item) => item?.fileName ?? item?.file_name),
  ].map((fileName) => cleanAttachmentSubject(fileName, safeLabel)).find(Boolean) ?? "";
  const normalizedSource = normalizedText(
    String(text ?? "").replace(/\r\n?|\n/gu, "。"),
  );
  const sourceWithoutUrls = normalizedSource.replace(
    /https?:\/\/[^\s，,。；;!?！？]+/giu,
    "链接",
  );
  const inlineFileSubject = (sourceWithoutUrls.match(INLINE_BASENAME_PATTERN) ?? [])
    .map((fileName) => cleanAttachmentSubject(fileName, safeLabel))
    .find(Boolean) ?? "";
  const fileSubject = attachmentSubject || inlineFileSubject;
  let source = compactAbsolutePaths(sourceWithoutUrls)
    .replace(UUID_PATTERN, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

  if (
    /(?:会话标题|Codex[^。！？!?；;]{0,24}标题)/iu.test(source)
    && /提示词/u.test(source)
    && /(?:提取|生成|概括)/u.test(source)
  ) {
    return "从提示词提取会话标题";
  }
  if (!source) {
    const attachmentFallback = fileSubject === "截图"
      ? "检查截图内容"
      : fileSubject
        ? `查看${fileSubject}`
        : fallback;
    return truncateTitle(formattedTitle(attachmentFallback));
  }

  source = source
    .replace(/(?:然后|接着|随后|同时|另外|最后|并且|以及)/gu, "。")
    .replace(/\b(?:and then|then|also|finally)\b/giu, "。");
  const clauses = source
    .split(/[。！？!?；;，,\n]+/u)
    .map((clause) => cleanClause(clause, safeLabel))
    .filter(Boolean);
  const positiveClauses = clauses.filter((clause) => !NEGATIVE_CLAUSE.test(clause));
  const candidates = positiveClauses.length > 0 ? positiveClauses : clauses;
  let selectedIndex = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (actionScore(candidates[index]) > actionScore(candidates[selectedIndex])) {
      selectedIndex = index;
    }
  }
  let selected = candidates[selectedIndex] ?? "";

  const failingModel = failingModelFromSource(source);
  if (
    failingModel
    && /(?:排查|诊断|定位|debug|diagnose|investigate)/iu.test(source)
    && /(?:不能够?(?:正常)?工作|无法工作|不工作|没反应|没有反应|异常|失败|cannot|can't|does not|doesn't|fail(?:s|ed)?)/iu.test(source)
  ) {
    selected = /(?:不能|无法|不工作|没反应|没有反应|异常|失败|排查|诊断|定位)/u.test(source)
      ? `排查 ${failingModel} 工作异常`
      : /(?:tool|tools)/iu.test(source)
        ? `Investigate ${failingModel} tool failures`
        : `Investigate ${failingModel} failures`;
  }

  if (/^(?:解读|讲解|解释|查看|阅读)(?:它|这个(?:文件|附件|图|截图)?|文件|附件|图|截图)$/u.test(selected)) {
    const action = actionFromClause(selected) || "查看";
    selected = `${action}${fileSubject || safeLabel || "文件"}`;
  }

  const genericAction = actionFromClause(selected);
  if (
    genericAction
    && /^(?:原因|问题|故障|异常|它|这个|文件|附件|图|截图)$/u.test(
      selected.slice(genericAction.length).trim(),
    )
    && selectedIndex > 0
  ) {
    const subject = previousClauseSubject(candidates[selectedIndex - 1]);
    if (subject) selected = `${genericAction}${subject}${/原因|问题|故障|异常/u.test(selected) ? "问题" : ""}`;
  }
  if (
    /登录/u.test(source)
    && /^修复(?:用户)?无法保存设置问题$/u.test(selected)
  ) {
    selected = "修复登录设置保存问题";
  }
  selected = selected
    .replace(
      /^investigate (.+?) with (?:the )?(?:attached )?(screenshot|image|file|attachment)$/iu,
      "Investigate $2 $1",
    )
    .replace(/^investigate why\s+(.+?)\s+cannot call tools.*$/iu, "Investigate $1 tool failures")
    .replace(/^排查(.+?)(?:不能|无法)工作(?:原因|问题)?$/u, "排查$1工作异常");

  if (!selected || selected === "链接") {
    selected = fileSubject
      ? `查看${fileSubject}`
      : source === "链接"
        ? "查看链接内容"
        : fallback;
  }
  return truncateTitle(formattedTitle(selected));
}

export function legacyTitleNeedsMigration(conversation) {
  if (!conversation || conversation.titleOrigin) return false;
  const firstUserMessage = Array.isArray(conversation.messages)
    ? conversation.messages.find((message) => message?.role === "user" && message?.text)
    : null;
  if (!firstUserMessage) return false;
  const legacyTitle = legacyConversationTitleFromMessage(firstUserMessage.text);
  return conversation.title === legacyTitle
    && titleWidth(legacyTitle) > MAX_CJK_TITLE_WIDTH;
}
