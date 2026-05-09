use std::path::{Component, Path, PathBuf};

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceDirectoryEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("Path must be absolute: {}", path.display()));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("Path escapes root: {}", path.display()));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }

    Ok(normalized)
}

fn resolve_workspace_view_path(workspace_path: &str, path: &str) -> Result<PathBuf, String> {
    let normalized_workspace = normalize_absolute_path(Path::new(workspace_path))?;
    let normalized_target = normalize_absolute_path(Path::new(path))?;

    if !normalized_target.starts_with(&normalized_workspace) {
        return Err(format!(
            "Path is outside workspace view: {}",
            normalized_target.display()
        ));
    }

    Ok(normalized_target)
}

#[tauri::command]
pub fn read_workspace_directory(
    workspace_path: String,
    path: String,
) -> Result<Vec<WorkspaceDirectoryEntry>, String> {
    let target = resolve_workspace_view_path(&workspace_path, &path)?;
    let entries = std::fs::read_dir(&target)
        .map_err(|e| format!("Failed to read directory '{}': {}", target.display(), e))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to read directory entry in '{}': {}",
                target.display(),
                e
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = target.join(&name);
        let metadata = std::fs::metadata(&entry_path)
            .or_else(|_| std::fs::symlink_metadata(&entry_path))
            .map_err(|e| format!("Failed to read metadata '{}': {}", entry_path.display(), e))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };

        result.push(WorkspaceDirectoryEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            kind: kind.to_string(),
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn read_workspace_text_file(workspace_path: String, path: String) -> Result<String, String> {
    let target = resolve_workspace_view_path(&workspace_path, &path)?;
    std::fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read text file '{}': {}", target.display(), e))
}

#[tauri::command]
pub fn read_workspace_binary_file(workspace_path: String, path: String) -> Result<Vec<u8>, String> {
    let target = resolve_workspace_view_path(&workspace_path, &path)?;
    std::fs::read(&target)
        .map_err(|e| format!("Failed to read binary file '{}': {}", target.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_workspace_view() {
        let workspace = "/tmp/workspace";
        let result = read_workspace_directory(workspace.to_string(), "/tmp/other".to_string());

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("outside workspace view"));
    }

    #[cfg(unix)]
    #[test]
    fn lists_files_inside_symlinked_directory_using_view_path() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("README.md"), "linked content").unwrap();
        symlink(external.path(), workspace.path().join("linked-dir")).unwrap();

        let entries = read_workspace_directory(
            workspace.path().to_string_lossy().to_string(),
            workspace
                .path()
                .join("linked-dir")
                .to_string_lossy()
                .to_string(),
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "README.md");
        assert_eq!(entries[0].kind, "file");
        assert_eq!(
            entries[0].path,
            workspace
                .path()
                .join("linked-dir")
                .join("README.md")
                .to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlinked_directory_entries_as_directories() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        symlink(external.path(), workspace.path().join("linked-dir")).unwrap();

        let entries = read_workspace_directory(
            workspace.path().to_string_lossy().to_string(),
            workspace.path().to_string_lossy().to_string(),
        )
        .unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "linked-dir");
        assert_eq!(entries[0].kind, "directory");
    }
}
