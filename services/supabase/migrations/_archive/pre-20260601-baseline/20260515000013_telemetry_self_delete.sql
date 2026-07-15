-- Allow actors to delete their own feedback rows (for removeFeedback / removeStarRating).

create policy actor_message_feedback_delete_self
  on public.actor_message_feedback
  for delete to authenticated
  using (
    exists (
      select 1 from public.actors a
       where a.id = actor_id
         and a.user_id = auth.uid()
    )
  );

grant delete on public.actor_message_feedback to authenticated;
