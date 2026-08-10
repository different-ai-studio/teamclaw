# Expo ↔ iOS parity audit

Status: **first pass, 2026-08-10.** Evidence-backed where a file:line is cited;
anything marked *unverified* still needs a dedicated pass.

## Why this document exists

The first parity pass on `apps/expo` compared three things: **screens, Cloud API
calls, and MQTT commands.** It found and closed eight real gaps (idea activity
feed, team resources, default agents, Settings sections, ACP questions, turn
history, stats sheets, the add-your-own-agent notice).

That standard was wrong. It covered *what the user can see and press*, not *how
the client behaves* — which is most of what "1:1 复刻逻辑" actually means. The
storage layer, the sync strategy, lifecycle handling, offline behaviour, retry
semantics and the visual system were never diffed.

This document establishes the corrected standard: **six axes**, each with its own
checklist, and records the first pass over them.

## The six axes

| # | Axis | Question it answers |
|---|------|--------------------|
| 1 | Persistence | What survives a cold start / crash? |
| 2 | Sync & refresh | How does data get from server to screen, and how incrementally? |
| 3 | Lifecycle | What happens on background / foreground / cold launch / reconnect? |
| 4 | Offline | What can the user see and do with no network? |
| 5 | Error & retry | What happens when a call fails, and what does the user see? |
| 6 | UI / visual | Do the two apps look like the same product? |

Axis 6 carries one standing exemption: **iOS Liquid Glass / 毛玻璃 cannot be
reproduced** (`glassEffect`, `.ultraThinMaterial`). Everything else about those
surfaces — geometry, radius, tint, hairline, spacing, typography — still has to
match. "We can't blur" is not a licence to restyle.

---

## Axis 1 — Persistence

### What each side has

| | iOS | Expo |
|---|---|---|
| Store | SwiftData, versioned schema + migration plan | SQLite (2 tables) + AsyncStorage JSON blobs |
| Sessions | `Session` model — queryable, sortable, filterable | AsyncStorage blob per team, ≤200 rows, whole-blob rewrite |
| Messages | `SessionMessage` model | AsyncStorage blob per session, last 200 |
| Agent runtime events | `AgentEvent` model | **not persisted** |
| Ideas | `SessionIdea` | none |
| Actors | `CachedActor` | none |
| Workspaces | `Workspace` | none |
| Shortcuts | `CachedShortcut` | none |
| Attachments | `AgentAttachment`, `AttachmentUpload` | none |
| Outbox | `OutboxMessage` | SQLite `outbox` — real parity |
| Connected agents | (in-memory store) | SQLite `connected_agents` — Expo is ahead here |

Evidence: `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/AMUXSchema.swift`
lists ten `@Model` types under `Schema.Version(1, 16, 0)` with an explicit
migration plan (the comment notes this is to stop SwiftData falling back to
*destructive* migration). `apps/expo/src/lib/db/migrations.ts` defines two
tables. `apps/expo/src/features/sessions/session-cache.ts` and
`session-detail-cache.ts` are AsyncStorage, clamped to 200 entries each.

### P0 — streamed agent events are never written to disk

`apps/expo/src/features/sessions/session-detail-controller.ts`:

```ts
if (decoded.acpEvent) {
  applyAcpEvent(decoded.acpEvent, decoded.envelope);
  return;                                              // ← returns here
}
…
void deps.cache?.saveMessages(deps.sessionId, next.messages);   // ← only committed messages
```

The ACP branch publishes to React state and returns. The single
`cache.saveMessages` call sits on the committed-protobuf-message path below it.
So **agent output, thinking and tool calls exist only in memory.**

iOS does the opposite deliberately: `TimelineSwiftDataSync.sync` is called from
the streaming path (`SessionDetailViewModel.swift:2441`, `:2659`) and its
doc-comment says the projection exists for "crash-recovery persistence".

Consequence on Expo today: kill the app mid-turn and that turn's trace is gone.
It is partly recoverable now that `AcpRequestTurnHistory` is wired up, but only
if the agent is still online — which is exactly when you least want to depend on
it.

### P1 — no queryable store

The AsyncStorage design cannot express the queries iOS gets free from SwiftData:
sessions sorted by `lastMessageAt`, sessions filtered by `ideaId`, messages by
sender, actors by kind. Expo re-fetches or filters in JS over a whole-blob read.
It also rewrites the entire 200-row blob on every message.

---

## Axis 2 — Sync & refresh *(partially verified)*

Verified: Expo's session list paginates with a cursor and a `MAX_PAGES` bound
(`apps/expo/src/features/sessions/cloud-api.ts:113-128`), which is sound.

Not yet verified — needs a pass:

- Message-history pagination and back-scroll (iOS `requestTurnHistory` +
  `seedFromSupabaseMessages`).
- Server-side unread overlay. iOS layers `fetchUnreadFlags` on top of the synced
  rows (`RootTabView.swift:309`); whether Expo has an equivalent is unchecked.
- Incremental vs full refetch on focus. Expo calls `controller.refresh()` on
  every `useFocusEffect` for ideas/actors — full list refetch each time.
- Retained-topic replay semantics on MQTT reconnect.

---

## Axis 3 — Lifecycle *(partially verified)*

iOS flushes and restores streaming state across backgrounding:

```swift
viewModel.flushStreamingForBackground()   // SessionDetailView.swift:498
viewModel.discardBackgroundSnapshot()     // :500
```

