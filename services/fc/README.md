# teamclaw-fc

The TeamClaw Cloud API (Hono). It can run on Alibaba Function Compute via
`s.yaml`, and also runs as a standalone Docker container for self-hosting.

## Run in Docker (self-host)

The container serves the full `/v1` API plus `/healthz` and `/internal/cron`.
All backing services (Postgres/Supabase, OSS, MQTT, LiteLLM) stay external and
are configured through environment variables — the same set listed in `s.yaml`.

```bash
cp .env.example .env   # fill in the values (see s.yaml for the full list)
docker compose up --build
curl http://127.0.0.1:9000/healthz   # {"ok":true}
```

### Container-specific env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `9000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CRON_TRIGGER_SECRET` | (unset) | Shared secret required by `/internal/cron` |
| `BACKEND_KIND` | `supabase` | `supabase` or `postgres` (via `resolveBackendKind`) |

All other vars (DB, Supabase, OSS, LiteLLM, APNs, MQTT, CodeUp) match `s.yaml`.

### Cron (HTTP-triggered)

Alibaba FC drives cron via timer triggers. In Docker, an external scheduler
POSTs to `/internal/cron` instead. Run each task on its own schedule:

```bash
curl -X POST http://127.0.0.1:9000/internal/cron \
  -H "x-cron-secret: $CRON_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"oss-abandon-sessions"}'

curl -X POST http://127.0.0.1:9000/internal/cron \
  -H "x-cron-secret: $CRON_TRIGGER_SECRET" \
  -H "content-type: application/json" \
  -d '{"task":"oss-gc-blobs"}'
```

Tasks: `oss-abandon-sessions`, `oss-gc-blobs`. A missing/wrong secret returns
401; an unknown task returns 400. If the server was started without cron support it returns 503.

The Alibaba FC entrypoint (`dist/index.handler`) and `s.yaml` are unchanged by
the Docker support.
