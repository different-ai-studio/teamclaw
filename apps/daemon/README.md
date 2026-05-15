# amuxd — AMUX Daemon

Rust daemon that spawns and manages AI coding agents (Claude Code via ACP/stdio), publishes events over MQTT, and syncs state to Supabase.

## Build prerequisites

`amuxd init` reads the Supabase project URL and anon key from the environment. Set:

```bash
export SUPABASE_URL=https://srhaytajyfrniuvnkfpd.supabase.co
export SUPABASE_ANON_KEY=<anon key from Supabase dashboard or amux-api/.env>
```

Before running `amuxd init`.

### Recommended setup

Copy `daemon/.env.example` to `daemon/.env` and fill in the values, then either:

- Source it before init: `source daemon/.env && cargo run -- init <invite-url>`
- Or use [direnv](https://direnv.net/): place a `.envrc` in `daemon/` with `dotenv .env`

The `.env` file is gitignored and must not be committed.

## Build

```bash
cd daemon && cargo build
```

## First-time setup (daemon onboarding)

1. On the owner's iOS device, create an agent invite — copy the `amux://invite?...` deeplink.
2. Run:

```bash
./target/release/amuxd init "amux://invite?token=<token>&broker=<mqtt-url>&username=<user>&password=<pass>"
```

Expected output: `Daemon onboarded. actor_id=<uuid> team_id=<uuid> display_name=<name> config=<path>`

This writes `~/.config/amux/supabase.toml` with the daemon's credentials.

## Run

```bash
./target/release/amuxd start
```

## Test

```bash
cd daemon && cargo test
```
