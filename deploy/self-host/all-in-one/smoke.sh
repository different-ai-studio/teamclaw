#!/usr/bin/env bash
# Smoke test for the SUPABASE-mode all-in-one image.
set -euo pipefail

IMAGE="${IMAGE:-teamclaw-selfhost-allinone:local}"
CONTAINER="${CONTAINER:-teamclaw-allinone-smoke}"
VOLUME="${VOLUME:-teamclaw-allinone-smoke-data}"
PORT="${PORT:-18080}"
PLATFORM="${PLATFORM:-linux/arm64}"
# Overridable for a corporate-base variant Dockerfile, e.g.:
#   DOCKERFILE=<corporate-base Dockerfile> PLATFORM=linux/amd64 \
#   BUILD_ARGS="--build-arg BASE_IMAGE=ubuntu:16.04" IMAGE=teamclaw-allinone:corp ./smoke.sh
# SKIP_BUILD=1 reuses an already-built $IMAGE.
DOCKERFILE="${DOCKERFILE:-deploy/self-host/all-in-one/Dockerfile}"
BUILD_ARGS="${BUILD_ARGS:-}"
SKIP_BUILD="${SKIP_BUILD:-}"
BASE="http://127.0.0.1:$PORT"

# repo root = three levels up from this script (deploy/self-host/all-in-one)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; docker logs "$CONTAINER" 2>&1 | tail -60 >&2 || true; exit 1; }

wait_http() {
  local url="$1" tries="${2:-90}" i=1
  while [ "$i" -le "$tries" ]; do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 2; i=$((i + 1))
  done
  return 1
}

cleanup
docker volume rm "$VOLUME" >/dev/null 2>&1 || true

if [ -z "$SKIP_BUILD" ]; then
  echo "== build =="
  # shellcheck disable=SC2086
  docker build --platform="$PLATFORM" \
    -f "$DOCKERFILE" $BUILD_ARGS \
    -t "$IMAGE" "$ROOT"
fi

docker volume create "$VOLUME" >/dev/null
docker run -d --platform="$PLATFORM" --name "$CONTAINER" \
  -p "$PORT:8080" -v "$VOLUME:/data" "$IMAGE" >/dev/null

echo "== [1] /healthz (up to ~180s) =="
wait_http "$BASE/healthz" 90 || fail "/healthz never returned 200"
echo "  ok"

echo "== [2] landing string =="
curl -fsS "$BASE/" | grep -q "supabase mode" || fail "landing string missing"
echo "  ok"

echo "== read ANON_KEY / PG password from container =="
ANON_KEY="$(docker exec "$CONTAINER" sh -c '. /data/teamclaw/secrets.env; printf "%s" "$ANON_KEY"')"
PGPW="$(docker exec "$CONTAINER" sh -c '. /data/teamclaw/secrets.env; printf "%s" "$POSTGRES_PASSWORD"')"
[ -n "$ANON_KEY" ] || fail "ANON_KEY empty"

echo "== [3] PostgREST root /rest/v1/ (amux exposure) =="
code=""
for _ in 1 2 3 4 5 6; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON_KEY" "$BASE/rest/v1/")"
  [ "$code" = "200" ] && break
  sleep 3
done
[ "$code" = "200" ] || fail "/rest/v1/ returned $code (expected 200)"
echo "  ok (200)"

echo "== [4] schema: public.orgs/users/plans, amux schema, amux.teams =="
docker exec -e PGPASSWORD="$PGPW" "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -tAc \
  "select string_agg(table_name,',') from information_schema.tables where table_schema='public' and table_name in ('orgs','users','plans')" \
  | grep -q "orgs" || fail "public.orgs/users/plans missing"
docker exec -e PGPASSWORD="$PGPW" "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -tAc \
  "select 1 from information_schema.schemata where schema_name='amux'" | grep -q 1 || fail "amux schema missing"
docker exec -e PGPASSWORD="$PGPW" "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -tAc \
  "select count(*) from amux.teams" >/dev/null || fail "amux.teams not queryable"
echo "  ok"

echo "== [5] GoTrue /auth/v1/health =="
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/auth/v1/health")"
[ "$code" = "200" ] || fail "/auth/v1/health returned $code"
echo "  ok (200)"

echo "== [6] FC healthz =="
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/fc-health/healthz")"
[ "$code" = "200" ] || fail "/fc-health/healthz returned $code"
echo "  ok (200)"

echo "== [7] NanoMQ listeners (1883 TCP + 8083 WS) =="
docker exec "$CONTAINER" sh -c 'nc -z 127.0.0.1 1883 && nc -z 127.0.0.1 8083' \
  || fail "NanoMQ not listening on 1883/8083"
echo "  ok"

