#!/usr/bin/env bash
# 本地执行：SSH 到 ECS 拉取最新镜像并重启服务
# 用法：从仓库根目录执行  bash deploy/deploy.sh
set -euo pipefail

source "$(dirname "$0")/.env.local"

REGISTRY="${ACR_REGISTRY}"
REMOTE_DIR="/opt/teamclaw"
CADDYFILE="/home/admin/Caddyfile"

SSH="sshpass -p $ECS_PASSWORD ssh -p $ECS_PORT -o StrictHostKeyChecking=no $ECS_USER@$ECS_HOST"
SCP="sshpass -p $ECS_PASSWORD scp -P $ECS_PORT -o StrictHostKeyChecking=no"

echo "→ 同步 deploy/ 文件到 ECS..."
$SSH "mkdir -p $REMOTE_DIR"
$SCP deploy/docker-compose.yml "$ECS_USER@$ECS_HOST:$REMOTE_DIR/"

echo "→ 远程部署..."
$SSH bash << EOF
set -e
cd $REMOTE_DIR

# 写入 .env
cat > .env << 'ENVEOF'
SEED_API_KEY=$SEED_API_KEY
ENVEOF

# 登录 ACR
echo "$ACR_PASSWORD" | docker login --username="$ACR_USERNAME" --password-stdin $REGISTRY

# 停掉旧的失败容器（如有）
docker compose down 2>/dev/null || true

# 拉取并启动
docker compose pull seed
docker compose up -d
docker compose ps

# 等 seed 启动
sleep 3
docker compose logs seed --tail=5
EOF

echo "→ 更新 Caddy 配置..."
$SSH bash << 'EOF'
# 检查是否已有 ai.ucar.cc 配置
if grep -q "ai.ucar.cc" /home/admin/Caddyfile; then
  echo "Caddyfile 已有 ai.ucar.cc，跳过"
else
  cat >> /home/admin/Caddyfile << 'CADDY'

ai.ucar.cc {
    reverse_proxy teamclaw-seed-1:9090
}
CADDY
  echo "已追加 ai.ucar.cc 路由"
fi

# 重新加载 Caddy
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
echo "✓ Caddy 已重载"
EOF

echo "✓ 部署完成"
