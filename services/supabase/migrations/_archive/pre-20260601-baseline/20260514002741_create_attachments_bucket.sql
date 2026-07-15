-- Create attachments bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'attachments',
  'attachments',
  false,
  52428800,  -- 50MB in bytes
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/markdown', 'text/csv',
    'application/json',
    'text/x-swift', 'text/x-python', 'text/x-javascript',
    'application/zip',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- RLS: SELECT (download) — user must be a session participant.
-- Object path convention used by the gateway port:
--   <team_id>/<session_id>/<uuid>-<filename>
-- SPLIT_PART(name, '/', 2) extracts the session_id segment.
-- actors.user_id (set on member-type actors by 202604220015) maps to
-- auth.uid(); external-IM actors have user_id NULL and are excluded.
CREATE POLICY "session_participants_can_download"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'attachments'
  AND auth.uid() IN (
    SELECT a.user_id
    FROM public.session_participants sp
    JOIN public.actors a ON a.id = sp.actor_id
    WHERE sp.session_id::text = SPLIT_PART(name, '/', 2)
      AND a.user_id IS NOT NULL
  )
);

-- RLS: INSERT (upload) — authenticated users
CREATE POLICY "authenticated_can_upload"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'attachments'
);

-- RLS: DELETE — deny all (cleanup via backend task)
CREATE POLICY "no_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (false);
