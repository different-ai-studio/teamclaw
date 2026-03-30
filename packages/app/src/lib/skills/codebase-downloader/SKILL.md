---
name: codebase-downloader
description: 自动从 HTTP 链接下载代码包并解压到 workspace。当用户提供代码包下载链接、需要获取外部代码库、或想要下载并解压代码项目时使用此 skill。支持 zip、tar.gz 等多种压缩格式，会自动解压到 codebase 目录并创建 AGENTS.md 指引文件。默认使用预设链接，也支持用户提供自定义链接。
---

# Codebase Downloader

这个 skill 用于自动下载并解压代码包到当前 workspace。

## 默认配置

**默认下载链接**: `https://git.garena.com/shopee/pl/accounting/accounting-huge-project/-/archive/master/accounting-huge-project-master.zip`

如果用户没有提供链接，将使用此默认链接。

## 使用场景

- 用户提供代码包下载链接，需要下载并解压
- 需要从外部源获取代码库到本地 workspace
- 需要快速 setup 一个代码环境进行检索或开发
- **用户只说"下载代码包"或类似请求但没提供链接时，直接使用默认链接下载，不要询问**

## 使用方法

用户可以说：

- "下载代码包"（**直接使用默认链接，不询问**）
- "下载这个代码包：https://example.com/code.zip"（使用提供的链接）
- "帮我从 [链接] 下载代码并解压"（使用提供的链接）
- "我需要下载代码库到 workspace"（**直接使用默认链接，不询问**）

**核心原则：只要用户没有明确提供具体链接，就直接使用默认链接开始下载。**

## 执行步骤

当用户请求下载代码包时，按以下步骤执行：

**重要：如果用户没有提供下载链接，直接使用默认链接开始下载，不要询问用户。**

### 1. 确认下载链接

从用户消息中提取 URL。如果用户没有提供链接，**直接使用默认链接，不要询问**：

```
https://git.garena.com/shopee/pl/accounting/accounting-huge-project/-/archive/master/accounting-huge-project-master.zip
```

### 2. 下载压缩包

使用 curl 下载文件到临时目录：

```bash
cd /tmp
curl -L -o codebase-archive.zip "<URL>"
```

如果 curl 不可用，使用 wget：

```bash
cd /tmp
wget -O codebase-archive.zip "<URL>"
```

### 3. 创建 codebase 目录并解压

```bash
# 回到 workspace
cd <workspace_dir>

# 创建 codebase 目录
mkdir -p codebase

# 根据文件类型解压
# 如果是 .zip
unzip -o /tmp/codebase-archive.zip -d codebase

# 如果是 .tar.gz
tar -xzf /tmp/codebase-archive.zip -C codebase

# 如果是 .tar
tar -xf /tmp/codebase-archive.zip -C codebase
```

### 4. 创建 AGENTS.md

**浏览 codebase 目录结构并根据实际内容个性化生成 AGENTS.md 导航文件到 workspace 根目录（而不是 codebase 目录下），帮助检索和理解项目。**

### 5. 清理临时文件

```bash
rm -f /tmp/codebase-archive.zip
```

### 6. 报告完成

告知用户：

- 下载已完成
- 代码已解压到 `codebase/` 目录
- 可以在该目录下检索需要的信息

## 注意事项

- 确保下载链接是公开可访问的
- 如果压缩包有密码，需要用户提供
- 下载大文件时可能需要较长时间
- 会覆盖已存在的 `codebase/` 目录内容（如有冲突会提示）
- **默认链接可能需要 GitLab 认证**，如果是私有仓库请确保有访问权限

## 支持的压缩格式

- `.zip` - 使用 `unzip` 命令
- `.tar.gz` / `.tgz` - 使用 `tar -xzf`
- `.tar` - 使用 `tar -xf`
- `.rar` - 需要安装 `unrar` 命令
- `.7z` - 需要安装 `7z` 命令
