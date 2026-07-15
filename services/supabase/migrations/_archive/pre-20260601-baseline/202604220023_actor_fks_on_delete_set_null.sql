-- Allow removing an actor without wiping history. Columns that record who
-- did what (created_by, sender, invited_by, …) drop their NOT NULL and
-- become nullable with ON DELETE SET NULL, so deletion preserves the row
-- but forgets the actor.

alter table public.team_invites alter column invited_by_actor_id drop not null;
alter table public.messages alter column sender_actor_id drop not null;
alter table public.sessions alter column created_by_actor_id drop not null;
alter table public.ideas alter column created_by_actor_id drop not null;
alter table public.idea_external_refs alter column linked_by_actor_id drop not null;

alter table public.team_invites
  drop constraint team_invites_consumed_by_actor_id_fkey;
alter table public.team_invites
  add constraint team_invites_consumed_by_actor_id_fkey
    foreign key (consumed_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.team_invites
  drop constraint team_invites_invited_by_actor_id_fkey;
alter table public.team_invites
  add constraint team_invites_invited_by_actor_id_fkey
    foreign key (invited_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.messages
  drop constraint messages_sender_actor_id_fkey;
alter table public.messages
  add constraint messages_sender_actor_id_fkey
    foreign key (sender_actor_id) references public.actors(id)
    on delete set null;

alter table public.sessions
  drop constraint sessions_created_by_actor_id_fkey;
alter table public.sessions
  add constraint sessions_created_by_actor_id_fkey
    foreign key (created_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.ideas
  drop constraint ideas_created_by_actor_id_fkey;
alter table public.ideas
  add constraint ideas_created_by_actor_id_fkey
    foreign key (created_by_actor_id) references public.actors(id)
    on delete set null;

alter table public.idea_external_refs
  drop constraint idea_external_refs_linked_by_actor_id_fkey;
alter table public.idea_external_refs
  add constraint idea_external_refs_linked_by_actor_id_fkey
    foreign key (linked_by_actor_id) references public.actors(id)
    on delete set null;
