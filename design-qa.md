# Pi Agent 极简可读性调整：设计 QA

> 验收日期：2026-07-22  
> 状态：`review_ready / 本周待审阅`

## 视觉事实源与规格化

- 用户反馈事实源：默认字号过小、候选信息过密、右栏内容混在一起，不符合极简方向。
- 桌面调整前截图：`/private/tmp/pi-agent-minimal-audit-03-desktop.png`（1440 × 1024 px）。
- 移动调整前截图：`/private/tmp/pi-agent-minimal-audit-01-current.png`、`/private/tmp/pi-agent-minimal-audit-02-evidence.png`（均为 400 × 672 px）。
- 桌面最终实现：`/private/tmp/pi-agent-minimal-after-desktop.png`（1440 × 1024 px，CSS 视口 1440 × 1024，DPR 1）。
- 移动最终实现：`/private/tmp/pi-agent-minimal-after-mobile-400x672.png`、`/private/tmp/pi-agent-minimal-after-evidence-400x672.png`（400 × 672 px，CSS 视口 400 × 672，DPR 1）。
- 展开与项目状态：`/private/tmp/pi-agent-minimal-interactions-desktop.png`、`/private/tmp/pi-agent-minimal-mobile-project-state.png`。
- 桌面全视图对照：`/private/tmp/pi-agent-minimal-comparison-desktop.png`。
- 桌面中心与右栏聚焦对照：`/private/tmp/pi-agent-minimal-focus-center.png`、`/private/tmp/pi-agent-minimal-focus-context.png`。
- 移动候选与依据对照：`/private/tmp/pi-agent-minimal-mobile-candidate-compare.png`、`/private/tmp/pi-agent-minimal-mobile-evidence-compare.png`。
- 候选摘要调整后：`/private/tmp/pi-agent-candidate-summary-desktop.png`（1440 × 1024 px）、`/private/tmp/pi-agent-candidate-summary-mobile.png`（400 × 672 px）。
- 候选摘要前后对照：`/private/tmp/pi-agent-candidate-summary-desktop-compare.png`、`/private/tmp/pi-agent-candidate-summary-mobile-compare.png`。
- 同组对照均使用相同视口、相同候选审阅状态和相同 DPR，无需密度归一化。

## 可见对照结论

- 中心区从“每篇默认展开全部标签、热度和证据”改为两层摘要；默认依次回答“论文讲什么”和“对项目的作用”，再通过“查看依据”渐进披露次要信息。同时最多展开一篇依据。
- `86 / 17 / 5` 三格指标改为一行扫描摘要，避免形成小型仪表盘。
- 右栏从一条长堆栈拆为“当前依据 / 项目状态”两个互斥 Tab。当前依据只显示当前论文、证据范围和最多三条相关证据；项目状态分为决定、开放问题和下一步。
- 桌面主标题为 21 px，阶段标题 20 px，论文标题 15 px，正文 13 px，元信息最低 12 px；移动论文标题 16 px、正文 15 px、元信息 13 px。
- 移动端主操作和依据展开按钮为 44 px 高；页面宽度和 `scrollWidth` 均为 400 px，无横向溢出。

## 必查表面

- 字体与排版：继续使用 `Noto Sans SC / PingFang SC / Microsoft YaHei` 回退链；字号、行高和字重形成明确的标题、正文、元信息三级关系，不再用 8–10 px 承载主要内容。
- 间距与布局：保留三栏结构和暖中性表面，但减少默认可见层数；候选之间用单一分隔而非多层卡片。移动端单次只显示项目、本轮或依据中的一个视图。
- 颜色与 Token：沿用 `#0f766e` 深青强调和暖灰背景；强调色只用于主行动、选中状态与证据提示，未新增装饰性色。
- 图像与素材：本工具界面不需要照片或插画；可见图标均来自 Phosphor，没有 Emoji、手工 SVG、CSS 绘图或占位图。
- 文案与内容：扫描摘要、候选决定、证据范围和项目状态分工清楚；演示边界仍明确，未暗示真实写入已完成。
- 交互与可访问性：依据展开、右栏 Tabs、候选选择、移动底部导航均为语义控件；Tabs 支持方向键、Home/End；焦点样式和 reduced-motion 规则保留。

## 比较历史与修复

### 第 1 轮：桌面信息密度

- [P1] 主要内容普遍为 8–10 px，论文标题、正文与证据几乎同一灰度层级。
  - 修复：整体字体阶梯上调，正文颜色加深，并同步增加行高与候选纵向节奏。
- [P1] 每篇论文的热度和证据默认展开，右栏把依据、来源、运行记录和项目状态一次性并列。
  - 修复：候选依据改为单项渐进披露；右栏改为两个互斥 Tab，并删除重复热度堆叠。
- [P2] 三个扫描数字被表现为指标卡，流程步骤和元信息零件过多。
  - 修复：扫描统计合并为一句；Run 顶部移除 Run ID 和多余图标，只保留时间窗与状态。

### 第 2 轮：移动断点

- [P1] 工作流右栏的后置基础样式覆盖了移动隐藏规则，导致“本轮”和“依据”在同一页面连续出现。
  - 修复：移动断点显式设置 `.workflow-context-rail` 隐藏，仅在 `is-mobile-active` 时显示。
- [P2] 五步标签被压成微型圆点文字，粘性操作栏下方可看到被遮住的候选内容。
  - 修复：移动端只视觉显示步骤编号，步骤名称保留为可访问隐藏文本；操作栏改为不透明背景并消除底部 padding 穿透。

### 第 3 轮：最终复核

- 桌面、中心聚焦、右栏聚焦及两组 400 × 672 移动对照中未发现仍需修复的 P0、P1 或 P2。
- 没有需要阻塞交付的 P3 项。

### 第 4 轮：候选摘要层级

- 用户事实源：进入精读前要先知道论文在讲什么，同时保留它对当前项目的作用。
- 修复：候选正文改为无卡片、无边框的语义化两行信息；“论文讲什么”使用短选择摘要，“对项目的作用”保留原相关性判断，热度和证据仍放在展开区。
- 桌面与 400 × 672 移动对照中未发现新增的 P0、P1 或 P2；窄屏采用纵向阅读，不为追求首屏塞入而压缩字号。

## 功能与构建验收

- `npm run build` 通过；Vite 未出现错误覆盖层。
- 实际完成：选两篇 → 准备导读 → 第一篇进入精读、第二篇只收藏 → 四阶段推进 → 生成三处写入预览。
- 实际完成：模拟 Obsidian 失败 → 进入部分失败 → 只重试失败项 → 完成。
- 候选依据可展开/收起且同时最多展开一篇；右栏桌面与移动端均可切换“当前依据 / 项目状态”。
- 移动候选页正文为 15 px、标题 16 px、核心按钮 44 px；移动本轮与依据不会同时显示。

## 当前边界

这是前端 fixture 原型。当前不会扫描网络、调用模型、读取真实项目、运行 MinerU，或写入 Zotero、Obsidian 和项目文件。

final result: passed
