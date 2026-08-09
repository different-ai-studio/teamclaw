---
status: accepted
---

# AcpCommand 并入 rpc/req，取消 runtime 级命令通道

`AcpCommand` 的 9 个变体原先发布在 `amux/{team}/{actor}/runtime/{rid}/commands`
（daemon 通配订阅 `runtime/+/commands`）。随 `runtime_id` 概念取消，我们决定
**把它们并入已有的 `amux/{team}/{actor}/rpc/req`**，成为 `RpcRequest` 的新 method，
并删除 runtime 级命令通道。

## 为什么

三条理由，按重要性：

1. **`rpc/req` 自带 request/response 关联**（`request_id` + `RpcResponse`），
   而 commands 通道**没有回执路径**。`docs/debug/interrupt-agent-stale-runtime.md`
   记录的「点停止后 agent 仍在输出、无 toast」不是实现疏忽 —— `rpc.rs` 的 Cancel
   分支只能 `warn!`，因为那条 topic 上没有地方发 NACK。并入之后，该故障模式
   在结构上不再可能。
2. **`rpc/req` 本来就按 actor 寻址**，不含 runtime_id。取消 runtime 后的寻址问题
   在这个选项下不是"被解决"，而是从未存在。
3. **消除重复的生命周期命令集**：`AcpStartAgent`/`AcpStopAgent` 与
   `RuntimeStartRequest`/`RuntimeStopRequest` 是同一件事的两种写法。

## 考虑过的替代

- **`{actor}/session/{sid}/commands`** —— 每 session 一条 topic。寻址正确，但净新增
  一条通道、一套通配订阅、一套 ACL，且不解决回执问题。
- **`{actor}/commands`（session_id 入载荷）** —— 中间站，改动小，同样不解决回执问题。

两者都只搬家，不消 bug。

## 对并发无影响（已验证）

初稿曾担心「一个 actor 的所有命令挤进单一 topic 会串行化跨 session 的投递」。
查证后该顾虑不成立：两条通道**本来就走同一个串行分派器**。

```rust
// apps/daemon/src/daemon/server/rpc.rs:150-160 —— 同一 match、同一 &mut self、依次 await
IncomingMessage::RuntimeCommand { .. } => { self.handle_agent_command(…).await; }
IncomingMessage::TeamcluRpc     { .. } => { self.handle_rpc_request(…).await; }
```

`runtime/{rid}/commands` 从未与 `rpc/req` 并发过，合并是并发中性的。

## 后果
- `AcpRequestTurnHistory` 的 scoping 注释（`proto/amux.proto:214-217`，
  "scoped to one runtime so callers don't conflate runtimes"）需改写为
  scoped to one session。
- 改动面覆盖 `proto/amux.proto`、`proto/teamclu.proto`、daemon subscriber 分派、
  以及三端全部发送方。
