#!/bin/bash
# caddy-mcp 部署脚本
# 用法: sudo ./scripts/install.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="/opt/caddy-mcp"
CONF="/etc/caddy-mcp"
LOG="/var/log/caddy-mcp"
SERVICE="/etc/systemd/system/caddy-mcp.service"

[ "$(id -u)" = "0" ] || { echo "请用 root 运行"; exit 1; }

echo "==> 1. 部署代码到 $DST"
mkdir -p "$DST"
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude 'config/tokens.json' \
  --exclude 'config/config.json' \
  --exclude 'config/ddns.json' \
  "$SRC/" "$DST/"

echo "==> 2. 安装依赖"
cd "$DST"
npm install --omit=dev --registry=https://registry.npmmirror.com

echo "==> 3. 初始化配置目录 $CONF"
mkdir -p "$CONF" "$LOG"
for f in config tokens ddns; do
  if [ ! -f "$CONF/$f.json" ]; then
    cp "$DST/config/$f.example.json" "$CONF/$f.json"
    echo "    已创建 $CONF/$f.json（需手动编辑）"
  else
    echo "    已存在 $CONF/$f.json（跳过）"
  fi
done
chmod 600 "$CONF/tokens.json" 2>/dev/null || true

echo "==> 4. 创建 systemd 服务"
cat > "$SERVICE" <<'UNIT'
[Unit]
Description=Caddy MCP Server
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/caddy-mcp
Environment=NODE_ENV=production
Environment=PORT=3100
Environment=HOST=127.0.0.1
EnvironmentFile=-/etc/caddy-mcp/env
ExecStart=/usr/bin/node /opt/caddy-mcp/server.js
Restart=on-failure
RestartSec=10
MemoryMax=256M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable caddy-mcp
systemctl restart caddy-mcp

echo "==> 5. 检查状态"
sleep 2
systemctl is-active caddy-mcp && echo "✅ 服务已启动" || echo "❌ 启动失败，查看: journalctl -u caddy-mcp -n 30"

cat <<'TIP'

========================================
安装完成。后续步骤：

1. 编辑 Token：
   vim /etc/caddy-mcp/tokens.json

2. 编辑 DDNS 域名：
   vim /etc/caddy-mcp/ddns.json

3. 如需要 Cloudflare Token（证书/DDNS），创建：
   echo 'CF_API_TOKEN=your_token' > /etc/caddy-mcp/env
   chmod 600 /etc/caddy-mcp/env
   systemctl restart caddy-mcp

4. 测试：
   curl -s http://127.0.0.1:3100/health
========================================
TIP
