# Self-host All-in-one Single-image Deployment Design

Date: 2026-07-06
Branch: `codex/all-in-one-self-host`

## Problem

The current self-host deployment is a Docker Compose stack under `deploy/self-host/`. It relies on multiple containers and multiple externally visible endpoints:

- TeamClaw Cloud API (`fc`)
- daemon / agent runner (`amuxd`)
- EMQX MQTT broker
- Caddy reverse proxy
- Postgres-backed TeamClaw Cloud API services, MQTT, object storage, and optional legacy Supabase-compatible services
- migration and cron helper services

The target platform allows only:

- one Docker image
- one exposed port
- no external managed dependencies or external service configuration

Therefore, the deployment must become a self-contained appliance-style container with a single HTTP entrypoint.

## Goals

- Build one deployable Docker image for self-host MVP usage.
- Expose exactly one HTTP port, defaulting to `8080`.
- Keep all service state under one persistent directory, defaulting to `/data`.
- Generate required secrets automatically on first boot when they do not already exist.
- Route all client traffic through one path-based HTTP reverse proxy.
- Keep the existing Compose deployment intact.
- Prefer a minimal production-like MVP over a full Supabase platform clone.

## Non-goals

- Do not support multi-node high availability in this mode.
- Do not expose raw MQTT TCP `1883`.
- Do not require external Postgres, S3, MQTT, SMTP, or secret manager.
- Do not enable Supabase Studio, Analytics, Vector, or Supavisor by default.
- Do not replace the existing Compose self-host path.

## Recommended Approach

Create a new all-in-one deployment target under:

```text
deploy/self-host/all-in-one/
```

The image runs multiple internal processes under a process supervisor, while exposing only one public port. Caddy is the only public listener. Internal services bind to `127.0.0.1` or the container network namespace on private ports.

Use `supervisord` for the first MVP because it is easy to inspect, package, and debug. `s6-overlay` can replace it later if shutdown ordering and service readiness become more complex.

## Runtime Components

Required MVP components:

- `postgres`: local application database and Supabase backing store
- `fc` in `BACKEND_KIND=postgres` mode: Cloud API, auth routes, and business data facade
- `minio`: S3-compatible object storage backed by local filesystem under `/data/minio`
- `emqx`: MQTT broker with WebSocket listener only for external clients
- `fc`: TeamClaw Cloud API facade
- `amuxd`: TeamClaw daemon process
- `caddy`: single public HTTP reverse proxy
- `migrate`: startup task, not a long-running service

Optional, disabled by default:

- Supabase Studio
- Analytics
- Vector log collector
- Supavisor
- raw MQTT TCP listener

## Public Routing

Expose one port from the container:

```text
8080/tcp
```

Recommended path routes:

| Public path | Internal target | Notes |
| --- | --- | --- |
| `/healthz` | local health aggregator or Caddy static response plus upstream checks | Platform health check target |
| `/v1/*` | `fc` on `127.0.0.1:9000` | Canonical TeamClaw Cloud API |
| `/api/*` | optional alias to `fc` | Convenience only if needed |
| `/v1/auth/*` | `fc` on `127.0.0.1:9000` | TeamClaw auth endpoints |
| `/storage/*` | MinIO on `127.0.0.1:9100` | Internal S3-compatible object storage |
| `/mqtt` | EMQX WebSocket listener | MQTT over WebSocket, not raw TCP |
| `/` | static landing page or docs | Can return deployment information |

The all-in-one mode must not rely on multiple hostnames such as `FC_DOMAIN`, `SUPABASE_DOMAIN`, `MQTT_DOMAIN`, `STUDIO_DOMAIN`, or `EMQX_DASHBOARD_DOMAIN`. Those remain Compose-mode features.

## Client Configuration

For this mode, generated client settings should use one base URL:

```text
PUBLIC_BASE_URL=https://example.com
CLOUD_API_URL=https://example.com/v1
SUPABASE_PUBLIC_URL=https://example.com
MQTT_WS_URL=wss://example.com/mqtt
```

For local testing:

```text
PUBLIC_BASE_URL=http://127.0.0.1:8080
CLOUD_API_URL=http://127.0.0.1:8080/v1
SUPABASE_PUBLIC_URL=http://127.0.0.1:8080
MQTT_WS_URL=ws://127.0.0.1:8080/mqtt
```

Clients must not use `mqtt://host:1883` in all-in-one mode.

## Data Layout

All mutable state lives under `/data`:

```text
/data/teamclaw/secrets.env
/data/teamclaw/runtime.env
/data/postgres/
/data/minio/
/data/emqx/
/data/amuxd/
/data/caddy/
/data/logs/
```

The container should also run with an ephemeral filesystem for application code. Only `/data` needs persistence.

## Secret Management

On first boot, `entrypoint.sh` creates `/data/teamclaw/secrets.env` with generated values if the file does not exist. On later boots, it reuses the existing file.

