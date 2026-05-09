use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebouncedEventKind};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// File change event sent to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String, // "create", "modify", "remove", "rename", "any"
}

/// State for managing file watchers
pub struct FileWatcherState {
    watchers: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

struct WatcherHandle {
    /// Keep the debouncer alive so the watcher keeps running.
    /// Dropping this stops the watcher.
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
    /// Window labels currently subscribed to this path. The watcher is dropped
    /// only when the last subscriber unwatches — so closing window A doesn't
    /// kill window B's watcher when both watch the same workspace tree.
    subscribers: HashSet<String>,
}

impl Default for FileWatcherState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Start watching a directory for file changes on behalf of the calling window.
///
/// If another window is already watching this path, the existing debouncer
/// is reused and the calling window's label is added as a subscriber. The
/// watcher is only torn down when the last subscriber unwatches.
#[tauri::command]
pub async fn watch_directory(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    path: String,
) -> Result<bool, String> {
    let label = window.label().to_string();
    let mut watchers = state.watchers.lock().await;

    if let Some(handle) = watchers.get_mut(&path) {
        handle.subscribers.insert(label);
        return Ok(true);
    }

    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let app_handle = app.clone();

    // Create a debounced watcher with 500ms delay to batch rapid changes.
    //
    // The debouncer callback is synchronous and broadcasts the file-change
    // event to every window. Per-window routing would require locking the
    // subscribers map from inside the callback (tokio::Mutex needs an async
    // context), and the frontend already filters by `path.startsWith(workspacePath)`
    // for the file tree. The broadcast cost is small and acceptable.
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            match result {
                Ok(events) => {
                    for event in events {
                        let kind = match event.kind {
                            DebouncedEventKind::Any => "any",
                            DebouncedEventKind::AnyContinuous => "any",
                            _ => "any",
                        };

                        let change_event = FileChangeEvent {
                            path: event.path.to_string_lossy().to_string(),
                            kind: kind.to_string(),
                        };

                        if let Err(e) = app_handle.emit("file-change", change_event) {
                            eprintln!("[FileWatcher] Failed to emit event: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[FileWatcher] Watch error: {:?}", e);
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    println!("[FileWatcher] Started watching: {} (subscriber: {})", path, label);

    let mut subscribers = HashSet::new();
    subscribers.insert(label);
    watchers.insert(
        path,
        WatcherHandle {
            _debouncer: debouncer,
            subscribers,
        },
    );

    Ok(true)
}

/// Stop watching a directory on behalf of the calling window.
///
/// Decrements the subscriber set for the path. Only when the last subscriber
/// unwatches is the underlying debouncer dropped. Returns `true` if the path
/// was being watched (regardless of whether the watcher was actually stopped).
#[tauri::command]
pub async fn unwatch_directory(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    path: String,
) -> Result<bool, String> {
    let label = window.label();
    let mut watchers = state.watchers.lock().await;

    let Some(handle) = watchers.get_mut(&path) else {
        return Ok(false);
    };

    handle.subscribers.remove(label);
    if handle.subscribers.is_empty() {
        watchers.remove(&path);
        println!("[FileWatcher] Stopped watching: {} (last subscriber gone)", path);
    } else {
        println!(
            "[FileWatcher] Unsubscribed {} from {}; {} subscriber(s) remain",
            label,
            path,
            handle.subscribers.len()
        );
    }
    Ok(true)
}

/// Stop watching every directory the calling window has subscribed to.
///
/// Removes the calling window's label from every watcher. Watchers with no
/// remaining subscribers are dropped. Other windows' subscriptions are
/// preserved — this is what fixes the cross-window unwatch bug.
#[tauri::command]
pub async fn unwatch_all(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), String> {
    let label = window.label();
    let mut watchers = state.watchers.lock().await;

    let mut paths_to_drop: Vec<String> = Vec::new();
    for (path, handle) in watchers.iter_mut() {
        if handle.subscribers.remove(label) && handle.subscribers.is_empty() {
            paths_to_drop.push(path.clone());
        }
    }
    let dropped = paths_to_drop.len();
    for path in paths_to_drop {
        watchers.remove(&path);
    }
    println!(
        "[FileWatcher] Unsubscribed {} from all watchers; {} watcher(s) dropped",
        label, dropped
    );
    Ok(())
}

/// Get list of currently watched directories.
#[tauri::command]
pub async fn get_watched_directories(
    state: tauri::State<'_, FileWatcherState>,
) -> Result<Vec<String>, String> {
    let watchers = state.watchers.lock().await;
    Ok(watchers.keys().cloned().collect())
}
