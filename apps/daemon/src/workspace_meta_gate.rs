//! Compile-time-ish guard: production daemon sources must not hard-code
//! workspace meta as `".teamclaw"` path literals. Use
//! `teamclaw_runtime_env` helpers / `WORKSPACE_META_DIR` instead.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    fn daemon_src_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    fn is_test_region(line: &str, in_test_mod: &mut bool, brace_depth: &mut i32) -> bool {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#[cfg(test)]") {
            *in_test_mod = true;
            *brace_depth = 0;
            return true;
        }
        if *in_test_mod {
            *brace_depth += line.chars().filter(|c| *c == '{').count() as i32;
            *brace_depth -= line.chars().filter(|c| *c == '}').count() as i32;
            if *brace_depth <= 0 && line.contains('}') {
                *in_test_mod = false;
                *brace_depth = 0;
            }
            return true;
        }
        false
    }

    fn is_comment_or_doc(line: &str) -> bool {
        let t = line.trim_start();
        t.starts_with("//") || t.starts_with("///") || t.starts_with("//!") || t.starts_with('*')
    }

    /// Forbidden path literals that bypass brand helpers.
    const FORBIDDEN: &[&str] = &[
        "\".teamclaw\"",
        "'.teamclaw'",
        "\"/.teamclaw",
        "join(\".teamclaw",
        "join(\".teamclaw/",
        "\"/.teamclaw/",
    ];

    #[test]
    fn production_daemon_sources_do_not_hardcode_teamclaw_meta_paths() {
        let mut files = Vec::new();
        collect_rs_files(&daemon_src_root(), &mut files);
        // This gate file itself may mention the forbidden strings in the
        // FORBIDDEN table — exclude it from scanning.
        files.retain(|p| p.file_name().and_then(|n| n.to_str()) != Some("workspace_meta_gate.rs"));

        let mut violations = Vec::new();
        for path in files {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let mut in_test_mod = false;
            let mut brace_depth = 0i32;
            for (idx, line) in content.lines().enumerate() {
                if is_test_region(line, &mut in_test_mod, &mut brace_depth) {
                    continue;
                }
                if is_comment_or_doc(line) {
                    continue;
                }
                for needle in FORBIDDEN {
                    if line.contains(needle) {
                        violations.push(format!(
                            "{}:{}: {}",
                            path.strip_prefix(daemon_src_root().parent().unwrap())
                                .unwrap_or(&path)
                                .display(),
                            idx + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }

        assert!(
            violations.is_empty(),
            "hard-coded `.teamclaw` workspace meta paths in production daemon code:\n{}",
            violations.join("\n")
        );
    }
}
