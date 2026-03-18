# Kill OpenCode / Teamclaw processes that may lock sidecar binaries in target/
# so that "tauri dev" or "tauri build" can overwrite them (avoids "拒绝访问").
# Run from repo root: .\scripts\kill-opencode-for-build.ps1
# Or before dev: .\scripts\kill-opencode-for-build.ps1; pnpm tauri:dev:win

$ErrorActionPreference = "Stop"
$RepoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { Get-Location }
if (-not (Test-Path (Join-Path $RepoRoot "src-tauri\target"))) {
    Write-Host "[kill-opencode] No src-tauri\target found, skipping."
    exit 0
}
$TargetDir = (Resolve-Path (Join-Path $RepoRoot "src-tauri\target")).Path

$script:killed = 0
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $exe = $_.ExecutablePath
    if (-not $exe) { return $false }
    $name = [System.IO.Path]::GetFileName($exe)
    if ($name -notlike "opencode*" -and $name -ne "teamclaw.exe") { return $false }
    try {
        $fullPath = $exe
        if (Test-Path $exe) { $fullPath = (Resolve-Path $exe -ErrorAction Stop).Path }
        $fullPath -like "$TargetDir*"
    } catch {
        $exe -like "$TargetDir*"
    }
} | ForEach-Object {
    Write-Host "[kill-opencode] Stopping: $($_.Name) (PID $($_.ProcessId))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $script:killed++
}

if ($script:killed -eq 0) {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like "opencode*" -or $_.Name -eq "teamclaw"
    } | Where-Object {
        try {
            $path = $_.Path
            $path -and $path -like "$TargetDir*"
        } catch { $false }
    } | ForEach-Object {
        Write-Host "[kill-opencode] Stopping: $($_.Name) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        $script:killed++
    }
}

$killed = $script:killed

if ($script:killed -gt 0) {
    Write-Host "[kill-opencode] Stopped $killed process(es). You can run pnpm tauri:dev:win now."
} else {
    Write-Host "[kill-opencode] No matching processes under target. If build still fails with 拒绝访问, close the app and run: Remove-Item -Recurse -Force src-tauri\target\debug\build\teamclaw-*"
}
