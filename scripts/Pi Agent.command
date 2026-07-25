#!/bin/zsh

PROJECT_DIR="/Users/yuzhou4tc/Public/pi Agent"
NODE_BIN="/Users/yuzhou4tc/.nvm/versions/node/v24.14.0/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "没有找到 Node.js，Pi Agent 无法启动。"
  echo "请保留此窗口并让 Codex 检查本机环境。"
  read -k 1 "?按任意键关闭…"
  exit 1
fi

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "没有找到 Pi Agent 项目：$PROJECT_DIR"
  read -k 1 "?按任意键关闭…"
  exit 1
fi

cd "$PROJECT_DIR" || exit 1
echo "Pi Agent 本机启动器"
echo "────────────────────"
exec "$NODE_BIN" scripts/pi-agent-local.mjs
