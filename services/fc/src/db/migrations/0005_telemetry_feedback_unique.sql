--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS actor_message_feedback_actor_message_uidx
  ON actor_message_feedback (actor_id, message_id);
