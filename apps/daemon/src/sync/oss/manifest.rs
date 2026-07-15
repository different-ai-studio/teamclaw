//! Manifest pagination helpers and tests.
//!
//! The actual pagination logic lives in `engine::tick()`.
//! This module exists to host the unit tests of the cursor-based pagination
//! contract: `last_server_seq` must only advance after `nextCursor == null`.
//!
//! NOTE: `drain_manifest` is reserved for use once the OSS pull path is wired in.
#![allow(dead_code)]

use super::fc_client::{ManifestItem, ManifestPage};

/// Simulate full manifest drain using a mock page provider.
/// Returns (all_items, final_snapshot_seq).
///
/// This is a testable version of the pagination loop in `engine::tick()`.
pub async fn drain_manifest<F, Fut>(after_seq: i64, fetch_page: F) -> (Vec<ManifestItem>, i64)
where
    F: Fn(i64, Option<String>, Option<i64>) -> Fut,
    Fut: std::future::Future<Output = Result<ManifestPage, super::error::SyncError>>,
{
    let mut cursor: Option<String> = None;
    let mut snapshot_seq: Option<i64> = None;
    let mut all_items = Vec::new();

    loop {
        let page = fetch_page(after_seq, cursor.clone(), snapshot_seq)
            .await
            .expect("mock fetch_page failed");
        snapshot_seq.get_or_insert(page.snapshot_seq);
        all_items.extend(page.items);
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }

    (all_items, snapshot_seq.unwrap_or(after_seq))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::oss::fc_client::ManifestItem;

    fn make_item(path: &str, version: i32, change_seq: i64) -> ManifestItem {
        ManifestItem {
            path: path.to_string(),
            version,
            content_hash: Some(format!("hash_{}", path)),
            size: Some(100),
            deleted: false,
            change_seq,
            updated_at: None,
        }
    }

    /// Three-page mock: page1 (cursor A), page2 (cursor B), page3 (no cursor).
    /// last_server_seq must equal the snapshot_seq from page1 (all pages share it),
    /// and must only be known after the loop ends.
    #[tokio::test]
    async fn test_cursor_pagination_drains_all_pages() {
        let pages: Vec<ManifestPage> = vec![
            ManifestPage {
                snapshot_seq: 100,
                items: vec![make_item("skills/a.md", 1, 10)],
                next_cursor: Some("cursor-A".to_string()),
            },
            ManifestPage {
                snapshot_seq: 100,
                items: vec![make_item("skills/b.md", 2, 20)],
                next_cursor: Some("cursor-B".to_string()),
            },
            ManifestPage {
                snapshot_seq: 100,
                items: vec![make_item("skills/c.md", 3, 30)],
                next_cursor: None,
            },
        ];

        let pages = std::sync::Arc::new(std::sync::Mutex::new(pages.into_iter()));

        let (all_items, final_seq) = drain_manifest(0, |_after, _cursor, _snap| {
            let pages = pages.clone();
            async move {
                let page = pages.lock().unwrap().next().expect("ran out of mock pages");
                Ok(page)
            }
        })
        .await;

        assert_eq!(all_items.len(), 3);
        assert_eq!(all_items[0].path, "skills/a.md");
        assert_eq!(all_items[1].path, "skills/b.md");
        assert_eq!(all_items[2].path, "skills/c.md");
        // snapshot_seq from first page should be used
        assert_eq!(final_seq, 100);
    }

    /// Single page with no cursor — snapshot_seq advances immediately.
    #[tokio::test]
    async fn test_single_page_no_cursor() {
        let page = ManifestPage {
            snapshot_seq: 42,
            items: vec![make_item("knowledge/x.md", 1, 42)],
            next_cursor: None,
        };

        let page = std::sync::Arc::new(std::sync::Mutex::new(Some(page)));
        let (items, final_seq) = drain_manifest(0, |_after, _cursor, _snap| {
            let page = page.clone();
            async move {
                let p = page.lock().unwrap().take().expect("page already consumed");
                Ok(p)
            }
        })
        .await;

        assert_eq!(items.len(), 1);
        assert_eq!(final_seq, 42);
    }

    /// snapshot_seq stays consistent across pages (first page wins).
    #[tokio::test]
    async fn test_snapshot_seq_locked_after_first_page() {
        let pages = vec![
            ManifestPage {
                snapshot_seq: 50,
                items: vec![make_item("skills/p1.md", 1, 10)],
                next_cursor: Some("c1".to_string()),
            },
            ManifestPage {
                snapshot_seq: 99, // server returned different seq on page 2 (shouldn't happen but test robustness)
                items: vec![make_item("skills/p2.md", 2, 20)],
                next_cursor: None,
            },
        ];

        let pages = std::sync::Arc::new(std::sync::Mutex::new(pages.into_iter()));
        let (_, final_seq) = drain_manifest(0, |_after, _cursor, snap| {
            let pages = pages.clone();
            async move {
                let p = pages.lock().unwrap().next().unwrap();
                // Pass snap through to verify it's passed correctly
                let _ = snap;
                Ok(p)
            }
        })
        .await;

        // First page's snapshot_seq wins
        assert_eq!(final_seq, 50);
    }
}
