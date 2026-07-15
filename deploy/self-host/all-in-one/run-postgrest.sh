#!/usr/bin/env sh
# Launch the glibc PostgREST binary on the Alpine/musl base by invoking it
# through its own bundled glibc dynamic loader + shared libraries.
set -eu

ENV_FILE="${1:-/run/teamclaw/postgrest/env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

GLIBC=/opt/pgrst/glibc
if [ -d "$GLIBC" ]; then
  # arm64 image: glibc binary launched through its bundled loader.
  exec "$GLIBC/ld-linux-aarch64.so.1" \
    --library-path "$GLIBC/lib:$GLIBC/usrlib" \
    /opt/pgrst/postgrest
fi
# amd64 (corporate-base variant): static musl binary, runs directly.
exec /opt/pgrst/postgrest
