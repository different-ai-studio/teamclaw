-- 团队 MCP 配置 + 团队 env 的服务端表。
--
-- 背景见 docs/architecture/team-mcp-and-env-cloud.md。这两样东西此前都躺在
-- git/OSS 同步的团队目录里（`.mcp/*.json` 和 `_secrets/<key_id>.enc.json`），
-- 本次搬到 Cloud API，git/OSS 同步退化成只管文档（knowledge/）。
--
-- 三张表：
--   team_mcp_servers   团队 MCP 目录，每个 server 一行
--   team_mcp_installs  谁装了哪个 server
--   team_env_secrets   团队 env，只存密文信封
--
-- 两个设计要点：
--
-- 1. **MCP 从「自动下发」改成「目录 + 每人选装」。** 之前 `.mcp/` 整个目录同步
--    给所有成员并被 materialize 进每个人的 opencode.json——而 MCP server 的
--    `command` 是要在成员机器上 spawn 的，等于任何能 push 团队仓库的人都能在
--    全团队机器上执行任意命令。改成安装制后，加进目录不等于生效，必须本人装。
--
-- 2. **团队 env 的明文永远不进这里。** 客户端用团队密钥 AES-256-GCM 加密后
--    只上传信封 {v, nonce, ciphertext}，服务端（含 self-host 的 DB 运维方）
--    拿不到明文。这与之前落在 OSS 上的加密模型完全一致，只是换了存储介质。
--
-- Idempotent：self-host 的 apply-migrations 循环会重复执行。

-- ---------------------------------------------------------------------------
-- 1. team_mcp_servers
-- ---------------------------------------------------------------------------
create table if not exists amux.team_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  -- Cursor mcpServers 里的 key。团队内唯一。
  name text not null,
  transport text not null,
  -- local：可执行文件 + 参数数组
  command text,
  args jsonb,
  -- remote：URL + 请求头
  url text,
  headers jsonb,
  env jsonb,
  description text,
  -- 归属信息不该有能力阻止删成员：作者离职了，server 定义仍要读得到。
  -- 与 team_skills.owner_actor_id 同样的取舍，理由见那张表的注释。
  created_by uuid references amux.actors(id) on delete set null,
  updated_by uuid references amux.actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_mcp_servers_name_format
    check (name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint team_mcp_servers_transport_valid
    check (transport in ('local', 'remote')),
  -- 两种 transport 各自的必填项。写成等价式而不是两条 or，是为了让
  -- 「remote 却带了 command」这类矛盾配置也被挡住。
  constraint team_mcp_servers_remote_needs_url
    check ((transport = 'remote') = (url is not null)),
  constraint team_mcp_servers_local_needs_command
    check ((transport = 'local') = (command is not null))
);

create unique index if not exists uniq_team_mcp_servers_team_name
  on amux.team_mcp_servers (team_id, name);

create index if not exists idx_team_mcp_servers_team
  on amux.team_mcp_servers (team_id);

-- ---------------------------------------------------------------------------
-- 2. team_mcp_installs
-- ---------------------------------------------------------------------------
-- 没有 scope/workspace 维度（team_skill_installs 有）：MCP server 是按
-- runtime 装的，不存在「只在某个 workspace 生效」的语义。需要时再加。
create table if not exists amux.team_mcp_installs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  actor_id uuid not null references amux.actors(id) on delete cascade,
  server_id uuid not null references amux.team_mcp_servers(id) on delete cascade,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uniq_team_mcp_install
  on amux.team_mcp_installs (actor_id, server_id);

create index if not exists idx_team_mcp_installs_actor
  on amux.team_mcp_installs (actor_id);

create index if not exists idx_team_mcp_installs_server
  on amux.team_mcp_installs (server_id);

-- ---------------------------------------------------------------------------
-- 3. team_env_secrets
-- ---------------------------------------------------------------------------
create table if not exists amux.team_env_secrets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  -- 与桌面端 validate_key_id 同规则（1–64，小写字母/数字/下划线）。
  key_id text not null,
  -- 客户端加密的信封。description / category / createdBy 这些元数据都在
  -- 密文里面（见 crates/teamclu-runtime-env/src/team_crypto.rs 的
  -- SecretEntry），服务端读不到——所以下面判权用的 created_by 必须是
  -- 独立的明文列，不能指望从信封里取。
  envelope jsonb not null,
  created_by uuid references amux.actors(id) on delete set null,
  updated_by uuid references amux.actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_env_secrets_key_id_format
    check (key_id ~ '^[a-z0-9_]{1,64}$'),
  -- 挡住「明文误传」这类最低级的错误：信封必须三个字段齐全。
  constraint team_env_secrets_envelope_shape
    check (
      envelope ? 'v'
      and envelope ? 'nonce'
      and envelope ? 'ciphertext'
    )
);

create unique index if not exists uniq_team_env_secrets_team_key
  on amux.team_env_secrets (team_id, key_id);

