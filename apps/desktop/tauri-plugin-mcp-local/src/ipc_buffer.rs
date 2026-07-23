//! Bounded in-memory ring buffer of recent Tauri IPC activity: `invoke()`
//! calls observed by the webview-side wrapper installed in
//! `listener_patch.js` (pushed here via the `push_ipc` Tauri command), and
//! events emitted through the `manage_ipc` tool. Queried by the
//! `manage_ipc` MCP tool so an LLM can see which commands the frontend
//! actually calls, with what outcome and latency.
//!
//! Entries carry a monotonic `id` so callers can paginate with `since_id`.
//! Oldest entries are dropped when full; `dropped_total` exposes gaps.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_CAPACITY: usize = 2000;
/// Preview strings (args/result/error) are capped to keep memory and
/// query responses bounded.
pub const MAX_PREVIEW_LEN: usize = 500;

fn origin_is_tool(origin: &str) -> bool {
    origin == "tool"
}

fn default_origin() -> String {
    "tool".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[non_exhaustive]
pub struct IpcEntry {
    pub id: u64,
    /// Milliseconds since UNIX epoch.
    pub ts: u64,
    /// "invoke" (webview → Rust command call) or "event" (emitted event).
    pub kind: String,
    /// Command name (e.g. "get_user", "plugin:dialog|open") or event name.
    pub name: String,
    /// "ok" | "error" | "emitted"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// "tool" (recorded by manage_ipc while mediating the IPC) or "webview"
    /// (self-reported by page JS via the push_ipc command — untrusted, since
    /// any script in the page can forge these).
    #[serde(
        skip_serializing_if = "origin_is_tool",
        default = "default_origin"
    )]
    pub origin: String,
}

#[derive(Debug, Default, Serialize)]
pub struct IpcCommandStat {
    pub name: String,
    pub count: u64,
    pub errors: u64,
    pub last_status: String,
    pub last_ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_duration_ms: Option<u64>,
}

pub struct IpcBuffer {
    entries: Mutex<VecDeque<IpcEntry>>,
    capacity: usize,
    next_id: AtomicU64,
    dropped_total: AtomicU64,
}

impl IpcBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
            next_id: AtomicU64::new(1),
            dropped_total: AtomicU64::new(0),
        }
    }

    /// Record an entry the plugin itself mediated (origin "tool").
    pub fn push(
        &self,
        kind: &str,
        name: String,
        status: &str,
        duration_ms: Option<u64>,
        args_preview: Option<String>,
        result_preview: Option<String>,
        error: Option<String>,
    ) -> u64 {
        self.push_with_origin("tool", kind, name, status, duration_ms, args_preview, result_preview, error)
    }

    /// Record an entry with an explicit origin ("tool" or "webview").
    #[allow(clippy::too_many_arguments)]
    pub fn push_with_origin(
        &self,
        origin: &str,
        kind: &str,
        name: String,
        status: &str,
        duration_ms: Option<u64>,
        args_preview: Option<String>,
        result_preview: Option<String>,
        error: Option<String>,
    ) -> u64 {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let cap = |s: Option<String>| {
            s.map(|v| {
                if v.len() > MAX_PREVIEW_LEN {
                    // Truncate on a char boundary
                    let mut end = MAX_PREVIEW_LEN;
                    while end > 0 && !v.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}…[truncated]", &v[..end])
                } else {
                    v
                }
            })
        };

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = IpcEntry {
            id,
            ts,
            kind: kind.to_string(),
            name,
            status: status.to_string(),
            duration_ms,
            args_preview: cap(args_preview),
            result_preview: cap(result_preview),
            error: cap(error),
            origin: origin.to_string(),
        };

        let mut guard = self.entries.lock();
        if guard.len() >= self.capacity {
            guard.pop_front();
            self.dropped_total.fetch_add(1, Ordering::Relaxed);
        }
        guard.push_back(entry);
        id
    }

    /// Query entries, newest-last, honoring optional filters.
    pub fn query(
        &self,
        kind: Option<&str>,
        name_contains: Option<&str>,
        status: Option<&str>,
        since_id: Option<u64>,
        limit: usize,
    ) -> (Vec<IpcEntry>, usize, u64) {
        let guard = self.entries.lock();
        let matches: Vec<&IpcEntry> = guard
            .iter()
            .filter(|e| kind.is_none_or(|k| e.kind == k))
            .filter(|e| {
                name_contains.is_none_or(|n| {
                    e.name.to_lowercase().contains(&n.to_lowercase())
                })
            })
            .filter(|e| status.is_none_or(|s| e.status == s))
            .filter(|e| since_id.is_none_or(|id| e.id > id))
            .collect();
        let total = matches.len();
        let entries = matches
            .into_iter()
            .rev()
            .take(limit)
            .rev()
            .cloned()
            .collect();
        (entries, total, self.dropped_total.load(Ordering::Relaxed))
    }

    /// Aggregate per-name stats over the buffered invoke entries. Used by
    /// the `commands` action to report which commands the frontend has
    /// actually called.
    pub fn command_stats(&self) -> Vec<IpcCommandStat> {
        let guard = self.entries.lock();
        let mut stats: std::collections::BTreeMap<String, (IpcCommandStat, u64, u64)> =
            std::collections::BTreeMap::new();
        for e in guard.iter().filter(|e| e.kind == "invoke") {
            let (stat, dur_sum, dur_count) =
                stats.entry(e.name.clone()).or_insert_with(|| {
                    (
                        IpcCommandStat {
                            name: e.name.clone(),
                            ..Default::default()
                        },
                        0,
                        0,
                    )
                });
            stat.count += 1;
            if e.status == "error" {
                stat.errors += 1;
            }
            stat.last_status = e.status.clone();
            stat.last_ts = e.ts;
            if let Some(d) = e.duration_ms {
                *dur_sum += d;
                *dur_count += 1;
            }
        }
        stats
            .into_values()
            .map(|(mut stat, dur_sum, dur_count)| {
                if dur_count > 0 {
                    stat.avg_duration_ms = Some(dur_sum / dur_count);
                }
                stat
            })
            .collect()
    }

    pub fn clear(&self) -> usize {
        let mut guard = self.entries.lock();
        let n = guard.len();
        guard.clear();
        n
    }
}

