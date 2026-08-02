# Pi

Pi 是一个本地优先、项目中心的个人 Agent 工作台框架。它把长期项目、Agent 对话、可审阅工件和可恢复工作流放在同一个桌面三栏界面中。

## 框架包含什么

- 正常工作：项目与会话、流式 Agent 过程、文件阅读、变更审阅、验证和受控预览。
- 论文精读：来源追踪、候选筛选、全文准备、导读、对话式阅读和确认后归档。
- Worker：面向文档、邮件和知识库的受限任务流，读取、草稿、交付与回执彼此分离。
- 安全边界：模型凭据只留在本机服务端；文件修改和外部写入使用精确预览、内容哈希与显式确认。
- 恢复能力：会话、事件、运行状态和待确认动作均可持久化，不以页面刷新代替真实状态。

## 目录结构

```text
src/        React 工作台与前端状态
server/     本地 API、工作流与运行时服务
shared/     前后端共享合同
scripts/    本地启动与 Schema 检查
```

## 本地运行

要求 Node.js 24 与 npm。

```bash
npm install
cp .env.example .env.local
cp project_state.example.md project_state.md
npm run local
```

启动成功后访问：

```text
http://127.0.0.1:4173/
```

开发时也可以分别启动 API 与前端：

```bash
npm run dev:api
npm run dev -- --host 127.0.0.1 --port 4173
```

## 验证

```bash
npm run verify
```

该命令依次执行运行时合同测试、全量测试、生产构建和 Schema 检查。

## 代码审查

仓库根目录的 `AGENTS.md` 记录公开的产品边界与 Code Review 规则。针对 Pi 原生 Workspace 迁移的背景、目标和重点审查问题见 [`docs/review-context.md`](docs/review-context.md)。

## 本地数据与凭据

`.env.local`、`.pi-agent/`、依赖缓存和构建产物默认不会进入 Git。请只在 `.env.local` 中填写自己的服务端凭据，不要把 Token、模型登录状态、项目绝对路径或本地运行数据提交到仓库。
