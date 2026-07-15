-- 20260527000005_oss_sync_default_mode.sql
--
-- Flip the default sync_mode for team_workspace_config from 'git' to 'oss'.
-- Existing rows are not touched; only newly-inserted rows that omit sync_mode
-- pick up the new default. Explicit inserts (public.create_team writing 'git',
-- FC /sync/create-team writing 'oss') keep their behavior.
--
-- See docs/superpowers/specs/2026-05-27-oss-sync-redesign-design.md.

begin;

alter table public.team_workspace_config
  alter column sync_mode set default 'oss';

commit;
