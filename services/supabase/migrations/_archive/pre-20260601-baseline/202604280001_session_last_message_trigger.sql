-- Bumps sessions.last_message_preview / last_message_at when a new
-- message lands so iOS / clients can render a session preview without
-- the daemon having to issue a separate UPDATE. Gates on created_at so
-- a late-arriving older row can't regress a fresher preview.

CREATE OR REPLACE FUNCTION app.bump_session_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.sessions
  SET last_message_preview = LEFT(COALESCE(NEW.content, ''), 140),
      last_message_at = NEW.created_at
  WHERE id = NEW.session_id
    AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_session_last_message ON public.messages;

CREATE TRIGGER bump_session_last_message
AFTER INSERT ON public.messages
FOR EACH ROW
EXECUTE FUNCTION app.bump_session_last_message();
