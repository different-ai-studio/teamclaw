//! Per-WeCom-bot durable instructions written into the bot's workspace as
//! ClaudeCode's untracked `CLAUDE.local.md`. The content lives inside a
//! managed marker block so user-authored notes in the same file survive
//! rewrites, and the filename is added to `.gitignore` so the team
//! git/oss sync engine never carries a per-bot persona into the repo.

use std::io::Write;
use std::path::Path;

pub const MANAGED_BEGIN: &str = "<!-- amuxd:bot-instructions BEGIN (managed, do not edit) -->";
pub const MANAGED_END: &str = "<!-- amuxd:bot-instructions END -->";
const FILE_NAME: &str = "CLAUDE.local.md";

/// Write/refresh the managed instruction block in `<workspace_dir>/CLAUDE.local.md`
/// and ensure that filename is gitignored. Best-effort: returns the io error
/// so callers can log; callers MUST treat failure as non-fatal.
pub fn write_bot_instruction_file(workspace_dir: &Path, prompt: &str) -> std::io::Result<()> {
    let path = workspace_dir.join(FILE_NAME);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let block = format!("{MANAGED_BEGIN}\n{}\n{MANAGED_END}", prompt.trim());

    let next = match (existing.find(MANAGED_BEGIN), existing.find(MANAGED_END)) {
        (Some(b), Some(e)) if e > b => {
            let end = e + MANAGED_END.len();
            format!("{}{}{}", &existing[..b], block, &existing[end..])
        }
        _ if existing.trim().is_empty() => block,
        _ => format!("{}\n\n{block}\n", existing.trim_end()),
    };
    std::fs::write(&path, next)?;
    ensure_gitignored(workspace_dir, FILE_NAME)?;
    Ok(())
}

/// Remove the managed block (used when a bot clears its prompt). Best-effort.
#[allow(dead_code)]
pub fn clear_bot_instruction_file(workspace_dir: &Path) -> std::io::Result<()> {
    let path = workspace_dir.join(FILE_NAME);
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    if let (Some(b), Some(e)) = (existing.find(MANAGED_BEGIN), existing.find(MANAGED_END)) {
        if e > b {
            let end = e + MANAGED_END.len();
            let next = format!("{}{}", &existing[..b], &existing[end..]);
            std::fs::write(&path, next.trim_start())?;
        }
    }
    Ok(())
}

fn ensure_gitignored(workspace_dir: &Path, name: &str) -> std::io::Result<()> {
    let gi = workspace_dir.join(".gitignore");
    let existing = std::fs::read_to_string(&gi).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == name) {
        return Ok(());
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gi)?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        writeln!(f)?;
    }
    writeln!(f, "{name}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_managed_block_and_gitignores_it() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        write_bot_instruction_file(p, "你是A，只用中文。").unwrap();

        let content = std::fs::read_to_string(p.join("CLAUDE.local.md")).unwrap();
        assert!(content.contains(MANAGED_BEGIN));
        assert!(content.contains("你是A，只用中文。"));
        assert!(content.contains(MANAGED_END));

        let gi = std::fs::read_to_string(p.join(".gitignore")).unwrap();
        assert!(gi.lines().any(|l| l.trim() == "CLAUDE.local.md"));
    }

    #[test]
    fn rewrites_managed_block_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        write_bot_instruction_file(p, "v1").unwrap();
        write_bot_instruction_file(p, "v2").unwrap();
        let content = std::fs::read_to_string(p.join("CLAUDE.local.md")).unwrap();
        assert!(content.contains("v2"));
        assert!(!content.contains("v1"));
        assert_eq!(content.matches(MANAGED_BEGIN).count(), 1);
    }

    #[test]
    fn preserves_user_content_outside_managed_block() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("CLAUDE.local.md"), "my notes\n").unwrap();
        write_bot_instruction_file(p, "bot persona").unwrap();
        let content = std::fs::read_to_string(p.join("CLAUDE.local.md")).unwrap();
        assert!(content.contains("my notes"));
        assert!(content.contains("bot persona"));
    }

    #[test]
    fn gitignore_not_duplicated_on_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        write_bot_instruction_file(p, "a").unwrap();
        write_bot_instruction_file(p, "b").unwrap();
        let gi = std::fs::read_to_string(p.join(".gitignore")).unwrap();
        assert_eq!(gi.lines().filter(|l| l.trim() == "CLAUDE.local.md").count(), 1);
    }
}
