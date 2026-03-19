#!/usr/bin/env bash
# 一键提交流程：总结变更 → 切分支 → 提交 → 推送到 origin → 创建 PR
# 若配置了 upstream 远程，则 PR 创建到 upstream 仓库（head=origin 的当前分支 → base=main）；
# 否则 PR 创建在 origin 仓库。
# 用法:
#   pnpm ship                    # 交互式：显示变更并提示输入提交说明和分支名
#   pnpm ship "提交说明"          # 用说明提交，分支名自动生成
#   pnpm ship "提交说明" feat/xxx # 指定提交说明和分支名
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 颜色输出
red() { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

# 检查是否在 git 仓库
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  red "错误: 当前目录不是 git 仓库"
  exit 1
fi

# 检查是否有未提交的变更（包括未暂存）
if git diff --quiet && git diff --cached --quiet; then
  red "没有可提交的变更。请先修改文件后再运行。"
  exit 1
fi

# 当前分支
CURRENT_BRANCH="$(git branch --show-current)"
BASE_BRANCH="${SHIP_PR_BASE:-main}"

# 显示本次变更摘要
echo ""
green "========== 本次变更摘要 =========="
git status -sb
echo ""
dim "--- 文件变更统计 ---"
git diff --stat
git diff --cached --stat 2>/dev/null || true
echo ""
yellow "=========================================="

# 获取提交说明：第一个参数或交互输入
if [ -n "${1:-}" ]; then
  COMMIT_MSG="$1"
  green "使用提交说明: $COMMIT_MSG"
else
  echo ""
  printf "请输入本次提交说明 (必填): "
  read -r COMMIT_MSG
  if [ -z "$COMMIT_MSG" ]; then
    red "提交说明不能为空"
    exit 1
  fi
fi

# 生成或获取分支名
# 从提交说明生成简短 slug：转小写、空格换横线、只保留字母数字横线、截断
slug() {
  local s
  s="$(echo "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9 -]//g' | tr -s ' ' '-' | cut -c1-50)"
  if [ -z "$s" ] || [ "$s" = "-" ]; then
    echo "update-$(date +%Y%m%d-%H%M)"
  else
    echo "$s"
  fi
}

if [ -n "${2:-}" ]; then
  BRANCH_NAME="$2"
  green "使用分支: $BRANCH_NAME"
else
  # 若当前已在非 main 分支且没有指定分支，询问是否继续用当前分支
  if [ "$CURRENT_BRANCH" != "$BASE_BRANCH" ]; then
    echo ""
    printf "当前在分支 '%s'，是否直接在此分支提交? [Y/n]: " "$CURRENT_BRANCH"
    read -r use_current
    if [ -z "$use_current" ] || [ "$use_current" = "y" ] || [ "$use_current" = "Y" ]; then
      BRANCH_NAME="$CURRENT_BRANCH"
      green "使用当前分支: $BRANCH_NAME"
    else
      BRANCH_NAME="feat/$(slug "$COMMIT_MSG")"
      green "新建分支: $BRANCH_NAME"
    fi
  else
    BRANCH_NAME="feat/$(slug "$COMMIT_MSG")"
    green "新建分支: $BRANCH_NAME"
  fi
fi

# 若需要切分支且不在目标分支
if [ "$(git branch --show-current)" != "$BRANCH_NAME" ]; then
  if git show-ref --quiet "refs/heads/$BRANCH_NAME"; then
    yellow "检出已存在的分支: $BRANCH_NAME"
    git checkout "$BRANCH_NAME"
  else
    green "创建并检出分支: $BRANCH_NAME"
    git checkout -b "$BRANCH_NAME"
  fi
fi

# 暂存所有变更（等同 git add -A）
green "暂存所有变更..."
git add -A

# 提交
green "提交..."
git commit -m "$COMMIT_MSG"

# 推送并设置上游
green "推送到 origin/$BRANCH_NAME ..."
git push -u origin "$BRANCH_NAME"

# 使用 GitHub CLI 创建 PR
# 若配置了 upstream 远程，则向 upstream 仓库提 PR（head = origin 的当前分支）；否则向 origin 提 PR
if command -v gh >/dev/null 2>&1; then
  echo ""
  # 解析 owner/repo：支持 https 与 git@ 两种 URL
  parse_owner_repo() { git remote get-url "$1" 2>/dev/null | sed -E 's|.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$|\1|'; }
  UPSTREAM_REPO=""
  ORIGIN_REPO="$(parse_owner_repo origin)"
  if git remote get-url upstream >/dev/null 2>&1; then
    UPSTREAM_REPO="$(parse_owner_repo upstream)"
  fi

  if [ -n "$UPSTREAM_REPO" ] && [ "$UPSTREAM_REPO" != "$ORIGIN_REPO" ]; then
    # 向 upstream 提 PR：head 为 origin 的 owner:分支名
    ORIGIN_OWNER="${ORIGIN_REPO%/*}"
    green "创建 Pull Request 到 upstream ($UPSTREAM_REPO) 的 $BASE_BRANCH ..."
    if gh pr create --repo "$UPSTREAM_REPO" --head "${ORIGIN_OWNER}:${BRANCH_NAME}" --base "$BASE_BRANCH" --title "$COMMIT_MSG" --body "## 变更说明

$COMMIT_MSG"; then
      green "PR 已创建。"
    else
      yellow "创建 PR 失败或已取消，请到 GitHub 手动创建 PR。"
      echo "  https://github.com/${UPSTREAM_REPO}/compare/${BASE_BRANCH}...${ORIGIN_OWNER}:${BRANCH_NAME}"
    fi
  else
    # 无 upstream 或与 origin 相同：在当前仓库创建 PR
    green "创建 Pull Request 到 $BASE_BRANCH ..."
    if gh pr create --base "$BASE_BRANCH" --title "$COMMIT_MSG" --body "## 变更说明

$COMMIT_MSG"; then
      green "PR 已创建。"
    else
      yellow "创建 PR 失败或已取消，请到 GitHub 手动创建 PR。"
      echo "  https://github.com/${ORIGIN_REPO}/compare/${BASE_BRANCH}...${BRANCH_NAME}"
    fi
  fi
else
  yellow "未安装 gh (GitHub CLI)，请到 GitHub 仓库页面手动创建 PR。"
  _url="$(git remote get-url origin 2>/dev/null)"
  _origin_repo="$(echo "$_url" | sed -E 's|.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$|\1|')"
  _origin_owner="${_origin_repo%/*}"
  if git remote get-url upstream >/dev/null 2>&1; then
    _upstream_repo="$(git remote get-url upstream | sed -E 's|.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$|\1|')"
    echo "  https://github.com/${_upstream_repo}/compare/${BASE_BRANCH}...${_origin_owner}:${BRANCH_NAME}"
  else
    echo "  https://github.com/${_origin_repo}/compare/${BASE_BRANCH}...${BRANCH_NAME}"
  fi
fi

green "完成。"
