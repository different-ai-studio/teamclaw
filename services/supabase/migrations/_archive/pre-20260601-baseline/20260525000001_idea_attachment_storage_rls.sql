-- Allow team members to download idea attachments.
--
-- Idea attachments are uploaded under the path
--   <team_id>/ideas/<idea_id>/<attachment_id>/<filename>
-- (see AttachmentUploadManager in apps/ios — IdeaSheet / IdeaDetailView
-- pass `sessionID = "ideas/<idea_id>"` to namespace ideas separately from
-- sessions).
--
-- The original `session_participants_can_download` policy created in
-- 20260514002741_create_attachments_bucket.sql checks
--   SPLIT_PART(name, '/', 2) = <session_id>
-- which for idea attachments is the literal text 'ideas', so it never
-- matches a real session and SELECT (including signed-URL creation,
-- which requires SELECT) is denied. Uploads succeed under the open
-- INSERT policy, but `createSignedURL` then throws and the iOS
-- AttachmentUpload record is marked `.failed`, surfacing as an
-- exclamation triangle on the local thumbnail tile.
--
-- This migration adds a parallel SELECT policy scoped to the
-- idea path layout: if the second segment is the literal 'ideas' and
-- the first segment is the user's team_id, allow the download.

create policy "team_members_can_download_idea_attachments"
on storage.objects for select
to authenticated
using (
  bucket_id = 'attachments'
  and split_part(name, '/', 2) = 'ideas'
  and split_part(name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  and app.is_team_member(split_part(name, '/', 1)::uuid)
);
