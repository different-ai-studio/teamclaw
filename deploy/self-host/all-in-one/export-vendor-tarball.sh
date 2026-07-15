#!/usr/bin/env bash
# Export the all-in-one image's grafted runtime into a single vendor tarball.
#
# Some corporate CI pipelines generate their own Dockerfile (base image +
# run_commands) and cannot express the multi-stage graft that assembles this
# image, nor reach the upstream registries. For those, build the image on a
# machine that can, export the graft paths with this script, host the tarball
# somewhere the pipeline can fetch (internal object storage), and have the
# pipeline's run_commands do:
#
#   apt-get update -y && apt-get install -y --no-install-recommends \
#     curl openssl netcat-openbsd gettext-base supervisor procps ca-certificates
#   getent passwd postgres >/dev/null || useradd -r -m -s /bin/bash postgres
#   curl -fSL -o /tmp/vendor.tar.gz "$VENDOR_URL"
#   echo "$VENDOR_SHA256  /tmp/vendor.tar.gz" | sha256sum -c -
#   tar -xzf /tmp/vendor.tar.gz -C / && rm /tmp/vendor.tar.gz
#   test -x /usr/local/bin/docker-entrypoint.sh \
#     && test -x /nix/var/nix/profiles/default/bin/psql \
#     && test -x /opt/teamclaw/entrypoint.sh \
#     && test -f /etc/supervisor/conf.d/teamclaw-all-in-one.conf
#
# entrypoint.sh prepends the nix profile to PATH itself, so no ENV/env wiring
# is needed on the deployment side. gzip (not zstd) because old Ubuntu bases
# (16.04) have no usable zstd.
#
# Usage: export-vendor-tarball.sh <image> [out.tar.gz]
set -euo pipefail

IMAGE="${1:?usage: export-vendor-tarball.sh <image> [out.tar.gz]}"
OUT="${2:-teamclaw-allinone-vendor-amd64.tar.gz}"

# Everything the runtime needs that is not repo glue on the base image:
# the Postgres nix closure + supabase first-boot machinery, storage-api and
# its musl node, PostgREST, GoTrue, NanoMQ, caddy(-l4), the musl loader, and
# the /opt/teamclaw glue (FC build, migrations, scripts, supervisord conf).
PATHS=(
  /nix
  /opt/storage
  /opt/pgrst
  /opt/teamclaw
  /docker-entrypoint-initdb.d
  /etc/postgresql
  /etc/postgresql-custom
  /etc/supervisor/conf.d/teamclaw-all-in-one.conf
  /usr/local/bin/gotrue
  /usr/local/bin/gosu
  /usr/local/bin/nanomq
  /usr/local/bin/docker-entrypoint.sh
  /usr/bin/caddy
  /lib/ld-musl-x86_64.so.1
  /usr/lib/libstdc++.so.6
  /usr/lib/libgcc_s.so.1
)

docker run --rm --platform=linux/amd64 --entrypoint tar "$IMAGE" \
  -cf - "${PATHS[@]}" 2>/dev/null | gzip -6 > "$OUT"

ls -lh "$OUT"
shasum -a 256 "$OUT" 2>/dev/null || sha256sum "$OUT"
