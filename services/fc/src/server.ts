import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { resolveBackendKind } from "./lib/backend-kind.js";
import { makeBusinessRepoFactory, makeAuthRepoFactory } from "./index.js";
import { runCronTask } from "./lib/cron.js";
import { getDb } from "./db/client.js";

const kind = resolveBackendKind();

const app = createApp({
  createRepository: makeBusinessRepoFactory(kind),
  createAuthRepository: makeAuthRepoFactory(kind),
  runCron: (task: string) => runCronTask(getDb(), task),
});

const parsedPort = Number(process.env.PORT);
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 9000;
const hostname = process.env.HOST ?? "0.0.0.0";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[fc] listening on http://${hostname}:${info.port} (backend=${kind})`);
});
