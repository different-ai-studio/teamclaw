use anyhow::{Context, Result};
use notify_debouncer_full::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode, Watcher},
    DebounceEventResult, Debouncer, FileIdMap,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::rag::indexer::Indexer;

pub struct KnowledgeWatcher {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    _knowledge_dirs: Vec<PathBuf>,
}

impl KnowledgeWatcher {
    /// Start watching multiple knowledge directories for file changes
    pub fn watch(knowledge_dirs: Vec<PathBuf>, indexer: Arc<Indexer>) -> Result<Self> {
        if knowledge_dirs.is_empty() {
            anyhow::bail!("No knowledge directories provided");
        }

        // Ensure all directories exist
        for knowledge_dir in &knowledge_dirs {
            if !knowledge_dir.exists() {
                std::fs::create_dir_all(&knowledge_dir)
                    .with_context(|| format!("Failed to create knowledge directory: {:?}", knowledge_dir))?;
            }
        }

        // Create a channel for file change events
        let (tx, mut rx) = mpsc::unbounded_channel();

        // Create debouncer with 500ms delay
        let mut debouncer = new_debouncer(
            Duration::from_millis(500),
            None,
            move |result: DebounceEventResult| {
                if let Err(e) = tx.send(result) {
                    tracing::error!("Failed to send file event: {}", e);
                }
            },
        )
        .context("Failed to create file watcher")?;

        // Watch all knowledge directories
        for knowledge_dir in &knowledge_dirs {
            debouncer
                .watcher()
                .watch(&knowledge_dir, RecursiveMode::Recursive)
                .with_context(|| format!("Failed to watch knowledge directory: {:?}", knowledge_dir))?;
            tracing::info!("File watcher started for {:?}", knowledge_dir);
        }

        // Spawn a task to handle file events
        let knowledge_dirs_clone = knowledge_dirs.clone();
        tokio::spawn(async move {
            while let Some(result) = rx.recv().await {
                match result {
                    Ok(events) => {
                        for event in events {
                            if let Err(e) =
                                handle_file_event(&indexer, &knowledge_dirs_clone, &event).await
                            {
                                tracing::error!("Failed to handle file event: {}", e);
                            }
                        }
                    }
                    Err(errors) => {
                        for error in errors {
                            tracing::error!("File watch error: {}", error);
                        }
                    }
                }
            }
            tracing::info!("File watcher stopped");
        });

        Ok(Self {
            _debouncer: debouncer,
            _knowledge_dirs: knowledge_dirs,
        })
    }
}

/// Handle a file system event
async fn handle_file_event(
    indexer: &Indexer,
    knowledge_dirs: &[PathBuf],
    event: &notify_debouncer_full::DebouncedEvent,
) -> Result<()> {
    use notify_debouncer_full::notify::EventKind;

    // Get the affected path
    let paths = &event.event.paths;
    if paths.is_empty() {
        return Ok(());
    }

    let path = &paths[0];

    // Skip hidden files and directories
    if is_hidden(path) {
        return Ok(());
    }

    // Only process supported file types
    if path.is_file() && !is_supported_file(path) {
        return Ok(());
    }

    // Find which knowledge directory this path belongs to
    let knowledge_dir = knowledge_dirs
        .iter()
        .find(|dir| path.starts_with(dir))
        .context("Path is not in any knowledge directory")?;

    match event.event.kind {
        EventKind::Create(_) | EventKind::Modify(_) => {
            if path.is_file() {
                tracing::info!("File changed, re-indexing: {:?}", path);
                
                // Get relative path
                let relative_path = path
                    .strip_prefix(knowledge_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();

                // Index the single file
                if let Err(e) = indexer.index_directory(Some(&relative_path)).await {
                    tracing::error!("Failed to index file {:?}: {}", path, e);
                }
            } else if path.is_dir() {
                // Directory created, scan it
                tracing::info!("Directory changed, re-indexing: {:?}", path);
                let relative_path = path
                    .strip_prefix(knowledge_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();

                if let Err(e) = indexer.index_directory(Some(&relative_path)).await {
                    tracing::error!("Failed to index directory {:?}: {}", path, e);
                }
            }
        }
        EventKind::Remove(_) => {
            if path.is_file() || !path.exists() {
                // File was deleted, remove from index immediately
                let relative_path = path
                    .strip_prefix(knowledge_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string();

                tracing::info!("File removed, deleting from index: {:?}", path);
                if let Err(e) = indexer.delete_file(&relative_path).await {
                    tracing::error!("Failed to delete file from index: {}", e);
                }
            } else if path.is_dir() {
                // Directory was deleted - we could batch delete all files in that directory
                // For now, log it (cleanup will happen on next full index)
                tracing::info!("Directory removed: {:?}", path);
            }
        }
        _ => {}
    }

    Ok(())
}

/// Check if a path is hidden (starts with .)
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

/// Check if a file has a supported extension
fn is_supported_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        matches!(ext.to_lowercase().as_str(), "md" | "txt" | "rs" | "ts" | "tsx" | "py")
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_hidden() {
        assert!(is_hidden(Path::new(".hidden")));
        assert!(is_hidden(Path::new("/path/to/.hidden")));
        assert!(!is_hidden(Path::new("visible.txt")));
        assert!(!is_hidden(Path::new("/path/to/visible.txt")));
    }

    #[test]
    fn test_is_supported_file() {
        assert!(is_supported_file(Path::new("test.md")));
        assert!(is_supported_file(Path::new("test.txt")));
        assert!(is_supported_file(Path::new("test.rs")));
        assert!(is_supported_file(Path::new("test.ts")));
        assert!(is_supported_file(Path::new("test.tsx")));
        assert!(is_supported_file(Path::new("test.py")));
        assert!(!is_supported_file(Path::new("test.pdf")));
        assert!(!is_supported_file(Path::new("test.jpg")));
    }
}
