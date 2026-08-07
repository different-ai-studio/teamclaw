-- `share_mode` stopped being a choice: git sharing is gone and the only
-- backend is Supabase Storage. The column now means exactly "team knowledge
-- sync is enabled" — NULL is off, anything else is on.
--
-- Data is deliberately left alone. `amux.team_share_mode` is a three-value
-- enum, so there is no 'storage' value to migrate to, and
-- `guard_team_share_mode()` refuses to change an already-set value — an UPDATE
-- here would fail twice over. Existing managed_git / custom_git rows read as
-- "enabled" under the new semantics, which is correct: those teams did enable
-- sync. Clients branch on "not null" rather than on the value.
comment on column amux.teams.share_mode is
  'Historical name. Today it only means "team knowledge sync is enabled"; the only backend is Supabase Storage. Values other than oss are legacy rows and carry no meaning.';

comment on type amux.team_share_mode is
  'Historical. See amux.teams.share_mode — the three values no longer select a backend. New rows are always oss.';