Expo uses `AppState` in exactly one place — `app/_layout.tsx:300`, for presence
heartbeat. There is **no background flush or restore of streaming state**, which
compounds the Axis 1 P0: backgrounding during a turn has no snapshot path either.

Unverified: push-notification cold-start routing, deep-link replay, reconnect
backoff.

---

## Axis 4 — Offline *(not audited)*

Largely determined by Axis 1. With no cache for ideas, actors, workspaces or
shortcuts, those screens are empty offline where iOS shows last-known state.
Needs an explicit pass once persistence lands.

---

## Axis 5 — Error & retry *(not audited)*

The outbox has genuine parity (SQLite-backed, backoff, retry). Everything else —
what a failed load shows, whether it retries, whether it is silent — is
unchecked. Several handlers I read swallow errors into `catch {}`.

---

## Axis 6 — UI / visual

### P1 — Expo has no dark mode at all

`AMUXTheme.swift` defines every token as **adaptive**: each resolves to its Hai
value in light and its Sumi 墨 value in dark, inside a `UIColor` dynamic
provider, so all `Color.amux.*` call sites invert with no per-view branching.
`DESIGN.md:26` records Sumi as *implemented*.

`apps/expo/src/ui/theme.ts` hardcodes the light Hai hex values only. There is no
`useColorScheme` anywhere in the app, and `app.json` sets no
`userInterfaceStyle` (so Expo defaults it to light). `src/ui/status-bar.ts` pins
`style: "dark"`.

This is the single largest visual divergence: one app has a ratified dark theme,
the other is permanently light.

### What already matches

- Palette hex values are identical to the Hai light set.
- `dotSize` tokens match `DESIGN.md` exactly: status 8px, unread 7px, avatar
  22px, ring 1.5px.
- `StatusDot` breathes on spec — 1.4s cycle, opacity 1 → 0.45
  (`src/ui/atoms/StatusDot.tsx`).
- `AvatarStack` exists and is used by `SessionRow` (the participant cluster).

### Gaps found

| Gap | Detail |
|---|---|
| Reduce-motion ignored | iOS `BreathingOpacity` reads `accessibilityReduceMotion`; Expo's `StatusDot` loops unconditionally |
| Easing | iOS breathes `easeInOut`; Expo uses linear `Animated.timing` |
| No animation tokens | iOS `AMUXAnimation` defines micro / fast / standard / drawer; Expo has no shared set, each component rolls its own |
| `DaemonStatusBanner` | no Expo equivalent |
| `RecordingWaveform` | no Expo equivalent — voice recording has no visual feedback |
| `ApertureSplashView` | no Expo equivalent |
| Glass chrome | `HaiSheet` / `LiquidGlassBar` / `GlassButtonStyle` — blur is exempt, but their radii, tints, hairlines and layout still need porting |

### Present but visually unverified

**See `expo-ios-ui-inventory.md`** — it places all 70 iOS surfaces and marks each
verified / unverified / gap / missing.

This section used to be a sample: seven surfaces named, the rest implicit. Two
surfaces were then found broken by using the app rather than by reading the
list — the composer (a hardcoded fake agent name, two dead buttons) and the
session member sheet. Neither was named here. A sample makes "absent from the
list" meaningless, so it was replaced with an exhaustive one.

Three things the exhaustive sweep turned up that this section had missed
entirely:

- The six `AMUXApp/` views (auth, onboarding, team picker — 1487 LOC). This
  audit swept `Packages/` only, so the whole auth flow was outside its field of
  view.
- `ToolCallView` (343 LOC) has **no** Expo counterpart. Tool calls are folded
  into counted text lines, so a failed tool looks like a successful one.
- `StreamingDetailView` (292 LOC) is a pushed screen pinned to a turn id, with a
  live event feed and a todo dock; Expo answers it with a grouped summary modal.

---

## Severity summary

| Severity | Item |
|---|---|
| **P0** | Streamed agent events never persisted (Axis 1) |
| **P1** | No dark mode (Axis 6) |
| **P1** | No persistence for ideas / actors / workspaces / shortcuts (Axis 1) |
| **P1** | Sessions/messages on AsyncStorage blobs instead of a queryable store (Axis 1) |
| **P2** | No background flush/restore of streaming state (Axis 3) |
| **P2** | Reduce-motion, easing, animation tokens (Axis 6) |
| **P2** | `DaemonStatusBanner`, `RecordingWaveform`, splash (Axis 6) |
| **P2** | Tool calls render as text lines, not status cards (Axis 6) |
| **Unknown** | 44 unverified UI surfaces; Axes 2, 4, 5 in full |

## Suggested sequence

1. **P0 first** — persist the streaming path. Small, self-contained, fixes real
   data loss.
2. **Persistence layer** — SQLite tables + sync for sessions, messages, events,
   ideas, actors, workspaces, shortcuts, with append-only migrations mirroring
   the existing `migrations.ts` convention. Unblocks Axis 4.
3. **Dark mode** — tokens to adaptive, thread a color-scheme hook, audit every
   hardcoded hex. Wide but mechanical.
4. **Screen-by-screen visual pass** — the long tail. Tracked one row per surface
   in `expo-ios-ui-inventory.md`; work the ◻ rows down.
5. **Axes 2 / 3 / 5 dedicated passes.**

## What this audit did not cover

Accessibility beyond reduce-motion, i18n, performance, Android-specific
divergence, and the per-screen visual diff. None of these were sampled; absence
of a finding here means "not looked at", not "fine".
