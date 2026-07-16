-- Pending-invite contact matching (postgres backend).
-- Mirrors services/supabase/migrations/20260715000000_invite_contact_pending.sql.
--
-- Phone matching is Supabase-only: the Better-Auth `user` table on this backend
-- has no phone column, so invite_phone is stored for the inviter's reference but
-- can never match a login here. The column exists to keep the two backends'
-- table shapes identical.

ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "invite_email" text;
ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "invite_phone" text;
ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "team_invites" ADD COLUMN IF NOT EXISTS "declined_at" timestamptz;

-- Existing rows predate `status`; derive it from the consumption marker that was
-- previously the only signal.
UPDATE "team_invites" SET "status" = 'accepted'
 WHERE "consumed_at" IS NOT NULL AND "status" = 'pending';

-- One live invite per (team, email): re-inviting supersedes rather than stacking
-- up rows the invitee would have to decline twice.
CREATE UNIQUE INDEX IF NOT EXISTS "team_invites_pending_email_uniq"
  ON "team_invites" ("team_id", lower(btrim("invite_email")))
  WHERE "status" = 'pending' AND "invite_email" IS NOT NULL;

-- The unique index leads with team_id, so it cannot serve the login-time lookup,
-- which knows only the contact. This can.
CREATE INDEX IF NOT EXISTS "team_invites_pending_email_lookup"
  ON "team_invites" (lower(btrim("invite_email")))
  WHERE "status" = 'pending' AND "invite_email" IS NOT NULL;
