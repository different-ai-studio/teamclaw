-- CS-8 P3: 匿名 / 快捷试用下线后的 SQL 清理。
--
-- 客户端入口（三端）、/v1/auth/signin-anonymous、FC 的 deviceId 入参都已移除，
-- GoTrue 的 ENABLE_ANONYMOUS_USERS 也已关闭，这里收掉最后的服务端残留。
--
-- 刻意**不删**的东西：
--   - join_public_team / claim_team_invite 里的匿名守卫。零成本，留作纵深防御，
--     万一哪天 GoTrue 那个开关被谁打开，守卫还在。
--   - 存量匿名 auth.users 及其团队。删账号会连带 cascade 掉他们的会话数据，
--     那是产品决定不是迁移决定；本迁移只删机制，不删数据。
--
-- 不可逆：guest_device_teams 是「设备 → 访客团队」的记忆表，删掉之后无法重建
-- 那层复用关系。它只对匿名账号有意义，而匿名账号已经不会再产生。
drop function if exists amux.claim_guest_device_team(text, uuid, text);
drop table if exists amux.guest_device_teams;

-- 匿名浏览公开团队的入口（GuestTeamDiscovery）已删除，anon 不再需要这个函数。
revoke execute on function amux.list_discoverable_teams() from anon;
