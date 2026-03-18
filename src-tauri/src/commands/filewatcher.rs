use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebouncedEventKind};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    // We keep the debouncer alive by storing it
    // When dropped, the watcher stops
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

impl Default for FileWatcherState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Start watching a directory for file changes
#[tauri::command]
pub async fn watch_directory(
    app: AppHandle,
    state: tauri::State<'_, FileWatcherState>,
    path: String,
) -> Result<bool, String> {
    let mut watchers = state.watchers.lock().await;
    
    // If already watching this path, return success
    if watchers.contains_key(&path) {
        return Ok(true);
    }
    
    let watch_path = PathBuf::from(&path);
    if !watch_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    let app_handle = app.clone();
    let path_clone = path.clone();
    
    // Create a debounced watcher with 500ms delay to batch rapid changes
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |result: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
            match result {
                Ok(events) => {
                    for event in events {
                        let kind = match event.kind {
                            DebouncedEventKind::Any => "any",
                            DebouncedEventKind::AnyContinuous => "any",
                            _ => "any", // Handle any future variants
                        };
                        
                        let change_event = FileChangeEvent {
                            path: event.path.to_string_lossy().to_string(),
                            kind: kind.to_string(),
                        };
                        
                        // Emit event to frontend
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
    ).map_err(|e| format!("Failed to create watcher: {}", e))?;
    
    // Start watching the directory recursively
    debouncer
        .watcher()
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;
    
    println!("[FileWatcher] Started watching: {}", path);
    
    watchers.insert(path_clone, WatcherHandle { _debouncer: debouncer });
    
    Ok(true)
}

/// Stop watching a directory
#[tauri::command]
pub async fn unwatch_directory(
    state: tauri::State<'_, FileWatcherState>,
    path: String,
) -> Result<bool, String> {
    let mut watchers = state.watchers.lock().await;
    
    if watchers.remove(&path).is_some() {
        println!("[FileWatcher] Stopped watching: {}", path);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Stop all watchers
#[tauri::command]
pub async fn unwatch_all(
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().await;
    let count = watchers.len();
    watchers.clear();
    println!("[FileWatcher] Stopped all {} watchers", count);
    Ok(())
}

/// Get list of currently watched directories
#[tauri::command]
pub async fn get_watched_directories(
    state: tauri::State<'_, FileWatcherState>,
) -> Result<Vec<String>, String> {
    let watchers = state.watchers.lock().await;
    Ok(watchers.keys().cloned().collect())
}
