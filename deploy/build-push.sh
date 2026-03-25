#!/usr/bin/env bash
# 本地执行：把 seed crate 传到 ECS，在 ECS 上原生编译 + 推送到 ACR
# 用法：从仓库根目录执行  bash deploy/build-push.sh
set -euo pipefail

source "$(dirname "$0")/.env.local"

IMAGE="${ACR_IMAGE}"
REGISTRY="${ACR_REGISTRY}"
REMOTE_BUILD_DIR="/opt/teamclaw-build"

ssh_cmd() {
  sshpass -p "$ECS_PASSWORD" ssh -p "$ECS_PORT" -o StrictHostKeyChecking=no \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=20 \
    "$ECS_USER@$ECS_HOST" "$@"
}

echo "→ 同步 seed crate 到 ECS（排除 target/）..."
ssh_cmd "mkdir -p $REMOTE_BUILD_DIR"
tar -czf - --exclude='./target' --exclude='./.git' -C crates/teamclaw-seed . | \
  sshpass -p "$ECS_PASSWORD" ssh -p "$ECS_PORT" -o StrictHostKeyChecking=no \
    "$ECS_USER@$ECS_HOST" "tar -xzf - -C $REMOTE_BUILD_DIR"

echo "→ 配置 Docker 镜像加速（只需一次）..."
ssh_cmd bash << 'SETUP'
set -e
if ! grep -q "registry-mirrors" /etc/docker/daemon.json 2>/dev/null; then
  mkdir -p /etc/docker
  printf '{\n  "registry-mirrors": ["https://registry.cn-hangzhou.aliyuncs.com"]\n}\n' > /etc/docker/daemon.json
  systemctl reload docker 2>/dev/null || systemctl restart docker
  echo "Docker 加速已配置"
fi
SETUP

echo "→ 在 ECS 后台启动 build（避免 SSH 超时）..."
ssh_cmd "
  echo '$ACR_PASSWORD' | docker login --username="$ACR_USERNAME" --password-stdin $REGISTRY 2>&1
  nohup docker build -t $IMAGE $REMOTE_BUILD_DIR/ > /tmp/docker-build.log 2>&1 &
  BUILD_PID=\$!
  echo \"Build PID: \$BUILD_PID\"
"

echo "→ 等待 ECS 上的 build 完成（每30秒检查一次）..."
while true; do
  sleep 30
  STATUS=$(ssh_cmd "
    if docker images $IMAGE --format '{{.CreatedSince}}' 2>/dev/null | grep -E 'seconds|minute' ; then
      echo 'IMAGE_READY'
    elif pgrep -f 'docker build' > /dev/null; then
      tail -3 /tmp/docker-build.log 2>/dev/null
      echo 'BUILDING'
    else
      tail -10 /tmp/docker-build.log 2>/dev/null
      echo 'DONE_OR_FAILED'
    fi
  " 2>/dev/null || echo "SSH_ERROR")

  echo "  状态: $STATUS"

  if echo "$STATUS" | grep -q "IMAGE_READY\|DONE_OR_FAILED"; then
    break
  fi
done

echo "→ 检查 build 结果..."
BUILD_LOG=$(ssh_cmd "tail -5 /tmp/docker-build.log 2>/dev/null")
echo "$BUILD_LOG"

if echo "$BUILD_LOG" | grep -q "Successfully built\|naming to"; then
  echo "→ 推送镜像到 ACR..."
  ssh_cmd "echo '$ACR_PASSWORD' | docker login --username="$ACR_USERNAME" --password-stdin $REGISTRY && docker push $IMAGE"
  echo "✓ 推送完成: $IMAGE"
else
  echo "✗ Build 失败，查看完整日志："
  ssh_cmd "cat /tmp/docker-build.log" 2>/dev/null
  exit 1
fi
