-- Team skills registry — 团队 skill 市场的服务端表。
--
-- 背景见 docs/architecture/team-skills-registry.md。要解决两件事：
--
--   1. 职责不清晰。此前 skill 的全部元数据只有 SKILL.md frontmatter 里的
--      name + description 两个字段，「什么时候用 / 什么时候别用 / 归谁 / 依赖
--      什么」全挤在一个自由文本里，没法比较、去重、分类。这里把它们拆成独立
--      的列，并在发布时强制填写。
--   2. 每人全量。teamclu-team/skills/ 整个目录同步给所有成员，团队里任何人
--      加的 skill 都进每个人的 agent 上下文。registry 让成员按需安装。
--
-- 三张表：
--   team_skills           每个 skill 一行，承载「当前」元数据
--   team_skill_versions   追加式版本历史，元数据快照冗余（见下）
--   team_skill_installs   谁装了什么；actor_id 同时覆盖成员和团队共享 agent
--
-- 包体本身不进这里：zip 走 amux.amuxc_blobs（内容寻址 + OSS），本表只存
-- content_hash 指过去。
--
-- Idempotent：self-host 的 apply-migrations 循环会重复执行。

-- ---------------------------------------------------------------------------
-- 1. team_skills
-- ---------------------------------------------------------------------------
create table if not exists amux.team_skills (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  slug text not null,
  -- 负责人。默认是发布者，可以转交（PATCH ownerActorId）。
  --
  -- on delete set null，不是 restrict：restrict 看着更"严格"，实际是把删团队
  -- 这件事整个卡死——teams 级联删 actors 和 team_skills 两条路径没有保证顺序，
  -- actors 先被删就撞上约束。而且成员离职本来就该是允许的操作。
  -- NULL 在这里有明确语义：**这个 skill 现在没人负责**，UI 据此提示认领，
  -- 这恰好是本设计要解决的"职责不清晰"，藏起来才是错的。
  owner_actor_id uuid references amux.actors(id) on delete set null,
  summary text not null,
  category text not null,
  when_to_use text not null,
  -- 「什么时候别用」。两个职责重叠的 skill，只有边界写出来才能并排比较，
  -- 所以它和 when_to_use 一样是 not null。
  when_not_to_use text not null,
  requires jsonb,
  status text not null default 'published',
  -- deprecated 时指向替代者的 slug。不加外键：替代者可能还没发布，而且
  -- slug 是团队内唯一而非全局唯一，复合外键在这里不值得。
  superseded_by text,
  latest_version integer not null default 0,
  -- 同上：归属信息不该有能力阻止删除。作者离职了，历史版本仍然要读得到。
  created_by uuid references amux.actors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_skills_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  constraint team_skills_status_valid
    check (status in ('draft', 'published', 'deprecated')),
  constraint team_skills_category_valid
    check (category in (
      'general', 'coding', 'devops', 'data',
      'research', 'writing', 'communication', 'integration'
    )),
  -- summary 限长是发布门的一部分：逼发布者用一句话说清楚，而不是把
  -- 整段说明贴进来（那正是现在 description 字段的病）。
  constraint team_skills_summary_len
    check (char_length(summary) between 1 and 200)
);

create unique index if not exists uniq_team_skills_team_slug
  on amux.team_skills (team_id, slug);

create index if not exists idx_team_skills_team_status
  on amux.team_skills (team_id, status);

create index if not exists idx_team_skills_owner
  on amux.team_skills (owner_actor_id);

-- ---------------------------------------------------------------------------
-- 2. team_skill_versions
-- ---------------------------------------------------------------------------
-- 元数据在 team_skills 上是「当前状态」，在版本行上是「那一版的事实」。
-- 没有快照，改一次描述就把所有历史版本的说明一起改写了——装着 v1 的人会
-- 读到 v3 的说明。所以这里冗余存一份。
create table if not exists amux.team_skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references amux.team_skills(id) on delete cascade,
  version integer not null,
  -- zip 的 sha256，对应 amux.amuxc_blobs.content_hash（同一 team 下）。
  content_hash text not null,
  size bigint not null default 0,
  changelog text not null,
  summary text not null,
  when_to_use text not null,
  when_not_to_use text not null,
  requires jsonb,
  created_by uuid references amux.actors(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint team_skill_versions_version_positive check (version >= 1)
);

create unique index if not exists uniq_team_skill_version
  on amux.team_skill_versions (skill_id, version);

create index if not exists idx_team_skill_versions_skill
  on amux.team_skill_versions (skill_id, version desc);

-- ---------------------------------------------------------------------------
-- 3. team_skill_installs
-- ---------------------------------------------------------------------------
-- actor_id 泛化两种安装主体，这是本设计不需要额外「指派表」的原因：
--
--   actor_type = 'member'                成员自己装（自助按需，治噪音）
--   agents.visibility = 'team' 的 agent   管理员直接装（团队资产，无个人意志）
--
-- 对成员 actor，这张表不是权威——权威是本地 lockfile，允许漂移，它只驱动
-- 「已装 / 有更新」标记。对团队 agent 反过来：这张表是权威，承载它的 daemon
-- 按这里的清单做全量对账。
create table if not exists amux.team_skill_installs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references amux.teams(id) on delete cascade,
  actor_id uuid not null references amux.actors(id) on delete cascade,
  skill_id uuid not null references amux.team_skills(id) on delete cascade,
  installed_version integer not null,
  scope text not null default 'global',
  workspace_id uuid,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_skill_installs_scope_valid
    check (scope in ('global', 'workspace')),
  -- workspace_id 与 scope 必须一致：global 不带 workspace，workspace 必须带。
  constraint team_skill_installs_scope_workspace_agree
    check ((scope = 'workspace') = (workspace_id is not null))
);

