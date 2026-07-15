function publicRules(config) {
  return {
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    ...config,
  };
}

function text(name, opts = {}) {
  return { name, type: "text", max: opts.max ?? 0, required: opts.required ?? false };
}

function date(name, opts = {}) {
  return { name, type: "date", required: opts.required ?? false };
}

function json(name, opts = {}) {
  return { name, type: "json", maxSize: opts.maxSize ?? 2_000_000, required: opts.required ?? false };
}

function bool(name, opts = {}) {
  return { name, type: "bool", required: opts.required ?? false };
}

function number(name, opts = {}) {
  return { name, type: "number", required: opts.required ?? false };
}

function select(name, values, opts = {}) {
  return {
    name,
    type: "select",
    values,
    maxSelect: opts.maxSelect ?? 1,
    required: opts.required ?? false,
  };
}

function relation(name, collection, opts = {}) {
  return {
    name,
    type: "relation",
    collectionId: collection.id,
    maxSelect: opts.maxSelect ?? 1,
    required: opts.required ?? false,
    cascadeDelete: opts.cascadeDelete ?? false,
  };
}

function saveCollection(app, collection) {
  app.save(collection);
  return collection;
}

function createRecord(app, collection, values) {
  const record = new Record(collection);
  for (const [key, value] of Object.entries(values)) {
    if (key === "email") record.setEmail(value);
    else if (key === "password") record.setPassword(value);
    else if (key === "verified") record.setVerified(value);
    else record.set(key, value);
  }
  app.save(record);
  return record;
}

