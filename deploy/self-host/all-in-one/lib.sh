#!/usr/bin/env sh
set -eu

log() {
  printf '[teamclaw-allinone] %s\n' "$*" >&2
}

fatal() {
  printf '[teamclaw-allinone] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "missing required command: $1"
}

rand_hex() {
  bytes="${1:-32}"
  openssl rand -hex "$bytes"
}

rand_base64_url() {
  bytes="${1:-32}"
  openssl rand -base64 "$bytes" | tr '+/' '-_' | tr -d '=\n'
}

ensure_dir() {
  mkdir -p "$1"
}

write_env_value() {
  file="$1"
  key="$2"
  value="$3"
  ensure_dir "$(dirname "$file")"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$file" > "${file}.tmp"
    mv "${file}.tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

read_env_value() {
  file="$1"
  key="$2"
  grep "^${key}=" "$file" | tail -n 1 | cut -d= -f2-
}

ensure_env_value() {
  file="$1"
  key="$2"
  generator="$3"
  if [ -f "$file" ] && grep -q "^${key}=" "$file"; then
    read_env_value "$file" "$key"
    return 0
  fi
  value="$($generator)"
  write_env_value "$file" "$key" "$value"
  printf '%s\n' "$value"
}

wait_for_tcp() {
  host="$1"
  port="$2"
  label="$3"
  attempts="${4:-60}"
  i=1
  while [ "$i" -le "$attempts" ]; do
    if nc -z "$host" "$port" >/dev/null 2>&1; then
      log "$label is ready at $host:$port"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  fatal "$label did not become ready at $host:$port"
}

wait_for_http() {
  url="$1"
  label="$2"
  attempts="${3:-60}"
  i=1
  while [ "$i" -le "$attempts" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is ready at $url"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  fatal "$label did not become ready at $url"
}

jwt_base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

jwt_sign_hs256() {
  secret="$1"
  header="$2"
  payload="$3"
  header_b64="$(printf '%s' "$header" | jwt_base64url)"
  payload_b64="$(printf '%s' "$payload" | jwt_base64url)"
  signing_input="${header_b64}.${payload_b64}"
  signature="$(printf '%s' "$signing_input" | openssl dgst -sha256 -hmac "$secret" -binary | jwt_base64url)"
  printf '%s.%s\n' "$signing_input" "$signature"
}
