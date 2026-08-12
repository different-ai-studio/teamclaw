//! The installed-state baseline: which files we put on disk, and what they
//! looked like at the moment we finished putting them there.
//!
//! **"At the moment we finished" is load-bearing.** The install pipeline
//! rewrites `SKILL.md`'s frontmatter *after* unpacking the archive, so the
//! bytes on disk never match the bytes in the package. Anything built from the
//! package's own hash — the registry's `contentHash`, for instance — reports
//! every skill as modified, forever. Build the manifest last, from the
//! directory, or not at all.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Our own bookkeeping directory. Excluded from every manifest: it holds the
/// manifest, so including it would make the file describe itself.
pub const EXCLUDED_DIR: &str = ".clawhub";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFile {
    pub sha256: String,
    pub size: u64,
    /// Pre-filter only, never a verdict. mtime survives neither a copy nor a
    /// clock change, so it may only ever be used to skip work — a match means
    /// "don't bother reading the file", a mismatch means "read it and decide".
    #[serde(default)]
    pub mtime_ms: u64,
    /// Tracked separately because `chmod +x` is a real edit that moves ctime,
    /// not mtime — the size/mtime fast path cannot see it.
    #[serde(default)]
    pub exec: bool,
}

/// Relative path (always `/`-separated, for a stable on-disk shape) → file.
pub type FileManifest = BTreeMap<String, ManagedFile>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirtyState {
    Clean,
    Dirty {
        modified: Vec<String>,
        deleted: Vec<String>,
    },
    /// No baseline was recorded. Either the pack predates manifests or somebody
    /// created the directory by hand; in both cases we know nothing about what
    /// "unchanged" would mean, so the caller has to choose a policy rather than
    /// us guessing one.
    Unmanaged,
}

impl DirtyState {
    pub fn is_dirty(&self) -> bool {
        matches!(self, Self::Dirty { .. })
    }
}