Generated secrets include:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `ANON_KEY`
- `SERVICE_ROLE_KEY`
- `EMQX_JWT_SECRET`
- `MQTT_SERVICE_TOKEN`
- `CRON_TRIGGER_SECRET`
- storage service secrets required by Supabase Storage

Secrets should be generated with cryptographically secure randomness. JWT-derived anon and service-role keys must be generated consistently from the persisted JWT secret and role claims.

## Startup Sequence

The entrypoint performs startup orchestration before handing off to the supervisor:

1. Create required `/data` directories.
2. Generate or load persisted secrets.
3. Render runtime config files into `/run/teamclaw/`.
4. Initialize Postgres data directory if empty.
5. Start Postgres.
6. Wait for Postgres readiness.
7. Apply Supabase baseline schema, app migrations, and seed data exactly once per migration version.
8. Start long-running services through supervisor.
9. Wait for Auth, REST, Storage, EMQX, and `fc` readiness.
10. Start Caddy or mark the container healthy once Caddy can proxy required upstreams.

The migration step must be idempotent. It should reuse the existing migration scripts from `services/supabase/` where possible.

## Health Checks

The container-level health check should call:

```text
http://127.0.0.1:8080/healthz
```

The health endpoint should verify at minimum:

- Caddy is serving the public port.
- `fc` responds on `/healthz` internally.
- Postgres accepts a simple query.
- EMQX WebSocket listener is up or EMQX management status is healthy.

MinIO health checks should verify the local S3-compatible listener is reachable. Legacy Supabase service checks are not part of the MVP because `fc` runs in Postgres backend mode.

## Build Structure

Proposed files:

```text
deploy/self-host/all-in-one/Dockerfile
deploy/self-host/all-in-one/README.md
deploy/self-host/all-in-one/entrypoint.sh
deploy/self-host/all-in-one/supervisord.conf
deploy/self-host/all-in-one/Caddyfile
deploy/self-host/all-in-one/render-config.sh
deploy/self-host/all-in-one/healthcheck.sh
deploy/self-host/all-in-one/smoke.sh
```

The Dockerfile should use multi-stage builds:

1. Build `services/fc`.
2. Build `amuxd` from the Rust workspace.
3. Assemble a Debian-based runtime with Postgres, EMQX, MinIO, Caddy, Node runtime, and the TeamClaw binaries.
4. Copy migrations, seed SQL, config templates, and startup scripts.

## Caddy Behavior

Caddy should be configured for plain HTTP inside the container. The platform can terminate TLS externally if it provides HTTPS. If the platform forwards HTTPS directly to the container, TLS support can be added later.

Caddy must support WebSocket upgrade headers for:

- `/mqtt`
- `/realtime/*`

Caddy must also rewrite path prefixes where upstreams expect root-based paths. For example, `/v1/*` may proxy directly to `fc`, while `/mqtt` may proxy to EMQX's `/mqtt` WebSocket endpoint without stripping.

## Migration from Compose Mode

This all-in-one mode is additive. Existing files stay valid:

- `deploy/self-host/docker-compose.yml`
- `deploy/self-host/supabase/docker-compose.yml`
- `deploy/self-host/bootstrap/*`

The new mode should have separate docs and commands:

```bash
docker build -f deploy/self-host/all-in-one/Dockerfile -t teamclaw-selfhost-allinone .
docker run --rm -p 8080:8080 -v teamclaw-data:/data teamclaw-selfhost-allinone
```

## Testing Strategy

Minimum smoke tests:

1. Build image successfully.
2. Start container with a fresh volume.
3. `GET /healthz` returns success.
4. Anonymous auth or signup flow succeeds when enabled.
5. A basic `/v1` Cloud API request succeeds.
6. Storage upload/download works through `/storage/*`.
7. MQTT WebSocket publish/subscribe works through `/mqtt`.
8. Restart container with the same volume and verify secrets/data persist.

## Risks

- The MVP intentionally uses the existing FC Postgres backend instead of embedding the full Supabase service stack; any future Supabase-compatible routes need separate packaging work.
- The all-in-one image will be large and memory-intensive.
- One-process failure handling depends on supervisor quality and health checks.
- In-container Postgres is acceptable for constrained self-host/demo usage but weaker than managed or separate database deployment for production.
- Path-based object storage routing may expose assumptions in clients or SDKs that expect virtual-hosted S3 URLs; the runtime sets path-style mode for the FC S3 client.
- MQTT over WebSocket must be fully supported by all target clients before raw TCP MQTT is removed from this mode.

## Acceptance Criteria

The MVP is complete when a user can run one image with one port and one volume, then use TeamClaw self-host features without editing external service configuration:

```bash
docker run -p 8080:8080 -v teamclaw-data:/data teamclaw-selfhost-allinone
```

After startup:

- `http://127.0.0.1:8080/healthz` is healthy.
- Cloud API is available at `http://127.0.0.1:8080/v1`.
- MQTT over WebSocket is available at `ws://127.0.0.1:8080/mqtt`.
- Data and generated secrets survive container restart.
- Existing Compose self-host deployment still works unchanged.
