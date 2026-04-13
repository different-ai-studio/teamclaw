use std::path::{Component, Path, PathBuf};

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
