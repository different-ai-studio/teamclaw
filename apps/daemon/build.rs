//! Stage the app starter templates into `OUT_DIR` so `include_dir!` embeds the
//! template *sources* and nothing else.
//!
//! `include_dir!` takes a directory whole. Pointing it straight at
//! `templates/` would compile whatever happens to be lying there — a
//! `node_modules` from someone running `pnpm install` (6 MB for the slides
//! template alone), a stale `.output`, editor droppings — into the daemon
//! binary, and silently ship it into every app that gets seeded. Copying
//! through a filter here makes the embedded set explicit and reproducible.

use std::path::{Path, PathBuf};

/// Directory names never copied into the staged template.
const EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    ".output",
    ".nitro",
    ".tanstack",
    "dist",
    ".git",
];
const EXCLUDED_FILES: &[&str] = &[".DS_Store"];

const TEMPLATES: &[&str] = &["static-web", "slides", "tanstack-postgres"];

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src_root = manifest.join("../../templates");
    let out_root = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("app-templates");

    // Rebuild whenever a template changes. cargo watches the directory tree.
    println!("cargo:rerun-if-changed={}", src_root.display());

    let _ = std::fs::remove_dir_all(&out_root);
    for name in TEMPLATES {
        let src = src_root.join(name);
        assert!(
            src.is_dir(),
            "missing app template {}: {}",
            name,
            src.display()
        );
        copy_filtered(&src, &out_root.join(name));
    }
}

fn copy_filtered(src: &Path, dest: &Path) {
    std::fs::create_dir_all(dest).unwrap_or_else(|e| panic!("mkdir {}: {e}", dest.display()));
    for entry in std::fs::read_dir(src).unwrap_or_else(|e| panic!("read {}: {e}", src.display())) {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        if path.is_dir() {
            if EXCLUDED_DIRS.contains(&name.as_ref()) {
                continue;
            }
            copy_filtered(&path, &dest.join(name.as_ref()));
        } else {
            if EXCLUDED_FILES.contains(&name.as_ref()) {
                continue;
            }
            std::fs::copy(&path, dest.join(name.as_ref()))
                .unwrap_or_else(|e| panic!("copy {}: {e}", path.display()));
        }
    }
}
