# V1 项目工作会话真实纵向切片

> 状态：2026-07-27 可靠性升级已实现
> 阶段：前端合同已由持久 Pi Runtime、固定 Workspace、受控逐次写入和可恢复 Run 承接

## 1. 目标

Pi Agent 在论文闭环之外增加一种同级的正常工作会话。用户可以直接开始一个不绑定文件夹的独立对话，也可以绑定本地项目；两种会话都能显式提交普通 Agent 任务、查看公开计划与执行活动，并在右侧审阅文件、更改、预览和运行结果。

V1 不再预置固定任务。用户既可直接新建独立对话，也可先绑定任意受支持的本地项目：

```text
选择“正常工作”
→ 直接新建独立对话
  或选择本地文件夹 / 新建项目文件夹后在项目中新建会话
→ 显式提交任务
→ 查看三步计划与执行活动
→ 逐文件审阅并确认修改
→ 查看可用预览与验证结果
→ 切回论文会话且状态不丢失
```

行为与架构参考固定在 [PI WEB c09b67d](https://github.com/jmfederico/pi-web/tree/c09b67d15a2e9f90a2eeac1b71ce0d216e03aaa8) 的 `Project → Workspace → Session` 信息层级，以及 [Codex App](https://openai.com/index/introducing-the-codex-app/) 的任务、计划、差异审阅和结果验证节奏；Pi Agent 没有依赖 Pi Web 的未公开模块，视觉上继续使用自己的暖中性色、深青强调和紧凑三栏结构。

## 2. 项目、会话与绑定

- 左上工作类型是项目导航之前的第一层选择，固定为 `正常工作` 与 `论文精读`。选择后，左栏只展示和管理该类型下的项目与会话；切换类型分别恢复最后选择的项目、会话和审阅状态。
- 这项决定覆盖此前“类型只在新建会话面板选择、两类会话在同一项目树混排”的合同。新建会话继承当前工作类型，不再重复询问类型。
- 切换会话恢复该会话的消息、模型、当前工件、上下文引用和待确认状态；切换工件不能重置中间对话。
- `workflow_run` 保留为可恢复的后台执行状态，不作为第二个论文会话重复展示；期刊追踪 Run 与由其进入的论文研读会话有关联，但不是同一个对象。
- 新增项目与消息附件是两个不同动作。项目入口提供“选择本地文件夹”和“新建项目文件夹”两个明确选项，并展示项目名、安全路径标签和读/改/运行的能力说明。
- 两个入口都调用 macOS 原生文件夹选择器：已有项目直接注册 canonical root，新项目先选择父目录再由服务端创建。选择结果使用十分钟、单次消费 token；注册前复核目录身份。浏览器只保存并展示 `rootLabel`，真实绝对路径只存在于服务端注册表。
- Git 项目实时发现主目录与有效的长期 worktree；非 Git 项目只有用户选择的原目录。会话创建时绑定一个 `workspaceId`，此后不在原会话中切换 cwd。
- 顶栏“路径”菜单负责查看当前 Workspace、在另一个 Workspace 新建会话、从当前已提交 HEAD 创建 `pi/<短标题>-<短ID>` worktree，以及删除无会话、无租约、无运行且干净的次级 worktree。删除会话不删除 Workspace，worktree 删除也不使用 `--force`。
- 独立对话是一级 `Conversation`，不是没有文件夹的假项目。公共合同为 `projectId: null`、`scope: standalone`、`workspaceKind: scratch`；创建时只持久化轻量元数据，不打开选择器、不扫描目录、不启动 Pi，也不调用模型。
- 独立对话的私有草稿根只存在于服务端。它可以承接 Pi 创建的文件、Diff、确认写入和验证记录，但不能访问未显式绑定的用户文件夹，浏览器也不会收到草稿根的绝对路径。

## 3. 三栏职责

### 左栏：工作类型、项目与会话

- 左上先选择 `正常工作` 或 `论文精读`。正常工作在项目树之前提供一级 `新建对话` 和 `独立对话` 分组，再展示多个真实项目及项目内会话。
- 每个项目行直接提供“新建会话”；新增项目入口提供“选择本地文件夹”与“新建项目文件夹”，搜索仍是项目级动作。
- 新建会话继承当前工作类型；后台 Run 只显示为相关活动或状态，不重复占用一条同名论文会话。
- 正常工作会话行在 hover 或键盘聚焦时显示一个 `…` 菜单，提供“重命名”和“删除会话”。第一条显式消息可确定性生成短标题，重命名只更新元数据；两者都不额外调用模型。
- V1 的删除是有确认的永久删除，不伪装成没有恢复入口的“归档”。确认框必须列明会删除对话、计划、运行记录和未应用修改草稿；项目会话不会删除项目文件夹或回滚已经确认的修改，独立对话则会删除只属于该会话的私有草稿文件；若存在待确认 ChangeSet，还要显示未应用文件数量。
- Agent、压缩、验证或修改应用仍在运行时禁止删除，不暗中 abort。服务端确认删除前保留原行并显示“正在删除”；失败后恢复原行。删除当前会话后依次选择同项目的下一条、上一条，均不存在时保留项目空状态，不自动创建替代会话。
- 左栏只保留一个壳层级收起控件，同一个左上按钮负责收起和重新展开，不显示第二个镜像按钮。

### 中栏：Agent

- 始终保留任务输入和 Agent 对话。
- 桌面首次打开时右栏关闭，中栏使用除左栏外的全部可用宽度；用户打开或关闭右栏时，中栏对话内容和滚动位置不得重置。
- 用户显式发送后，Pi 可通过结构化工具公开计划、文件活动与验证建议；任务标题来自真实会话，不再由固定 fixture 推进。
- 显式发送后先显示真实的任务提交/会话连接阶段；durable `running` 到达后，公开思考生命周期、计划和实际工具开始/完成事件实时更新。运行期同时保留增量 SSE 与低频快照兜底，任何一条链路暂时失效都不能让过程延迟到最终答案后才出现。
- 公开回答使用同一 assistant message id 的累计替换片段：服务端对完整已生成文本脱敏并按时间/长度节流，前端只维护一个“生成中”气泡，最终由 durable message 原位替换。原始 `thinking_delta`、工具参数和未经清洗的 partial result 不属于公开进度。
- 活动卡可跳到“查看文件”“查看更改”“打开预览”“查看测试”，但跳转不改变消息或执行状态。
- 页面加载、项目绑定、会话切换、模型切换和工件切换均不能触发模型；只有显式发送才启动 Pi turn。运行中可区分即时 steer 与后续消息 queue，可删除或清空未处理 queue；空闲时可显式 compact、retry-last-turn。
- Pi 可用 durable `ask_user` 暂停并等待单选、多选或文本决策。回答只恢复 Agent 推理，不批准验证、预览或文件写回。
- 历史消息有稳定 `messageSeq / turnSeq`，按 turn 游标分页；会话保存单调已读水位。最终回答附带本轮 provider、model、thinking、token/cache、费用和上下文证据。
- 文件或代码选区以可移除的上下文标签进入 Composer，不自动发送。

### 右栏：当前工件

右栏默认关闭，通过一个明确按钮一键打开或关闭；打开后一次只展示一个工件，并保留桌面拖拽、折叠和沉浸查看能力：

1. **文件**：服务端分页、搜索固定 Workspace 的紧凑文件树；文本/代码按 400 行窗口读取，允许安全图片预览。`.DS_Store`、凭据、内部 worktree、危险符号链接和越界路径始终过滤；二进制内容不进入 Agent 上下文。
2. **更改**：每次 `edit/write` 的精确 unified diff、创建/修改/删除状态、`baseHash`、`afterHash`、Workspace revision，以及“待确认”或“已写入 Workspace”状态。
3. **预览**：只接受服务端登记的 Vite、静态站点或 Uvicorn recipe。手动模式展示 recipe、相对 cwd、参数摘要和请求 hash，明确确认后由 supervisor 启动 owned loopback process；没有登记地址时展示真实空态。
4. **运行**：展示每次 WorkspaceRun 的精确命令、状态、耗时、退出码、检查项和按 seq 恢复的 stdout/stderr；达到安全采集上限时必须明确标记，不伪装成无限日志。RTK 只为失败后的 Pi 修复回合生成单独压缩投影，右侧原始证据不被替换；不提供自由终端。注册 recipe 和确认后的精确命令都在同一个固定 Workspace 中运行并复用真实构建缓存。

## 4. 状态合同

项目工作状态由服务端会话存储独立保存，不修改论文工作流的 `runReducer`：

```text
ConversationKind = project_work | paper_reading | workflow_run
ArtifactKind = file | changes | preview | run_result | existing_paper_artifacts
ProjectWorkPhase = ready | planned | working | review | applied | completed
```

- 公共可靠性生命周期固定为 `idle / running / awaiting_user / awaiting_review / verifying / recovering / stopped`。业务 phase 不被它替代；预览、压缩、验证或结算失败作为独立 `ConversationOperation` 记录，不能抹掉已经成功的回答。
- `Conversation` 保存作用域、固定 `workspaceId`、状态、Pi provider/model、消息、计划、待确认写入与验证记录。绑定项目使用 `workspaceKind: bound_project`；独立对话使用 `projectId: null` 与 `workspaceKind: scratch`。
- `ConversationEvent` 使用单调递增的 `seq` 记录计划、活动、批准和结果；snapshot 保存 watermark，SSE 重连只请求 `afterSeq`，恢复后不得倒序或重复。
- `WorkspaceSummary` 只公开 id、projectId、安全标签、类型、Git/主目录标记、branch、HEAD、dirty、status、conversationCount 和更新时间。
- `PendingWorkspaceWrite` 保存相对路径、精确 diff、`baseHash`、`afterHash`、Workspace revision 与 tool-call 绑定；`WorkspaceChangeSet` 保存实际写入及私有 before blob 对应的可撤销证据。
- `WorkspaceRun` 在 spawn 前保存 queued/running，并以 `stream/offset/seq` 追加日志；重连用 `runId + afterSeq` 补齐，Runtime 重启后不能确认存活的进程标为 `interrupted`。
- 项目工作会话拥有独立的服务端 JSON 状态、单调 JSONL 事件流和 Pi JSONL 会话树；浏览器只保存当前工作类型、项目、会话与最后工件偏好。
- 永久删除只清理该会话拥有的服务端状态、事件、Pi JSONL session、PendingWorkspaceWrite 私有载荷和运行历史；不删除 Workspace，不触碰其他会话、已确认写入的文件或 Git 历史。删除接口同时校验项目归属和 busy 状态，公共响应不得泄露绝对路径。

创建空会话只保存轻量会话元数据并绑定 Workspace，不扫描或复制项目，也不启动 Pi。显式发送后，项目会话直接读取该 Workspace；独立对话只通过自己的私有 scratch 根工作。工件与模型切换不推进状态；模型选择只在下一次显式发送时应用。每个 `edit/write` 独立持久化：`需确认`会进入 `awaiting_confirmation`，只有右侧精确确认可以写入；`替我审批`只自动执行通过文件类型、数量、行数、路径、revision 和逐文件哈希门禁的本地写入，其他修改直接阻止。

## 5. 确认与自动审批语义

- `需确认`模式的修改确认必须与右侧“更改”工件共置，不能拆成中栏按钮加右栏预览。
- 每张写入卡绑定一个目标文件和 toolCallId，确认前展示操作类型、完整 diff、Workspace revision、`baseHash` 与 `afterHash`；取消会把受控取消结果返回 Agent，不伪装成功。
- `替我审批`是当前会话的显式权限，不是 `ask_user` 回答或普通聊天回复。它只自动批准创建或修改安全路径文件的有界本地写入；删除、超限、危险路径、revision 或哈希冲突直接阻止。
- 无论人工确认还是自动审批，写入都会按 Workspace 串行，重新核对当前内容与绑定 hash，原子写入并读回；随后持久化 `WorkspaceChangeSet` 和私有 before blob。进程中断后只会确定恢复或进入人工检查，不猜测成功。
- 撤销是独立的 hash-bound 确认；撤销前重新核对当前文件，任何外部变化都会阻止覆盖。它不会 stage、commit 或 push。
- 最终摘要必须能回到写入 Diff、预览和运行证据。

## 6. 桌面端合同

- 本阶段只实现和验收电脑端，不要求 Pi Agent 的移动端布局或移动视口 QA。
- 1440 × 1024：左栏约 240 px；右栏默认关闭，中栏 Agent 使用其余最大空间。打开右栏后，中栏与右栏按可拖拽边界共享剩余空间。
- 约 1180 px：保留 Agent 输入、唯一的左栏收起按钮和右栏开关，并确保页面无横向滚动。
- 文件树、diff 和日志在各自容器内处理溢出。右栏“预览”中的移动宽度只用于审阅目标项目页面，不代表 Pi Agent 自身支持移动端。

## 7. 明确不做

本切片仍不实现：

- Monaco 等代码编辑器；
- Git stage、commit、push、改写历史或自动推送；用户只可在“路径”菜单显式创建长期 worktree 分支；
- 自由选择命令、安装依赖、watcher、inline code 或隐式网络；
- 多 Agent、远程机器、插件市场或依赖安装；
- 放宽现有 Codex subscription adapter 的只读、无工具隔离。

## 8. 真实运行边界

- 日常启动器把项目工作 Runtime 从公共 HTTP API 拆开监管。浏览器断开或 API 重启不会结束正在运行的 Pi session；只有关闭 launcher 才受控停止 Runtime。
- 项目工作使用独立的 `@earendil-works/pi-coding-agent` SDK 宿主，保留 Pi 的持久会话树、事件、steer、follow-up、abort、compact、retry 与 compaction；不把完整 CLI 或 Bash 工具暴露给浏览器。
- Pi 只获得服务端实现的 contained `read/edit/write/grep/find/ls`、`update_plan`、`ask_user`、`request_verification`、`request_workspace_command` 和注册式 preview request。工具先 canonicalize 相对路径并拒绝符号链接、过滤目录和越界访问。
- Agent 直接读取会话绑定 Workspace 的安全实时视图；`.git`、`.env*`、依赖缓存目录和 Pi Agent 自身数据不进入文件工具。不同 Workspace 可并行工作，同一 Workspace 的写入与命令通过 Workspace 级租约串行。
- 独立对话复用同一组 contained tools，但 `projectRoot` 指向会话私有 scratch 根；它不读取用户项目规则或文件。确认写入按会话串行，只能更新该 scratch 根，删除会话时一并清理。
- 验证不是自由终端。Pi 只能建议注册 recipe、现有 package scripts 和已安装依赖；`需确认`时用户在右栏看到最终命令与解析后的项目脚本后显式点击，`替我审批`只自动运行测试、lint、typecheck 等安全类别。注册 recipe 和另行确认的精确命令都以 `shell:false` 在固定 Workspace 中运行并保留独立 attempt，不复制项目。
- 在同一已确认 command binding 内，失败日志可经过脱敏后回灌给 Pi，最多进行两次修复与复测；任何新命令、`ask_user`、预览或写回都不会被这次确认顺带批准。服务重启把未完成修复标为 interrupted，只有明确恢复才会再次调用模型。
- 只有用户为当前消息明确选择“生成图片”并发送时，Pi 才可调用独立的 `gpt-image-2` Codex 订阅适配器；默认工具列表不含生图能力。每轮最多一张会话私有 PNG，完成格式、尺寸、哈希和读回校验后才在对话及“文件”工件展示。该路径不复用论文结构化文本适配器、不复制登录凭据、不直接写入项目，也不把订阅消耗伪装成 API 美元价格。
- 验证进程继承当前 macOS 用户权限，不等同于容器或 OS 安全沙箱；界面明确显示这一点。依赖缺失时验证会如实失败，不会自动安装。
- Monaco、PTY、Git stage/commit/push、可写多 Agent 与远程机器仍不是当前能力。长期 Git worktree 已由路径菜单显式管理；安全自动写入由 Workspace 级串行、PendingWorkspaceWrite、WorkspaceChangeSet、私有 before blob、读回校验和独立撤销承接，它不等同于开放自由写入。
