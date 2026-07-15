#!/usr/bin/env sh
set -eu

# --serve : run a tiny HTTP responder on :19090 that returns 200 when core
#           services (FC) are reachable. Caddy proxies /healthz here.
# (no arg): one-shot check used by the Docker HEALTHCHECK.

NODE=/opt/storage/bin/node

serve() {
  # Node's own http client (no dependency on a working system curl).
  exec "$NODE" -e '
    const http = require("http");
    function probe() {
      return new Promise((resolve) => {
        const req = http.get(
          { host: "127.0.0.1", port: 9000, path: "/healthz", timeout: 2000 },
          (r) => { r.resume(); resolve(r.statusCode === 200); }
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
    }
    http.createServer(async (req, res) => {
      const ok = await probe();
      res.writeHead(ok ? 200 : 503, { "Content-Type": "text/plain" });
      res.end(ok ? "ok" : "unavailable");
    }).listen(19090, "127.0.0.1");
  '
}

check_core() {
  # FC up
  "$NODE" -e '
    const http = require("http");
    const req = http.get(
      { host: "127.0.0.1", port: 9000, path: "/healthz", timeout: 3000 },
      (r) => { r.resume(); process.exit(r.statusCode === 200 ? 0 : 1); }
    );
    req.on("error", () => process.exit(1));
    req.on("timeout", () => { req.destroy(); process.exit(1); });
  ' || return 1
  # NanoMQ TCP + WebSocket listeners up
  nc -z 127.0.0.1 1883 >/dev/null 2>&1 || return 1
  nc -z 127.0.0.1 8083 >/dev/null 2>&1 || return 1
  return 0
}

case "${1:-}" in
  --serve) serve ;;
  *)       check_core ;;
esac
