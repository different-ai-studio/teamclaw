-- Make the `attachments` bucket public.
--
-- The iOS Supabase→Cloud API cutover removed the Supabase SDK and with it the
-- `createSignedURL` path that minted tokenless 1-year signed URLs. Attachment
-- URLs are persisted into message content / idea `attachment_urls` and rendered
-- by every client (iOS/web/expo) via a plain image fetch, so they must resolve
-- without a bearer. We therefore make the bucket public (mirroring `avatars`),
-- and rely on the unguessable object path (`<team>/<session>/<uuid>/<file>`) as
-- the capability — the same confidentiality model already used for avatars.
update storage.buckets set public = true where id = 'attachments';

-- Explicit public read for the bucket (public-object serving bypasses RLS, but
-- declare the policy so the intent is visible and direct PostgREST/storage reads
-- are also allowed).
drop policy if exists attachments_public_read on storage.objects;
create policy attachments_public_read
on storage.objects for select
to public
using (bucket_id = 'attachments');

-- The legacy authenticated participant-scoped read policy is now redundant with
-- public read; drop it to avoid confusion.
drop policy if exists "session_participants_can_download" on storage.objects;