static GLOBAL: OnceLock<IpcBuffer> = OnceLock::new();

pub fn global() -> &'static IpcBuffer {
    GLOBAL.get_or_init(|| IpcBuffer::new(DEFAULT_CAPACITY))
}

/// Commands the app explicitly exposed via
/// `PluginConfig::expose_commands`, reported by the `commands` action
/// alongside observed traffic (Tauri has no public registry to enumerate
/// `#[tauri::command]` handlers at runtime).
static EXPOSED: OnceLock<Vec<String>> = OnceLock::new();

pub fn set_exposed_commands(commands: Vec<String>) {
    let _ = EXPOSED.set(commands);
}

pub fn exposed_commands() -> &'static [String] {
    EXPOSED.get().map(Vec::as_slice).unwrap_or(&[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_origin_tagging() {
        let buf = IpcBuffer::new(10);
        buf.push("invoke", "tool_cmd".into(), "ok", None, None, None, None);
        buf.push_with_origin("webview", "invoke", "page_cmd".into(), "ok", None, None, None, None);

        let (entries, _, _) = buf.query(None, None, None, None, 10);
        assert_eq!(entries[0].origin, "tool");
        assert_eq!(entries[1].origin, "webview");

        // Tool-origin entries omit the field on the wire; webview ones carry it.
        let tool_json = serde_json::to_value(&entries[0]).unwrap();
        assert!(tool_json.get("origin").is_none());
        let webview_json = serde_json::to_value(&entries[1]).unwrap();
        assert_eq!(webview_json["origin"], "webview");
    }

    #[test]
    fn test_push_and_query() {
        let buf = IpcBuffer::new(10);
        buf.push("invoke", "get_user".into(), "ok", Some(12), Some("{}".into()), Some("{\"id\":1}".into()), None);
        buf.push("invoke", "get_user".into(), "error", Some(5), None, None, Some("boom".into()));
        buf.push("event", "user-updated".into(), "emitted", None, Some("{}".into()), None, None);

        let (all, total, dropped) = buf.query(None, None, None, None, 100);
        assert_eq!(all.len(), 3);
        assert_eq!(total, 3);
        assert_eq!(dropped, 0);

        let (invokes, _, _) = buf.query(Some("invoke"), None, None, None, 100);
        assert_eq!(invokes.len(), 2);

        let (errors, _, _) = buf.query(None, None, Some("error"), None, 100);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].error.as_deref(), Some("boom"));

        let (named, _, _) = buf.query(None, Some("USER"), None, None, 100);
        assert_eq!(named.len(), 3); // matches get_user and user-updated
    }

    #[test]
    fn test_eviction_and_since_id() {
        let buf = IpcBuffer::new(3);
        for i in 0..5 {
            buf.push("invoke", format!("cmd{}", i), "ok", None, None, None, None);
        }
        let (entries, _, dropped) = buf.query(None, None, None, None, 100);
        assert_eq!(entries.len(), 3);
        assert_eq!(dropped, 2);
        assert_eq!(entries[0].name, "cmd2");

        let (newer, _, _) = buf.query(None, None, None, Some(entries[1].id), 100);
        assert_eq!(newer.len(), 1);
        assert_eq!(newer[0].name, "cmd4");
    }

    #[test]
    fn test_command_stats() {
        let buf = IpcBuffer::new(10);
        buf.push("invoke", "save".into(), "ok", Some(10), None, None, None);
        buf.push("invoke", "save".into(), "error", Some(30), None, None, Some("db".into()));
        buf.push("event", "saved".into(), "emitted", None, None, None, None);

        let stats = buf.command_stats();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].name, "save");
        assert_eq!(stats[0].count, 2);
        assert_eq!(stats[0].errors, 1);
        assert_eq!(stats[0].avg_duration_ms, Some(20));
        assert_eq!(stats[0].last_status, "error");
    }

    #[test]
    fn test_preview_truncation() {
        let buf = IpcBuffer::new(10);
        let long = "x".repeat(2000);
        buf.push("invoke", "big".into(), "ok", None, Some(long), None, None);
        let (entries, _, _) = buf.query(None, None, None, None, 10);
        let preview = entries[0].args_preview.as_ref().unwrap();
        assert!(preview.len() < 600);
        assert!(preview.ends_with("…[truncated]"));
    }
}