create index if not exists idx_team_env_secrets_team
  on amux.team_env_secrets (team_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at 触发器
-- ---------------------------------------------------------------------------
drop trigger if exists team_mcp_servers_bump_updated_at on amux.team_mcp_servers;
create trigger team_mcp_servers_bump_updated_at
  before update on amux.team_mcp_servers
  for each row execute function amux.bump_updated_at();

drop trigger if exists team_mcp_installs_bump_updated_at on amux.team_mcp_installs;
create trigger team_mcp_installs_bump_updated_at
  before update on amux.team_mcp_installs
  for each row execute function amux.bump_updated_at();

drop trigger if exists team_env_secrets_bump_updated_at on amux.team_env_secrets;
create trigger team_env_secrets_bump_updated_at
  before update on amux.team_env_secrets
  for each row execute function amux.bump_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
alter table amux.team_mcp_servers enable row level security;
alter table amux.team_mcp_installs enable row level security;
alter table amux.team_env_secrets enable row level security;

-- 目录对全体成员可见——和 skills 一样，市场就是要全量可见，噪音由
-- 「装了才生效」解决，不是由隐藏解决。
drop policy if exists team_mcp_servers_select_if_member on amux.team_mcp_servers;
create policy team_mcp_servers_select_if_member on amux.team_mcp_servers
  for select using (amux.is_team_member(team_id));

-- 任何成员都能往目录里加。之所以敢放开，正是因为「加」不再等于「在别人机器上
-- 生效」——生效要本人安装。
drop policy if exists team_mcp_servers_insert_if_member on amux.team_mcp_servers;
create policy team_mcp_servers_insert_if_member on amux.team_mcp_servers
  for insert with check (amux.is_team_member(team_id));

drop policy if exists team_mcp_servers_update_if_creator_or_admin on amux.team_mcp_servers;
create policy team_mcp_servers_update_if_creator_or_admin on amux.team_mcp_servers
  for update using (
    amux.is_team_admin_or_owner(team_id)
    or created_by = amux.current_actor_id_for_team(team_id)
  );

drop policy if exists team_mcp_servers_delete_if_creator_or_admin on amux.team_mcp_servers;
create policy team_mcp_servers_delete_if_creator_or_admin on amux.team_mcp_servers
  for delete using (
    amux.is_team_admin_or_owner(team_id)
    or created_by = amux.current_actor_id_for_team(team_id)
  );

-- 安装记录对全体成员可见（要能看出某个 server 在团队里的铺开情况）。
drop policy if exists team_mcp_installs_select_if_member on amux.team_mcp_installs;
create policy team_mcp_installs_select_if_member on amux.team_mcp_installs
  for select using (amux.is_team_member(team_id));

-- 写入只有一条闸门：**只能装给自己**。
--
-- 比 team_skill_installs 更严（那里管理员还能装给 visibility='team' 的共享
-- agent）。这里不放这个口子是因为 MCP 的 command 会在宿主机上执行，多一条
-- 「别人能替你决定装什么」的路径就多一分横向移动的面。团队共享 agent 真需要
-- MCP 时再单独设计。
drop policy if exists team_mcp_installs_write_self_only on amux.team_mcp_installs;
create policy team_mcp_installs_write_self_only on amux.team_mcp_installs
  for all using (
    amux.is_team_member(team_id)
    and actor_id = amux.current_actor_id_for_team(team_id)
  ) with check (
    amux.is_team_member(team_id)
    and actor_id = amux.current_actor_id_for_team(team_id)
  );

-- 团队 env：成员可读可写（值本来就是团队共享的，且服务端只见密文）。
drop policy if exists team_env_secrets_select_if_member on amux.team_env_secrets;
create policy team_env_secrets_select_if_member on amux.team_env_secrets
  for select using (amux.is_team_member(team_id));

drop policy if exists team_env_secrets_insert_if_member on amux.team_env_secrets;
create policy team_env_secrets_insert_if_member on amux.team_env_secrets
  for insert with check (amux.is_team_member(team_id));

drop policy if exists team_env_secrets_update_if_member on amux.team_env_secrets;
create policy team_env_secrets_update_if_member on amux.team_env_secrets
  for update using (amux.is_team_member(team_id));

-- 删除收紧到创建者本人或管理员：改一个值是协作，删掉一个 key 会让所有人的
-- runtime 少一个环境变量，破坏性不对等。
drop policy if exists team_env_secrets_delete_if_creator_or_admin on amux.team_env_secrets;
create policy team_env_secrets_delete_if_creator_or_admin on amux.team_env_secrets
  for delete using (
    amux.is_team_admin_or_owner(team_id)
    or created_by = amux.current_actor_id_for_team(team_id)
  );

-- ---------------------------------------------------------------------------
-- 6. 授权
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on amux.team_mcp_servers to authenticated;
grant select, insert, update, delete on amux.team_mcp_installs to authenticated;
grant select, insert, update, delete on amux.team_env_secrets to authenticated;
