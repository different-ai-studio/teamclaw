#!/usr/bin/env sh
# Storage smoke: create a public bucket, upload a PNG via the Storage API
# (through Kong), download it via the public URL, and verify the bytes round-trip.
#
# Run AFTER `docker compose up -d` while the stack is healthy:
#   ./smoke/image-upload.sh
#
# Exercises the storage data-path (storage-api + Kong route + db storage schema)
# independently of the application's business migrations. Uses the service-role
# key from .env, which bypasses RLS — this is a self-host operator smoke, not an
# end-user auth test.
set -eu

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
PROJECT="${COMPOSE_PROJECT:-teamclaw-self-host}"
NET="${PROJECT}_default"
BUCKET="${BUCKET:-smoke-images}"
OBJECT="${OBJECT:-test.png}"

[ -f "$ENV_FILE" ] || { echo "FAIL: $ENV_FILE not found (run gen-secrets + docker compose up first)"; exit 1; }
SRK="$(grep '^SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$SRK" ] || { echo "FAIL: SERVICE_ROLE_KEY missing from $ENV_FILE"; exit 1; }

# 1x1 transparent PNG (70 bytes)
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

docker run --rm --network "$NET" \
  -e SRK="$SRK" -e B64="$PNG_B64" -e BUCKET="$BUCKET" -e OBJECT="$OBJECT" \
  curlimages/curl:8.10.1 sh -c '
    set -e
    echo "$B64" | base64 -d > /tmp/in.png
    # create bucket (ignore 409 if it already exists from a previous run)
    curl -s -o /dev/null -w "create-bucket HTTP %{http_code}\n" -X POST \
      "http://kong:8000/storage/v1/bucket" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: application/json" \
      -d "{\"id\":\"$BUCKET\",\"name\":\"$BUCKET\",\"public\":true}"
    # Use PUT (upsert) so re-running the smoke test after a previous run succeeds
    up=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
      "http://kong:8000/storage/v1/object/$BUCKET/$OBJECT" \
      -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H "Content-Type: image/png" \
      --data-binary @/tmp/in.png)
    echo "upload HTTP $up"
    [ "$up" = "200" ] || { echo "FAIL: upload returned $up"; exit 1; }
    dl=$(curl -s -o /tmp/out.png -w "%{http_code}:%{content_type}:%{size_download}" \
      "http://kong:8000/storage/v1/object/public/$BUCKET/$OBJECT")
    echo "download $dl"
    code=${dl%%:*}
    [ "$code" = "200" ] || { echo "FAIL: download returned $code"; exit 1; }
    cmp -s /tmp/in.png /tmp/out.png || { echo "FAIL: downloaded bytes differ from uploaded"; exit 1; }
    echo "PASS: image uploaded and round-tripped byte-for-byte"
  '
