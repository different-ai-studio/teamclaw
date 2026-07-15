//! Daemon-facing helpers for workspace static instructions (re-export gateway SSOT).

use std::path::Path;

pub use teamclaw_gateway::{
    claude_md_block_present, load_system_prompt as load_system_prompt_str,
    sync_teamclaw_claude_md as sync_teamclaw_claude_md_str,
};

pub fn load_system_prompt(workspace: &Path) -> String {
    load_system_prompt_str(&path_to_string(workspace))
}

pub fn sync_teamclaw_claude_md(workspace: &Path, prompt: &str) -> Result<(), String> {
    sync_teamclaw_claude_md_str(&path_to_string(workspace), prompt)
}

pub fn claude_md_block_present_at(workspace: &Path) -> bool {
    claude_md_block_present(&path_to_string(workspace))
}

fn path_to_string(workspace: &Path) -> String {
    workspace.to_string_lossy().into_owned()
}
