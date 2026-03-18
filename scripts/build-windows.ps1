# Windows 打包脚本：安装依赖、下载 OpenCode（如缺失）、构建 Tauri NSIS 安装包
# 在项目根目录执行: .\scripts\build-windows.ps1
#
# 若出现 bindgen "拒绝访问" (Access denied)，可尝试：
# - 以管理员身份运行 PowerShell 再执行本脚本
# - 临时关闭杀毒/实时保护后重试
# - 或直接使用: pnpm tauri build --bundles nsis -- -- --no-default-features

$ErrorActionPreference = "Stop"
$RepoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
    $RepoRoot = (Get-Location).Path
}
Set-Location $RepoRoot

$BinariesDir = Join-Path $RepoRoot "src-tauri\binaries"
$OpencodeWin = Join-Path $BinariesDir "opencode-x86_64-pc-windows-msvc.exe"

Write-Host "[build-windows] Repo root: $RepoRoot" -ForegroundColor Cyan

# 1. 安装依赖
Write-Host "[build-windows] Installing dependencies (pnpm install)..." -ForegroundColor Cyan
& pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

# 2. OpenCode 二进制（Tauri externalBin 需要）
if (-not (Test-Path $OpencodeWin)) {
    Write-Host "[build-windows] OpenCode binary not found. Running download-opencode.ps1 ..." -ForegroundColor Yellow
    $DownloadScript = Join-Path $BinariesDir "download-opencode.ps1"
    if (Test-Path $DownloadScript) {
        & $DownloadScript
        if ($LASTEXITCODE -ne 0) { throw "download-opencode.ps1 failed" }
    } else {
        Write-Host "[build-windows] Warning: download-opencode.ps1 not found. Run: pnpm update-opencode (or place opencode-x86_64-pc-windows-msvc.exe in src-tauri/binaries/)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[build-windows] OpenCode binary present: $OpencodeWin" -ForegroundColor Green
}

# 3. 构建 Tauri（Windows 使用 --no-default-features 避免 wmi 冲突）
# 本地打包不生成更新器签名产物，避免未设置 TAURI_SIGNING_PRIVATE_KEY 时报错
Write-Host "[build-windows] Building Tauri app (NSIS installer, no p2p)..." -ForegroundColor Cyan
$tempConfig = Join-Path $env:TEMP "tauri-build-config-$(Get-Random).json"
@'
{"bundle": {"createUpdaterArtifacts": false}}
'@ | Set-Content -Path $tempConfig -Encoding UTF8 -NoNewline
try {
    & pnpm tauri build --bundles nsis --config $tempConfig -- -- --no-default-features
} finally {
    if (Test-Path $tempConfig) { Remove-Item $tempConfig -Force }
}
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$NsisDir = Join-Path $RepoRoot "src-tauri\target\release\bundle\nsis"
$MsiDir  = Join-Path $RepoRoot "src-tauri\target\release\bundle\msi"
Write-Host ""
Write-Host "[build-windows] Build completed." -ForegroundColor Green
if (Test-Path $NsisDir) {
    Get-ChildItem $NsisDir -Filter "*.exe" | ForEach-Object {
        Write-Host "  NSIS installer: $($_.FullName)" -ForegroundColor Green
    }
}
if (Test-Path $MsiDir) {
    Get-ChildItem $MsiDir -Filter "*.msi" | ForEach-Object {
        Write-Host "  MSI installer:  $($_.FullName)" -ForegroundColor Green
    }
}
