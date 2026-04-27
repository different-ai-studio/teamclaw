use std::path::Path;

const TRASH_DIR: &str = ".trash";
const MAX_TRASH_VERSIONS: usize = 5;

/// Move a file to `.trash/<rel_path>.<timestamp>` inside `team_dir` before deleting/overwriting.
pub fn trash_file(team_dir: &Path, rel_path: &str) -> Result<(), String> {
    let src = team_dir.join(rel_path);
    if !src.exists() || !src.is_file() {
        return Ok(());
    }

    let trash_dest = team_dir.join(TRASH_DIR).join(rel_path);
    if let Some(parent) = trash_dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create trash dir {}: {e}", parent.display()))?;
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let versioned = format!("{}.{}", trash_dest.display(), timestamp);

    std::fs::copy(&src, &versioned)
        .map_err(|e| format!("Failed to copy {} to trash: {e}", src.display()))?;

    // Prune old versions of this file
    prune_old_versions(&trash_dest, MAX_TRASH_VERSIONS);

    Ok(())
}

/// Keep only the newest `max` versions of a trashed file.
fn prune_old_versions(base_path: &Path, max: usize) {
    let Some(parent) = base_path.parent() else {
        return;
    };
    let Some(file_name) = base_path.file_name().and_then(|n| n.to_str()) else {
        return;
    };

    let prefix = format!("{}.", file_name);
    let mut versions: Vec<_> = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();

    if versions.len() <= max {
        return;
    }

    // Sort by modified time, newest first
    versions.sort_by(|a, b| {
        let ta = a
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let tb = b
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        tb.cmp(&ta)
    });

    for old in &versions[max..] {
        let _ = std::fs::remove_file(old.path());
    }
}