-- coalesce 进唯一键，因为 NULL 在唯一索引里互不相等——不这么写，同一个
-- actor 能把同一个 skill 以 global 作用域装无数次。
create unique index if not exists uniq_team_skill_install
  on amux.team_skill_installs (
    actor_id,
    skill_id,
    scope,
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index if not exists idx_team_skill_installs_actor
  on amux.team_skill_installs (actor_id);

create index if not exists idx_team_skill_installs_skill
  on amux.team_skill_installs (skill_id);

-- ---------------------------------------------------------------------------
-- 4. updated_at 触发器
-- ---------------------------------------------------------------------------
drop trigger if exists team_skills_bump_updated_at on amux.team_skills;
create trigger team_skills_bump_updated_at
  before update on amux.team_skills
  for each row execute function amux.bump_updated_at();

drop trigger if exists team_skill_installs_bump_updated_at on amux.team_skill_installs;
create trigger team_skill_installs_bump_updated_at
  before update on amux.team_skill_installs
  for each row execute function amux.bump_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
-- 本版不做成员间的可见性隔离：团队内所有成员都能看到全部 skill（市场就是
-- 要全量可见，噪音由「装了才加载」解决，不是由隐藏解决）。写入才收紧。
alter table amux.team_skills enable row level security;
alter table amux.team_skill_versions enable row level security;
alter table amux.team_skill_installs enable row level security;

drop policy if exists team_skills_select_if_member on amux.team_skills;
create policy team_skills_select_if_member on amux.team_skills
  for select using (amux.is_team_member(team_id));

-- 任何团队成员都能发布（发布门是必填字段，不是审核）。
drop policy if exists team_skills_insert_if_member on amux.team_skills;
create policy team_skills_insert_if_member on amux.team_skills
  for insert with check (amux.is_team_member(team_id));

-- 改元数据 / 转交 owner / 标记弃用：owner 本人或团队管理员。
drop policy if exists team_skills_update_if_owner_or_admin on amux.team_skills;
create policy team_skills_update_if_owner_or_admin on amux.team_skills
  for update using (
    amux.is_team_admin_or_owner(team_id)
    or owner_actor_id = amux.current_actor_id_for_team(team_id)
  );

drop policy if exists team_skills_delete_if_owner_or_admin on amux.team_skills;
create policy team_skills_delete_if_owner_or_admin on amux.team_skills
  for delete using (
    amux.is_team_admin_or_owner(team_id)
    or owner_actor_id = amux.current_actor_id_for_team(team_id)
  );

drop policy if exists team_skill_versions_select_if_member on amux.team_skill_versions;
create policy team_skill_versions_select_if_member on amux.team_skill_versions
  for select using (
    exists (
      select 1 from amux.team_skills s
      where s.id = skill_id and amux.is_team_member(s.team_id)
    )
  );

drop policy if exists team_skill_versions_insert_if_owner_or_admin on amux.team_skill_versions;
create policy team_skill_versions_insert_if_owner_or_admin on amux.team_skill_versions
  for insert with check (
    exists (
      select 1 from amux.team_skills s
      where s.id = skill_id
        and (
          amux.is_team_admin_or_owner(s.team_id)
          or s.owner_actor_id = amux.current_actor_id_for_team(s.team_id)
        )
    )
  );

-- 安装记录：团队成员可见（管理员要能看到某个 skill 的铺开情况）。
drop policy if exists team_skill_installs_select_if_member on amux.team_skill_installs;
create policy team_skill_installs_select_if_member on amux.team_skill_installs
  for select using (amux.is_team_member(team_id));

-- 写入的三条闸门，和 FC 路由层的判断一致：
--   1. 装给自己 —— 放行
--   2. 装给 visibility='team' 的 agent actor —— 要求团队管理员
--   3. 装给别人的 member actor —— 拒绝（管理员不能替成员做安装决定）
drop policy if exists team_skill_installs_write_self_or_team_agent on amux.team_skill_installs;
create policy team_skill_installs_write_self_or_team_agent on amux.team_skill_installs
  for all using (
    amux.is_team_member(team_id)
    and (
      actor_id = amux.current_actor_id_for_team(team_id)
      or (
        amux.is_team_admin_or_owner(team_id)
        and exists (
          select 1 from amux.agents ag
          where ag.id = actor_id and ag.visibility = 'team'
        )
      )
    )
  ) with check (
    amux.is_team_member(team_id)
    and (
      actor_id = amux.current_actor_id_for_team(team_id)
      or (
        amux.is_team_admin_or_owner(team_id)
        and exists (
          select 1 from amux.agents ag
          where ag.id = actor_id and ag.visibility = 'team'
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 6. 授权
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on amux.team_skills to authenticated;
grant select, insert on amux.team_skill_versions to authenticated;
grant select, insert, update, delete on amux.team_skill_installs to authenticated;
