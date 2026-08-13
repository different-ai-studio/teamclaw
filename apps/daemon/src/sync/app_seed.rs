//! Seed an app checkout: write the starter template into the working directory.
//!
//! There is no remote and no local repo. Seeding used to create a managed-git
//! repo, clone a GitHub template into it and push; that went first, and the
//! local `git init` + scaffold commit that replaced it went with the rest of
//! git. `app_build` builds whatever is in this directory, so nothing
//! downstream depends on revision metadata being here.

use std::path::Path;

use crate::sync::app_templates::{write_template, TemplateVars};

/// Write the template into `workdir`.
///
/// `workdir` is created if missing. Re-seeding an existing checkout restores
/// the starter files over the top, so a wrecked app can be reset; files the
/// template does not know about are left alone.
pub fn seed_app_repo(workdir: &Path, vars: &TemplateVars<'_>) -> anyhow::Result<()> {
    write_template(workdir, vars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::app_templates::AppType;

    fn vars<'a>(app_type: AppType) -> TemplateVars<'a> {
        TemplateVars {
            app_id: "app-1",
            app_name: "Demo",
            app_type,
        }
    }

    #[test]
    fn seeds_the_starter_files() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();

        assert!(work.join("AGENTS.md").is_file());
        assert!(work.join("public/index.html").is_file());
    }

    #[test]
    fn reseeding_restores_a_wrecked_file() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        std::fs::write(work.join("public/index.html"), "wrecked").unwrap();

        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        let restored = std::fs::read_to_string(work.join("public/index.html")).unwrap();
        assert!(restored.contains("Demo"), "starter content is back");
    }

    #[test]
    fn work_the_template_does_not_know_about_survives_a_reseed() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        std::fs::write(work.join("public/about.html"), "<h1>agent wrote this</h1>").unwrap();

        seed_app_repo(&work, &vars(AppType::StaticWeb)).unwrap();
        assert!(work.join("public/about.html").is_file());
    }

    #[test]
    fn reseeding_an_untouched_checkout_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().join("app");
        seed_app_repo(&work, &vars(AppType::Slides)).unwrap();
        seed_app_repo(&work, &vars(AppType::Slides)).unwrap();
    }
}
