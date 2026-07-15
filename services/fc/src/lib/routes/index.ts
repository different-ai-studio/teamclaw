import { registerAuth } from "./auth.js";
import { registerTeams } from "./teams.js";
import { registerSessions } from "./sessions.js";
import { registerApps } from "./apps.js";
import { registerMessages } from "./messages.js";
import { registerInvites } from "./invites.js";
import { registerWorkspaces } from "./workspaces.js";
import { registerSystem } from "./system.js";
import { registerActors } from "./actors.js";
import { registerNotifications } from "./notifications.js";
import { registerIdeas } from "./ideas.js";
import { registerShortcuts } from "./shortcuts.js";
import { registerRuntime } from "./runtime.js";
import { registerAttachments } from "./attachments.js";
import { registerTelemetry } from "./telemetry.js";
import { registerConfig } from "./config.js";
import { registerDirectory } from "./directory.js";
import { registerSync } from "./sync.js";
import { registerTeamShare } from "./team-share.js";
import { registerTeamLiteLlm } from "./team-litellm.js";
import { registerAccount } from "./account.js";

export function registerAllRoutes(router) {
  registerAuth(router);
  registerAccount(router);
  registerTeams(router);
  registerSessions(router);
  registerApps(router);
  registerMessages(router);
  registerInvites(router);
  // team-share routes must be registered BEFORE workspaces so the new merged
  // GET /v1/teams/:teamId/workspace-config (share+litellm shape) wins over
  // the legacy default/pinned-workspace GET in workspaces.mjs. The legacy
  // PUT remains reachable since it's a distinct verb.
  registerTeamShare(router);
  registerTeamLiteLlm(router);
  registerWorkspaces(router);
  registerSystem(router);
  registerActors(router);
  registerNotifications(router);
  registerIdeas(router);
  registerShortcuts(router);
  registerRuntime(router);
  registerAttachments(router);
  registerTelemetry(router);
  registerConfig(router);
  registerDirectory(router);
  registerSync(router);
}

export { registerAuth, registerTeams, registerSessions, registerApps, registerMessages, registerInvites, registerWorkspaces, registerSystem, registerActors, registerNotifications, registerIdeas, registerShortcuts, registerRuntime, registerAttachments, registerTelemetry, registerConfig };