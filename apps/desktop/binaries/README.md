# TeamClaw 二进制文件

此目录包含 Tauri sidecar 二进制文件。

| 文件 | 用途 |
|------|------|
| `teamclaw-introspect-<target>` | TeamClaw introspect sidecar（用于运行时自省） |

`<target>` 为 Rust target triple，例如 `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc`（Windows 下带 `.exe`）。

## 命名约定

```
<服务名>-<target-triple>
```

Windows 下为 `<服务名>-<target-triple>.exe`。
