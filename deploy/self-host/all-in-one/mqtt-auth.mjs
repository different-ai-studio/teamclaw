// Tiny dependency-free MQTT CONNECT auth hook for NanoMQ.
//
// NanoMQ posts form-encoded {username,password,clientid} on each MQTT CONNECT.
// We accept the connection iff `password` is a JWT with a valid HS256 signature
// over `header.payload` using the RAW JWT_SECRET (the same secret GoTrue signs
// with and that mints ANON_KEY / SERVICE_ROLE_KEY / MQTT_SERVICE_TOKEN), and it
// is not expired. Returns 200 to allow, 403 to deny. CONNECT-only gating — no
// per-topic ACL — which matches the previous EMQX setup (authenticate only).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const SECRETS_FILE = process.env.SECRETS_FILE || "/data/teamclaw/secrets.env";

function readSecret(key) {
  try {
    const txt = fs.readFileSync(SECRETS_FILE, "utf8");
    for (const line of txt.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i) === key) return line.slice(i + 1);
    }
  } catch {
    /* ignore */
  }
  return "";
}

const JWT_SECRET = process.env.JWT_SECRET || readSecret("JWT_SECRET");
if (!JWT_SECRET) {
  console.error("[mqtt-auth] JWT_SECRET not available; denying all connections");
}

function b64urlFromBuf(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyJwt(token) {
  if (!JWT_SECRET || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts;
  const expected = b64urlFromBuf(
    crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest(),
  );
  if (!timingSafeEq(sig, expected)) return false;
  // exp check (optional claim)
  try {
    const payload = JSON.parse(Buffer.from(p, "base64").toString("utf8"));
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }
  } catch {
    /* if payload isn't JSON the signature already matched our secret; allow */
  }
  return true;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/mqtt-auth")) {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1 << 20) req.destroy();
    });
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const ok = verifyJwt(params.get("password") || "");
      res.writeHead(ok ? 200 : 403, { "Content-Type": "text/plain" });
      res.end(ok ? "ok" : "denied");
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(9091, "127.0.0.1", () => {
  console.log("[mqtt-auth] listening on 127.0.0.1:9091");
});
