# syntax=docker/dockerfile:1
#
# TeamClaw self-host all-in-one — SUPABASE mode.
#
# Runtime base is the real supabase/postgres image (Alpine + nix), which on
# first boot creates the Supabase roles (anon/authenticated/service_role/
# authenticator/supabase_auth_admin/supabase_storage_admin/...), the `auth`
# schema + tables, the `extensions` schema, and the `storage` schema. We layer
# GoTrue, PostgREST, storage-api, NanoMQ, FC and Caddy on top and run them all
# under supervisord behind Caddy on :8080.
#
# NOTE ON ARCH: the supabase/postgres base is Alpine/musl. GoTrue's `auth` is a
# static Go binary (runs anywhere). storage-api ships its own musl node (runs
# natively). PostgREST is a glibc (Ubuntu) binary, so we bundle its glibc
# loader + shared libs and launch it through that loader. FC is pure JS and is
# run with storage-api's bundled musl node. Build target arch is arm64 (see
# smoke.sh `--platform=linux/arm64`); the glibc lib paths below are arch-named.

# ---- FC build (pure-JS output; run later with musl node) -------------------
FROM node:20-slim AS fc-build
WORKDIR /src
COPY services/fc/package.json services/fc/package-lock.json services/fc/.npmrc ./
RUN npm ci
COPY services/fc ./
RUN npm run build
RUN npm ci --omit=dev && npm cache clean --force

# ---- Binary source images --------------------------------------------------
FROM public.ecr.aws/supabase/gotrue:v2.188.1 AS gotrue-image
FROM public.ecr.aws/supabase/postgrest:v14.10 AS postgrest-image
FROM public.ecr.aws/supabase/storage-api:v1.54.1 AS storage-image
FROM emqx/nanomq:0.23.10 AS nanomq-image

# Caddy with the layer4 plugin (github.com/mholt/caddy-l4): the public :8080
# does L4 protocol sniffing so plain HTTP/WS and raw MQTT TCP share one port.
FROM caddy:2-builder AS caddy-build
RUN xcaddy build --with github.com/mholt/caddy-l4 --output /usr/bin/caddy

# ---- Runtime ---------------------------------------------------------------
FROM public.ecr.aws/supabase/postgres:17.6.1.106 AS runtime
ENV DATA_DIR=/data
ENV RUN_DIR=/run/teamclaw

# Alpine base. `su`/`gosu` already present; add the rest.
RUN apk add --no-cache \
      bash ca-certificates curl openssl gettext netcat-openbsd supervisor procps

# GoTrue: static Go binary; CMD is `auth`. Run it as `gotrue`.
COPY --from=gotrue-image /usr/local/bin/auth /usr/local/bin/gotrue

# PostgREST (glibc) + its glibc loader & shared libs (arm64 paths).
COPY --from=postgrest-image /usr/bin/postgrest            /opt/pgrst/postgrest
COPY --from=postgrest-image /lib/ld-linux-aarch64.so.1    /opt/pgrst/glibc/ld-linux-aarch64.so.1
COPY --from=postgrest-image /lib/aarch64-linux-gnu        /opt/pgrst/glibc/lib
COPY --from=postgrest-image /usr/lib/aarch64-linux-gnu    /opt/pgrst/glibc/usrlib

# storage-api: whole app + its bundled musl node (also reused to run FC).
COPY --from=storage-image /app                 /opt/storage
COPY --from=storage-image /usr/local/bin/node  /opt/storage/bin/node

# NanoMQ — musl/Alpine MQTT broker, runs natively on the base. CONNECT auth is
# delegated to our JWT validator via NanoMQ's HTTP auth hook (see nanomq.conf).
COPY --from=nanomq-image /usr/local/nanomq/nanomq /usr/local/bin/nanomq

COPY --from=caddy-build /usr/bin/caddy /usr/bin/caddy

# FC (pure JS; executed with the musl node above)
COPY --from=fc-build /src/package.json  /opt/teamclaw/fc/package.json
COPY --from=fc-build /src/node_modules  /opt/teamclaw/fc/node_modules
COPY --from=fc-build /src/dist          /opt/teamclaw/fc/dist

# Real Supabase migrations (baseline creates public.orgs/users/plans + amux.*)
COPY services/supabase/migrations /opt/teamclaw/supabase-migrations

# Self-host glue
COPY deploy/self-host/all-in-one/apply-migrations.sh   /opt/teamclaw/apply-migrations.sh
COPY deploy/self-host/all-in-one/lib.sh                /opt/teamclaw/lib.sh
COPY deploy/self-host/all-in-one/render-config.sh      /opt/teamclaw/render-config.sh
COPY deploy/self-host/all-in-one/entrypoint.sh         /opt/teamclaw/entrypoint.sh
COPY deploy/self-host/all-in-one/healthcheck.sh        /opt/teamclaw/healthcheck.sh
COPY deploy/self-host/all-in-one/run-postgrest.sh      /opt/teamclaw/run-postgrest.sh
COPY deploy/self-host/all-in-one/roles.sql             /opt/teamclaw/roles.sql
COPY deploy/self-host/all-in-one/jwt.sql               /opt/teamclaw/jwt.sql
COPY deploy/self-host/all-in-one/Caddyfile.template    /opt/teamclaw/Caddyfile.template
COPY deploy/self-host/all-in-one/nanomq.conf.template  /opt/teamclaw/nanomq.conf.template
COPY deploy/self-host/all-in-one/mqtt-auth.mjs         /opt/teamclaw/mqtt-auth.mjs
COPY deploy/self-host/all-in-one/supervisord.conf      /etc/supervisor/conf.d/teamclaw-all-in-one.conf

RUN chmod +x \
      /opt/teamclaw/apply-migrations.sh \
      /opt/teamclaw/lib.sh \
      /opt/teamclaw/render-config.sh \
      /opt/teamclaw/entrypoint.sh \
      /opt/teamclaw/healthcheck.sh \
      /opt/teamclaw/run-postgrest.sh \
      /opt/storage/bin/node

WORKDIR /opt/teamclaw
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=6 \
  CMD /opt/teamclaw/healthcheck.sh
ENTRYPOINT ["/opt/teamclaw/entrypoint.sh"]
