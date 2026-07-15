-- Group consecutive agent reply rows that came out of the same logical
-- turn. Today the daemon's TurnAggregator emits one AgentReply at every
-- ToolUse interruption AND another at Active→Idle, so a single "the
-- agent replied X" turn lands in `messages` as 2+ rows — fine while you
-- watch live, but on reload the gap is jarring because the tool calls
-- that bridged them live in MQTT-only and never made it into DB.
--
-- Per-message `turn_id` is the correlation key the daemon stamps on
-- every emit within one turn. Clients group consecutive same-turn_id
-- AgentReply rows into one bubble.
--
-- Nullable: historical rows pre-dating the column have no value; clients
-- must fall back to "each row is its own bubble" for those.
--
-- We are intentionally NOT persisting per-tool-call rows to Supabase:
-- the daemon's TOML log and the live MQTT stream are the source of
-- truth for tool history. Reload only restores `messages`. Scenarios
-- that need full forensic detail (cron / share / replay across
-- devices) will get a dedicated table later.

alter table public.messages
  add column if not exists turn_id text;

comment on column public.messages.turn_id is
  'Daemon-assigned correlation id stamped on every emit within one ACP turn (Idle→Active→…→Idle). Clients merge consecutive same-turn_id AgentReply rows into a single bubble. NULL for rows older than this column.';

create index if not exists messages_turn_id_idx
  on public.messages (session_id, turn_id)
  where turn_id is not null;