pub fn file_sha256(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn exec_bit(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn exec_bit(_meta: &std::fs::Metadata) -> bool {
    false
}

pub(crate) fn to_native(rel: &str) -> PathBuf {
    if std::path::MAIN_SEPARATOR == '/' {
        PathBuf::from(rel)
    } else {
        PathBuf::from(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    }
}

/// Every regular file under `dir`, `.clawhub/` aside, as `/`-separated relative
/// paths in sorted order.
///
/// This is the single definition of "a file the pack owns" — the manifest and
/// the upgrade swap both go through it, so neither can drift into a different
/// idea of which files are in scope.
///
/// Symlinks are skipped rather than followed: packages are extracted as plain
/// files (see the installer's zip extraction), so a symlink in here is
/// something a user added, and following one is how a directory walk turns
/// into an infinite loop.
pub fn list_managed_paths(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

pub fn build_manifest(dir: &Path) -> std::io::Result<FileManifest> {
    build_manifest_for(dir, &list_managed_paths(dir)?)
}

/// Build a baseline covering exactly `rels`, ignoring whatever else is in the
/// directory.
///
/// This is the one to use after an upgrade. [`build_manifest`] measures the
/// whole directory, which on a second install quietly adopts everything the
/// swap deliberately left alone — a script's own log file, a note the user
/// dropped in — into the set of files the pack claims to own. The next time
/// that script runs, its log is "modified", auto-follow stops for good, and the
/// conflict UI asks the user to decide about a file they never touched. Pass
/// the package's own file list and none of that can happen.
///
/// Paths that are not on disk are skipped rather than failing the call: a
/// package may ship a file the frontmatter rewrite then removes, and a missing
/// entry is simply one fewer thing to compare.
pub fn build_manifest_for(dir: &Path, rels: &[String]) -> std::io::Result<FileManifest> {
    let mut out = FileManifest::new();
    for rel in rels {
        let path = dir.join(to_native(rel));
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        out.insert(
            rel.clone(),
            ManagedFile {
                sha256: file_sha256(&path)?,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                exec: exec_bit(&meta),
            },
        );
    }
    Ok(out)
}

fn walk(root: &Path, current: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            // Only the top-level `.clawhub` is ours; one nested deeper belongs
            // to the package and is measured like anything else.
            if path.parent() == Some(root) && entry.file_name() == EXCLUDED_DIR {
                continue;
            }
            walk(root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        out.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(())
}

/// Compare what is on disk against the baseline.
///
/// Only files named in the baseline are examined. Anything else in the
/// directory — a script's cache, a note the user dropped in — is deliberately
/// invisible here and survives upgrades untouched.
pub fn inspect(dir: &Path, baseline: Option<&FileManifest>) -> DirtyState {
    let Some(baseline) = baseline else {
        return DirtyState::Unmanaged;
    };
    if baseline.is_empty() {
        return DirtyState::Unmanaged;
    }

    let mut modified = Vec::new();
    let mut deleted = Vec::new();

    for (rel, want) in baseline {
        let full = dir.join(to_native(rel));
        let Ok(meta) = std::fs::symlink_metadata(&full) else {
            deleted.push(rel.clone());
            continue;
        };
        if !meta.is_file() {
            // Replaced by a directory or a symlink — not our file any more.
            modified.push(rel.clone());
            continue;
        }
        if exec_bit(&meta) != want.exec {
            modified.push(rel.clone());
            continue;
        }
        if meta.len() == want.size && mtime_ms(&meta) == want.mtime_ms {
            continue;
        }
        match file_sha256(&full) {
            Ok(actual) if actual == want.sha256 => {}
            // An unreadable file counts as modified: we cannot prove it is
            // still ours, and silently overwriting it is the one outcome that
            // is never recoverable.
            _ => modified.push(rel.clone()),
        }
    }

    if modified.is_empty() && deleted.is_empty() {
        DirtyState::Clean
    } else {
        DirtyState::Dirty { modified, deleted }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, body: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("deploy-check");
        write(&dir, "SKILL.md", "---\nname: deploy-check\n---\nbody\n");
        write(&dir, "scripts/check.sh", "#!/bin/sh\necho hi\n");
        (tmp, dir)
    }

    #[test]
    fn a_freshly_built_manifest_is_clean_against_its_own_directory() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(inspect(&dir, Some(&m)), DirtyState::Clean);
    }

    #[test]
    fn bookkeeping_is_not_part_of_the_measurement() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        // Writing origin.json after the manifest must not make the skill dirty,
        // or every install would be born in conflict.
        write(&dir, ".clawhub/origin.json", "{}\n");
        assert!(!m.contains_key(".clawhub/origin.json"));
        assert_eq!(inspect(&dir, Some(&m)), DirtyState::Clean);
    }

    #[test]
    fn edits_and_deletions_are_reported_by_path() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        write(&dir, "SKILL.md", "---\nname: deploy-check\n---\nedited\n");
        std::fs::remove_file(dir.join("scripts/check.sh")).unwrap();

        match inspect(&dir, Some(&m)) {
            DirtyState::Dirty { modified, deleted } => {
                assert_eq!(modified, vec!["SKILL.md".to_string()]);
                assert_eq!(deleted, vec!["scripts/check.sh".to_string()]);
            }
            other => panic!("expected dirty, got {:?}", other),
        }
    }

    #[test]
    fn files_the_package_never_shipped_are_invisible() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        // A script writing its cache next to itself is the common case; it must
        // not pin the skill as dirty and stall auto-follow forever.
        write(&dir, "cache/run.log", "noise\n");
        assert_eq!(inspect(&dir, Some(&m)), DirtyState::Clean);
    }

    #[test]
    fn same_size_content_still_counts_as_modified() {
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        let path = dir.join("SKILL.md");
        let original = std::fs::read_to_string(&path).unwrap();
        let swapped = original.replace("body", "b0dy");
        assert_eq!(swapped.len(), original.len());
        std::fs::write(&path, swapped).unwrap();
        // Equal length: only the hash can tell these apart. If mtime happens to
        // land in the same millisecond the fast path would wave it through, so
        // force the comparison the way a later reconcile tick would see it.
        let mut baseline = m.clone();
        baseline.get_mut("SKILL.md").unwrap().mtime_ms = 0;
        assert!(inspect(&dir, Some(&baseline)).is_dirty());
    }

    #[cfg(unix)]
    #[test]
    fn chmod_alone_is_a_modification() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, dir) = fixture();
        let m = build_manifest(&dir).unwrap();
        let path = dir.join("scripts/check.sh");
        // chmod moves ctime, not mtime — the size/mtime fast path is blind to
        // it, which is exactly why exec is compared on every pass.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        match inspect(&dir, Some(&m)) {
            DirtyState::Dirty { modified, .. } => {
                assert_eq!(modified, vec!["scripts/check.sh".to_string()]);
            }
            other => panic!("expected dirty, got {:?}", other),
        }
    }

    #[test]
    fn a_scoped_manifest_ignores_what_the_package_did_not_ship() {
        // The upgrade case. `build_manifest` would sweep the script's own log
        // into the baseline, and the next time the script ran the pack would be
        // "modified" — auto-follow stopped for good over a file nobody edited.
        let (_tmp, dir) = fixture();
        write(&dir, "cache/run.log", "noise\n");
        let shipped = vec!["SKILL.md".to_string(), "scripts/check.sh".to_string()];

        let scoped = build_manifest_for(&dir, &shipped).unwrap();

        assert_eq!(scoped.len(), 2);
        assert!(!scoped.contains_key("cache/run.log"));
        assert!(build_manifest(&dir).unwrap().contains_key("cache/run.log"));
        write(&dir, "cache/run.log", "more noise\n");
        assert_eq!(inspect(&dir, Some(&scoped)), DirtyState::Clean);
    }

    #[test]
    fn a_scoped_manifest_skips_paths_that_are_not_there() {
        let (_tmp, dir) = fixture();
        let shipped = vec!["SKILL.md".to_string(), "gone.md".to_string()];
        let scoped = build_manifest_for(&dir, &shipped).unwrap();
        assert_eq!(scoped.len(), 1);
        assert!(scoped.contains_key("SKILL.md"));
    }

    #[test]
    fn no_baseline_is_unmanaged_not_clean() {
        let (_tmp, dir) = fixture();
        assert_eq!(inspect(&dir, None), DirtyState::Unmanaged);
        assert_eq!(
            inspect(&dir, Some(&FileManifest::new())),
            DirtyState::Unmanaged
        );
    }
}
