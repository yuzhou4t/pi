# Pi Agent 本地运行与诊断

> 适用范围：本地单用户桌面版。本文只描述可从当前代码和公共接口核验的行为。

## 1. 运行结构

日常启动使用项目根目录的 `npm run local`，桌面快捷方式调用同一启动器。启动器监管三个本机进程：

1. `Pi Runtime`：承载正常工作会话和 Pi SDK session，只监听随机选择的回环端口。
2. `Pi Agent API`：承载论文工作流，并把 `/api/v1/project-work/**` 代理给 Pi Runtime。
3. Vite 页面：固定监听 `http://127.0.0.1:4173/`。

API 或页面重启不会主动终止 Pi Runtime 中正在进行的 turn。API 退出时会先停止接收新请求并关闭空闲连接；长连接也受限于短暂的关闭窗口，不会无限拖住 launcher 的重启。只有退出启动器时，三个受管进程才会收到受控停止信号。启动器不会占用、打开或停止身份不匹配的未知端口服务。

## 2. 健康检查

页面使用的统一健康入口是：

```text
GET http://127.0.0.1:4173/api/v1/health
```

关键字段：

- `status: "ok"`：当前 HTTP 服务可响应。
- `runtime_schema_version: 1`：当前共享运行时合同版本。
- `runtime_role: "gateway"`：日常启动下的公共 API；正常工作请求会转发到独立 Runtime。
- `runtime_role: "worker"`：内部 Pi Runtime，不承载论文工作流。
- `runtime_role: "embedded"`：单独运行开发 API 时，项目工作仍在同一进程内。
- `journal_workflow` 与 `project_work`：对应业务服务是否可用。
- `mineru_configured`：只说明服务端是否配置了解析凭据，不返回凭据内容。

若 Runtime 暂时不可达，项目工作接口返回 `503 / PROJECT_WORK_RUNTIME_UNAVAILABLE`。页面应显示恢复状态并重连，不能切换到 fixture 或创建一条新的替代会话。

## 3. 持久数据

正常工作默认保存在：

```text
~/Library/Application Support/Pi Agent/project-work
```

可用服务端环境变量 `PI_PROJECT_WORK_STORAGE_ROOT` 指向另一处私有目录。存储内容包括会话状态、单调事件流、Pi JSONL session、Workspace registry、PendingWorkspaceWrite 私有载荷、WorkspaceChangeSet、WorkspaceRun record/event、验证 attempt 与会话生成图片。公共 API 只返回安全标签和项目内相对路径，不返回这些目录的绝对路径。

验证 attempt 的完整已采集 stdout/stderr 是“运行”工件中的权威证据；达到采集上限时会显示明确标记。`RunSupervisor` 使用 `runId + afterSeq` 补齐刷新或重连期间的日志；服务重启不会自动重跑命令，无法确认存活的运行会恢复为 `interrupted`。若本机安装 RTK，失败日志会额外生成一份只供 Pi 修复回合使用的压缩投影，并保留关键诊断与日志末尾；RTK 不可用、失败、超时或压缩收益不足时自动使用原始已采集内容。RTK 遥测被禁用，也不会成为验证命令的外层执行器。

正常工作的图片生成要求本机 Codex CLI 已使用 ChatGPT 订阅登录，可用 `PI_CODEX_CLI_PATH` 固定 CLI 路径。适配器只开放内置图片生成能力，并在临时空目录中关闭 shell、网页、插件和其他工具；生成 PNG 经尺寸、内容哈希与读回校验后保存到会话私有工件目录。订阅路径只记录返回的 Token 与图片次数，不计算 API 美元费用。

论文 Run Store、来源游标和归档 ledger 也只保存在服务端。Live 模式遇到缺少项目状态、扫描失败、恢复中或无候选时会保留真实状态；fixture 只在测试或显式 `PI_MODEL_MODE=fixture` 的开发运行中启用。

## 4. 常见恢复状态

### 正常工作

- `recovering`：Runtime 正在恢复 session 或 apply journal；不要重复发送同一任务。
- `awaiting_user`：Pi 通过 `ask_user` 等待业务决策。回答问题不等于批准文件写入。
- `awaiting_review`：右侧“更改”存在待核对 Diff；只有哈希绑定确认可以写回。
- `verifying`：受控命令正在会话绑定的真实 Workspace 中运行。
- `stopped`：用户已停止当前 turn；后续队列按页面给出的选择处理。

Workspace write journal 与私有 before blob 会在启动或读取 Workspace 时检查未完成写入。若目标文件已被外部修改，确认、恢复或撤销会进入阻止状态，不覆盖新内容。

### 论文工作流

- 来源结果、候选池、ranking 输入输出先进入 Run 自己的 staging；全局 cursor 只在必要工件持久化后以 CAS 推进。
- 正文准备、解析和归档均按论文或归档项保留独立状态；恢复只重试未完成项。
- `manual_update_required` 表示 Zotero 已有同一条目，Pi Agent 不会自动移动或修改它；该批次不能标记为完全归档。
- ArchiveBatch 依次处理 Obsidian 主笔记、Zotero、`project_state.md`，已读回核验的外部写入不会伪装回滚。

## 5. 发布前验证

统一门禁：

```bash
npm run verify
```

它依次运行共享合同测试、全量测试、生产构建和 schema 检查。发布需要同时满足：

- 命令正常退出，不存在挂起测试、端口误判或临时目录竞争。
- 生产构建没有主包体积警告。
- `npm run schema:check` 确认运行时版本、11 个来源、prompt 与 JSON schema 数量一致。
- Live 模式没有 fixture fallback。

只做快速接口诊断时，可分别运行：

```bash
npm run test:contracts
npm run schema:check
```

不要把 `.env.local`、模型登录状态、API token、绝对项目路径或完整私有日志复制到问题报告中。报告错误码、生命周期、Run/Conversation 安全 ID、事件 `seq` 和经过界面截断的日志即可。