migrate((app) => {
  const accounts = saveCollection(app, new Collection({
    name: "accounts",
    type: "auth",
    fields: [
      text("display_name", { max: 160 }),
      bool("is_daemon"),
    ],
    passwordAuth: {
      enabled: true,
      identityFields: ["email"],
    },
  }));

  const teams = saveCollection(app, new Collection(publicRules({
    name: "teams",
    type: "base",
    fields: [
      text("name", { required: true, max: 160 }),
      text("slug", { max: 160 }),
    ],
  })));

  const actors = saveCollection(app, new Collection(publicRules({
    name: "actors",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("account", accounts),
      select("actor_type", ["member", "agent", "external"], { required: true }),
      text("display_name", { max: 160 }),
      text("avatar_url", { max: 1000 }),
      date("last_active_at"),
      text("source", { max: 80 }),
      text("source_id", { max: 200 }),
      json("agent_types"),
      text("default_agent_type", { max: 80 }),
      text("default_workspace_id", { max: 64 }),
      text("device_id", { max: 200 }),
      text("visibility", { max: 40 }),
    ],
  })));

  const workspaces = saveCollection(app, new Collection(publicRules({
    name: "workspaces",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("agent", actors),
      text("name", { required: true, max: 160 }),
      text("path", { max: 1000 }),
      json("metadata"),
      date("archived_at"),
    ],
  })));

  const teamMembers = saveCollection(app, new Collection(publicRules({
    name: "team_members",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("actor", actors, { required: true, cascadeDelete: true }),
      select("role", ["owner", "admin", "member"], { required: true }),
      select("status", ["active", "invited", "disabled"], { required: true }),
      date("joined_at"),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_team_members_team_actor ON team_members (team, actor)",
    ],
  })));

  const agentAccess = saveCollection(app, new Collection(publicRules({
    name: "agent_member_access",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("agent_actor", actors, { required: true, cascadeDelete: true }),
      relation("member_actor", actors, { required: true, cascadeDelete: true }),
      select("permission_level", ["view", "prompt", "admin"], { required: true }),
      relation("granted_by_member_actor", actors),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_agent_access_pair ON agent_member_access (agent_actor, member_actor)",
    ],
  })));

  saveCollection(app, new Collection(publicRules({
    name: "team_invites",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      text("token_hash", { required: true, max: 256 }),
      select("actor_type", ["member", "agent"], { required: true }),
      text("display_name", { max: 160 }),
      select("team_role", ["owner", "admin", "member"]),
      text("agent_kind", { max: 80 }),
      relation("target_actor", actors),
      date("expires_at"),
      date("claimed_at"),
    ],
  })));

  const sessions = saveCollection(app, new Collection(publicRules({
    name: "sessions",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      text("title", { required: true, max: 300 }),
      select("mode", ["solo", "collab", "control"], { required: true }),
      relation("primary_agent", actors),
      relation("created_by_actor", actors),
      text("idea_id", { max: 64 }),
      text("summary", { max: 2000 }),
      text("acp_session_id", { max: 200 }),
      text("binding", { max: 300 }),
      text("last_message_preview", { max: 500 }),
      date("last_message_at"),
      date("archived_at"),
    ],
  })));

  const participants = saveCollection(app, new Collection(publicRules({
    name: "session_participants",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("session", sessions, { required: true, cascadeDelete: true }),
      relation("actor", actors, { required: true, cascadeDelete: true }),
      select("role", ["owner", "member", "agent"], { required: true }),
      date("joined_at"),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_session_participants_pair ON session_participants (session, actor)",
    ],
  })));

  const messages = saveCollection(app, new Collection(publicRules({
    name: "messages",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("session", sessions, { required: true, cascadeDelete: true }),
      relation("sender_actor", actors),
      select("kind", ["text", "agent_reply", "tool", "system"], { required: true }),
      text("content", { max: 200000 }),
      json("metadata"),
      text("model", { max: 200 }),
      text("turn_id", { max: 200 }),
      text("reply_to_message_id", { max: 64 }),
      text("external_id", { max: 300 }),
      json("attachments"),
      number("sequence"),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_messages_session_external ON messages (session, external_id) WHERE external_id != ''",
    ],
  })));

  const agentRuntimes = saveCollection(app, new Collection(publicRules({
    name: "agent_runtimes",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      relation("agent", actors, { required: true, cascadeDelete: true }),
      relation("session", sessions),
      relation("workspace", workspaces),
      text("backend_type", { max: 80 }),
      text("backend_session_id", { max: 300 }),
      text("runtime_id", { max: 300 }),
      select("status", ["running", "idle", "stopped", "error"], { required: true }),
      text("current_model", { max: 200 }),
      relation("last_processed_message", messages),
      date("last_seen_at"),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_agent_runtimes_agent_backend ON agent_runtimes (agent, backend_session_id)",
    ],
  })));

  saveCollection(app, new Collection(publicRules({
    name: "external_actor_keys",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      text("source", { required: true, max: 80 }),
      text("source_id", { required: true, max: 300 }),
      relation("actor", actors, { required: true, cascadeDelete: true }),
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_external_actor_keys_key ON external_actor_keys (team, source, source_id)",
    ],
  })));

  saveCollection(app, new Collection(publicRules({
    name: "team_workspace_config",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      text("workspace_path", { max: 1000 }),
      text("git_url", { max: 1000 }),
      text("git_branch", { max: 200 }),
      text("git_token", { max: 1000 }),
      text("ai_gateway_endpoint", { max: 1000 }),
      bool("enabled"),
      json("metadata"),
    ],
  })));

  saveCollection(app, new Collection(publicRules({
    name: "ideas",
    type: "base",
    fields: [
      relation("team", teams, { required: true, cascadeDelete: true }),
      text("title", { required: true, max: 300 }),
      text("description", { max: 20000 }),
      select("status", ["open", "in_progress", "done", "archived"]),
      relation("created_by_actor", actors),
      number("sort_order"),
      bool("archived"),
    ],
  })));

  const memberAccount = createRecord(app, accounts, {
    email: "preview+member@teamclaw.local",
    password: "teamclaw-preview",
    verified: true,
    display_name: "Preview User",
    is_daemon: false,
  });
  const daemonAccount = createRecord(app, accounts, {
    email: "preview+daemon@teamclaw.local",
    password: "teamclaw-preview",
    verified: true,
    display_name: "Preview Agent",
    is_daemon: true,
  });
  const team = createRecord(app, teams, {
    name: "PocketBase Preview",
    slug: "pocketbase-preview",
  });
  const memberActor = createRecord(app, actors, {
    team: team.id,
    account: memberAccount.id,
    actor_type: "member",
    display_name: "Preview User",
    last_active_at: new Date().toISOString(),
  });
  const agentActor = createRecord(app, actors, {
    team: team.id,
    account: daemonAccount.id,
    actor_type: "agent",
    display_name: "Preview Agent",
    agent_types: ["codex", "claude", "opencode"],
    default_agent_type: "codex",
    visibility: "team",
    last_active_at: new Date().toISOString(),
  });
  createRecord(app, teamMembers, {
    team: team.id,
    actor: memberActor.id,
    role: "owner",
    status: "active",
    joined_at: new Date().toISOString(),
  });
  createRecord(app, agentAccess, {
    team: team.id,
    agent_actor: agentActor.id,
    member_actor: memberActor.id,
    permission_level: "admin",
    granted_by_member_actor: memberActor.id,
  });
  const workspace = createRecord(app, workspaces, {
    team: team.id,
    agent: agentActor.id,
    name: "preview-integration",
    path: "/Volumes/openbeta/workspace/teamclaw-v2/.worktrees/preview-integration",
    metadata: {},
  });
  agentActor.set("default_workspace_id", workspace.id);
  app.save(agentActor);
  const session = createRecord(app, sessions, {
    team: team.id,
    title: "PocketBase smoke test",
    mode: "collab",
    primary_agent: agentActor.id,
    created_by_actor: memberActor.id,
    last_message_preview: "PocketBase preview is ready.",
    last_message_at: new Date().toISOString(),
  });
  createRecord(app, participants, {
    team: team.id,
    session: session.id,
    actor: memberActor.id,
    role: "owner",
    joined_at: new Date().toISOString(),
  });
  createRecord(app, participants, {
    team: team.id,
    session: session.id,
    actor: agentActor.id,
    role: "agent",
    joined_at: new Date().toISOString(),
  });
  createRecord(app, messages, {
    team: team.id,
    session: session.id,
    sender_actor: agentActor.id,
    kind: "agent_reply",
    content: "PocketBase local preview is seeded. Core daemon writes are still being wired.",
    metadata: {},
    sequence: 1,
  });
  createRecord(app, agentRuntimes, {
    team: team.id,
    agent: agentActor.id,
    workspace: workspace.id,
    backend_type: "codex",
    backend_session_id: "pb-preview",
    runtime_id: "pb-preview-runtime",
    status: "idle",
    current_model: "codex",
    last_seen_at: new Date().toISOString(),
  });
}, (app) => {
  [
    "agent_runtimes",
    "messages",
    "session_participants",
    "sessions",
    "ideas",
    "team_workspace_config",
    "external_actor_keys",
    "agent_member_access",
    "team_members",
    "workspaces",
    "actors",
    "team_invites",
    "teams",
    "accounts",
  ].forEach((name) => {
    try {
      app.delete(app.findCollectionByNameOrId(name));
    } catch (_) {
      // ignore partially applied local migration cleanup
    }
  });
});