# Raw MQTT 3.1.1 CONNECT over TCP using the bundled node — assert CONNACK=0 for
# a valid token and a non-accept (CONNACK!=0 or disconnect) for a bad one.
MQTT_TESTER='
const net=require("net");
const pass=process.env.MQ_PASS||"", user=process.env.MQ_USER||"fc-service";
const cid="smoke-"+Date.now();
const mkstr=s=>{const b=Buffer.from(s),l=Buffer.alloc(2);l.writeUInt16BE(b.length);return Buffer.concat([l,b]);};
// keepalive=60 on purpose: the packet must contain NO 0x0A byte, so this also
// guards the layer4 matcher order (an http-first matcher hangs on newline-free
// MQTT CONNECTs until the matching timeout aborts the connection).
const vh=Buffer.concat([mkstr("MQTT"),Buffer.from([0x04,0xC2,0,60])]);
const payload=Buffer.concat([mkstr(cid),mkstr(user),mkstr(pass)]);
const body=Buffer.concat([vh,payload]);
const rl=n=>{const o=[];do{let d=n%128;n=Math.floor(n/128);if(n>0)d|=0x80;o.push(d);}while(n>0);return Buffer.from(o);};
const pkt=Buffer.concat([Buffer.from([0x10]),rl(body.length),body]);
const s=net.connect(Number(process.env.MQ_PORT||1883),process.env.MQ_HOST||"127.0.0.1");let done=false;
const fin=(msg,code)=>{if(done)return;done=true;clearTimeout(t);console.log(msg);try{s.destroy();}catch(e){}process.exit(code);};
const t=setTimeout(()=>fin("TIMEOUT",3),5000);
s.on("connect",()=>s.write(pkt));
s.on("data",d=>{ (d[0]===0x20&&d.length>=4)?fin("CONNACK="+d[3],d[3]===0?0:1):fin("UNEXPECTED="+d.toString("hex"),2);});
s.on("close",()=>fin("CLOSED",4));
s.on("error",e=>fin("ERR "+e.message,5));
'
MQTT_TOKEN="$(docker exec "$CONTAINER" sh -c '. /data/teamclaw/secrets.env; printf "%s" "$MQTT_SERVICE_TOKEN"')"

echo "== [8] MQTT CONNECT with valid token -> CONNACK 0 =="
out="$(docker exec -e MQ_USER=fc-service -e MQ_PASS="$MQTT_TOKEN" "$CONTAINER" /opt/storage/bin/node -e "$MQTT_TESTER" 2>&1)" \
  && echo "  ok ($out)" || fail "valid-token MQTT connect rejected: $out"

echo "== [9] MQTT CONNECT with bad token -> rejected =="
if docker exec -e MQ_USER=fc-service -e MQ_PASS="garbage.not.ajwt" "$CONTAINER" /opt/storage/bin/node -e "$MQTT_TESTER" >/tmp/mq_bad.out 2>&1; then
  fail "bad-token MQTT connect was ACCEPTED: $(cat /tmp/mq_bad.out)"
fi
echo "  ok ($(cat /tmp/mq_bad.out))"

echo "== [9b] raw MQTT through public :8080 (Caddy layer4 split) -> CONNACK 0 =="
out="$(docker exec -e MQ_HOST=127.0.0.1 -e MQ_PORT=8080 -e MQ_USER=fc-service -e MQ_PASS="$MQTT_TOKEN" "$CONTAINER" /opt/storage/bin/node -e "$MQTT_TESTER" 2>&1)" \
  && echo "  ok ($out)" || fail "raw MQTT via :8080 layer4 rejected: $out"

echo "== [10] validator endpoint (200 valid / 403 garbage) =="
c_ok="$(docker exec "$CONTAINER" sh -c ". /data/teamclaw/secrets.env; curl -s -o /dev/null -w '%{http_code}' -X POST --data-urlencode \"password=\$MQTT_SERVICE_TOKEN\" http://127.0.0.1:9091/mqtt-auth")"
c_bad="$(docker exec "$CONTAINER" sh -c "curl -s -o /dev/null -w '%{http_code}' -X POST --data 'password=garbage' http://127.0.0.1:9091/mqtt-auth")"
[ "$c_ok" = "200" ] || fail "validator rejected valid token ($c_ok)"
[ "$c_bad" = "403" ] || fail "validator accepted garbage ($c_bad)"
echo "  ok (valid=200 garbage=403)"

echo "== [11] restart persistence =="
docker restart "$CONTAINER" >/dev/null
wait_http "$BASE/healthz" 90 || fail "/healthz not 200 after restart"
echo "  ok"

echo "== [12] secrets persisted =="
docker exec "$CONTAINER" test -s /data/teamclaw/secrets.env || fail "secrets.env missing/empty"
echo "  ok"

echo "all-in-one (supabase) smoke passed"
