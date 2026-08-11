# Expo ↔ iOS parity audit

Status: **all six axes audited, 2026-08-10.** Evidence-backed where a file:line
is cited; anything marked *unverified* still needs a dedicated pass. Dark mode
is open by explicit decision, not by oversight.

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

Axis 6 carried a standing exemption: *iOS Liquid Glass / 毛玻璃 cannot be
reproduced.* **That was too broad — it is only true on Android.** Corrected:

- **iOS.** Expo can render real Liquid Glass. `@expo/ui/swift-ui` exposes
  SwiftUI's `glassEffect` modifier and `GlassEffectContainer` (SDK 54+), and
  `expo-router/unstable-native-tabs` renders an actual `UITabBar`, which the
  system glazes for free on iOS 26 — including `minimizeBehavior`, the
  minimize-on-scroll behaviour. Neither was available when the exemption was
  written.
- **Android.** Still an approximation. `@expo/ui`'s Jetpack Compose half is
  announced as planned, not shipped, and Android has no Liquid Glass to expose
  in the first place. `GlassSurface` (`dimezisBlurView` + tint) stays the
  ceiling here.

So the exemption survives only as: **Liquid Glass is unreachable on Android.**
Everything else about those surfaces — geometry, radius, tint, hairline,
spacing, typography — still has to match on both. "We can't blur" was never a
licence to restyle, and on iOS it is no longer even true.

---

## Axis 1 — Persistence *(closed)*

| | iOS | Expo |
|---|---|---|
| Store | SwiftData, versioned schema + migration plan | SQLite, append-only migrations |
| Sessions | `Session` model | `cached_sessions` |
| Messages | `SessionMessage` model | `cached_messages` |
| Agent runtime events | `AgentEvent` model | `cached_messages` (same rows) |
| Ideas | `SessionIdea` | `cached_ideas` |
| Actors | `CachedActor` | `cached_actors` |
| Workspaces | `Workspace` | `cached_workspaces` |
| Shortcuts | `CachedShortcut` | `cached_shortcuts` |
| Partial streaming output | snapshot rows in `AgentEvent` | `streaming_snapshots` |
| Attachments | `AgentAttachment`, `AttachmentUpload` | none — still open |
| Outbox | `OutboxMessage` | SQLite `outbox` |
| Connected agents | in-memory | SQLite `connected_agents` — Expo is ahead |

`AMUXSchema.swift` lists ten `@Model` types under `Schema.Version(1, 16, 0)`
with an explicit migration plan (to stop SwiftData falling back to *destructive*
migration). `apps/expo/src/lib/db/migrations.ts` is now at version 5.

### Fixed — P0: streamed agent events were never written to disk

The ACP branch of the live-message handler published to React state and
returned; the one `cache.saveMessages` call sat on the committed-message path
below it. Agent output, thinking and tool calls existed only in memory, so
killing the app mid-turn lost that turn's trace.

iOS does the opposite deliberately: `TimelineSwiftDataSync.sync` is called from
the streaming path (`SessionDetailViewModel.swift:2441`, `:2659`), and its
doc-comment says the projection exists for "crash-recovery persistence".

Fixed with a coalesced write-behind (1s) so a streaming turn does not rewrite
the timeline on every delta.

### Fixed — P1: no queryable store

AsyncStorage blobs could not express what SwiftData gives iOS free — sessions
by `lastMessageAt`, messages by sender, actors by kind — and rewrote a whole
200-row blob per change. Both caches are SQLite rows now, with no row ceiling,
scoped by team so a team switch reads its own rows instead of evicting the
other's.

### Still open

Attachment upload state is not persisted. iOS has `AttachmentUpload`; an Expo
upload interrupted by a kill is simply lost. Low impact — uploads are short and
the file is still on the device — but it is the one row of the table with no
Expo counterpart.

---

## Axis 2 — Sync & refresh *(audited)*

### Fixed — no catch-up after an MQTT reconnect

The detail controller's `onConnectionState` handler updated
`state.connectionState` and did nothing else. The session's `live` topic is not
retained (only presence and runtime state are), so messages published while the
socket was down are never redelivered on resubscribe: the timeline stayed short
by however many messages arrived during a lift, a tunnel, or a Wi-Fi handover,
until the screen was reopened.

iOS runs a two-source recovery on every reconnect — resubscribe, then an
incremental fetch of what was missed (`SessionDetailViewModel:1529`).

Expo now refetches with `preserveExisting: true` on a genuine reconnect, and
not on the first connect, whose fetch is already in flight. Covered by
`session-detail-controller.test.ts` → "reconnect recovery".

### Fixed — message history is paginated, and Expo now walks back through it

This section previously recorded the unpaginated `GET /v1/sessions/:id/messages`
as a shared server limitation and therefore out of parity scope. **#842 landed
on main and closed it**: a page is the newest 200 (max 500), oldest-first, with
a cursor walking backward. The measurements in that commit are worth keeping —
6k messages took 6.1s / 3.7MB, 40k exceeded the statement timeout.

That change also gave Expo `listMessagesPage` and left it with no caller:
`listMessages` returned the first page and nothing walked the cursor, so a long
session showed its newest ~200 messages with **no way to reach older ones**,
where it had previously loaded all of them. Slow-but-complete became
fast-but-truncated.

Now wired: `loadOlderMessages` on the detail controller, triggered by
`onStartReached` once the feed is no longer pinned to the newest message, with
`maintainVisibleContentPosition` so the arriving page does not shove the
transcript out from under the reader.

Two things had to change with it, both of which were only latent while every
load fetched the whole history:

- **A load no longer replaces the timeline.** The fetch covers the newest page
  and can only speak for that window, so `mergeNewestPage` folds it over what is
  already held: rows inside the window follow the server (that is how a delete
  still propagates), rows older than it are kept. Without this a reconnect
  refresh threw away everything the user had scrolled back to.
- **The disk hydrate is awaited before that merge.** It used to race the
  network, and the `cache.save` that follows replaces the session's rows with
  whatever the timeline holds — so whenever the network won the race, the older
  pages on disk were quietly trimmed to one page.

**Correction to an earlier claim in this section:** iOS was recorded as walking
the cursor at `CloudAPIRepositories.swift:563`. That line is `listIdeas`.
`listPage` (`:251`) has exactly one caller — `listForSession` (`:254`), which
asks for the newest page — so iOS reaches no further back than Expo did. This
was a shared gap being read as an Expo-only one, and Expo is now the app that
closes it.

### Verified as matching

- Session list pagination: cursor + `MAX_PAGES` bound (`cloud-api.ts:113-128`).
- Unread state. iOS's `fetchUnreadFlags` is just `GET /v1/sessions?limit=100`
  reduced to `[id: hasUnread]` (`CloudAPIRepositories.swift:49`); it exists
  because SwiftData can hold a session the server list no longer covers. Expo
  reads `hasUnread` off the same list rows it already pages through, so the
  flag has the same authority without the extra call.
- Focus refresh: Expo refetches the full list on every `useFocusEffect` for
  sessions / ideas / actors. iOS does the same; neither is incremental.

---

## Axis 3 — Lifecycle *(audited)*

### Fixed — streaming state across a suspend

Was: `AppState` used in exactly one place, for the presence heartbeat, with no
background flush or restore of streaming state.

Now ported from iOS `flushStreamingForBackground` / `discardBackgroundSnapshot`
— see the commit "keep partial agent output across a suspend". Snapshot rows
live in their own table with an inverted lifetime (written on suspend, deleted
on resume), so the timeline cache's scope-replace can never take them along.

Still unverified: push-notification cold-start routing, deep-link replay,
reconnect backoff timing.

---

## Axis 4 — Offline *(audited)*

Was determined by Axis 1, and Axis 1 is now closed: all six lists cache to
SQLite and paint before the network answers.

What changed beyond caching — two screens used to call `setRows([])` in their
error handler, so a failed refresh **erased good cached data**. Workspaces and
shortcuts now keep what the cache painted and show the error line beside it.
The ideas and actors controllers already had the right shape
(`status: state.ideas.length > 0 ? "ready" : "error"`).

Remaining: no offline indicator distinct from the connection banner, and
mutations other than sending a message (creating an idea, adding a member) have
no offline queue — only the message outbox does. iOS is the same on both
counts, so neither is a parity gap.

---

## Axis 5 — Error & retry *(audited)*

The outbox has genuine parity: SQLite-backed, exponential backoff, retry,
per-row `last_error`.

A sweep for swallowed errors found 36 `catch` blocks that discard the error.
31 carry a comment saying why — best-effort cache writes, mostly, where a
failure must not surface on a screen that has live data. The 5 that did not
have been annotated rather than changed, because all five are correct:

| Site | Why it is right |
|---|---|
| `outbox-sender.ts:60` | Per-row failures are recorded on the row and retried; the guard only stops one bad pass from killing the scheduling loop |
| `AuthScreen.tsx` ×3 | The onboarding store calls `finishWithError` and rethrows — the message is already bound to `errorMessage` |
| `CreateTeamScreen.tsx:48` | Same; rendered as `visibleError` |

The defect was that a reader could not tell a deliberate swallow from a
forgotten one, which is what made the sweep necessary in the first place.

Not covered: whether every failed load offers a retry affordance, and
error-message wording consistency (several are Chinese, most are English —
see the mixed-language note in Axis 6).

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

| Gap | Status |
|---|---|
| Reduce-motion ignored | **fixed** — `StatusDot` reads `AccessibilityInfo` and stops looping |
| Easing | **fixed** — `easeInOut`, 1.4s cycle |
| No animation tokens | **partly** — `motion` in `theme.ts` mirrors `AMUXAnimation`, but only `ToolCallLine` reads it. The other components still hardcode their durations, so the token set is available rather than adopted |
| `DaemonStatusBanner` | **fixed** |
| `RecordingWaveform` | **fixed** — voice recording has visual feedback |
| `ApertureSplashView` | **fixed** |
| Glass chrome | **partly** — `LiquidGlassBar` ported as `GlassHeader`/`GlassSurface` with the documented pre-26 fallback recipe. `HaiSheet` still has no counterpart (one screen uses it on iOS) |

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
- `ToolCallView` (343 LOC) had **no** Expo counterpart. Tool calls were folded
  into counted text lines, so a failed tool looked like a successful one.
  **Fixed** — see `ToolCallLine` / `tool-display.ts`.
- `StreamingDetailView` (292 LOC) is a pushed screen pinned to a turn id, with a
  live event feed and a todo dock; Expo answered it with a grouped summary
  modal. **Fixed** — see `TurnDetailScreen`.

---

## Severity summary

| Severity | Item | Status |
|---|---|---|
| **P0** | Streamed agent events never persisted (Axis 1) | fixed |
| **P0** | Session member sheet called three deleted endpoints — always empty (Axis 2) | fixed |
| **P1** | No dark mode (Axis 6) | **open — excluded by the user** |
| **P1** | No persistence for ideas / actors / workspaces / shortcuts (Axis 1) | fixed |
| **P1** | Sessions/messages on AsyncStorage blobs (Axis 1) | fixed |
| **P1** | No catch-up fetch after an MQTT reconnect (Axis 2) | fixed |
| **P2** | No background flush/restore of streaming state (Axis 3) | fixed |
| **P2** | Reduce-motion, easing, animation tokens (Axis 6) | fixed |
| **P2** | `DaemonStatusBanner`, `RecordingWaveform`, splash (Axis 6) | fixed |
| **P2** | Tool calls indistinguishable on failure (Axis 6) | fixed |
| **P2** | Turn detail showed counts, not events (Axis 6) | fixed |
| **P3** | Attachment upload state not persisted (Axis 1) | open |
| **P3** | `HaiSheet` chrome has no counterpart (Axis 6) | open |
| **P1** | No back-scroll — Expo showed only the newest page since #842 (Axis 2) | fixed |
| **P2** | Tab bar / modal safe area — found on a device, not by reading (Axis 6) | fixed |
| **Unknown** | Everything marked ✅ was source-diffed, **not run** | open |

## What is left

1. **Dark mode** — tokens to adaptive, thread a color-scheme hook, audit every
   hardcoded hex. Wide but mechanical. Excluded by the user for now; it is the
   single largest remaining visual divergence.
2. **The ⚠ rows** in `expo-ios-ui-inventory.md`. Its ◻ column reached zero, so
   what is left there is not unverified surfaces but recorded decisions — phone
   OTP, the untestable login, per-agent config on `NewSessionSheet`.
3. **Attachment upload persistence**, and `HaiSheet` chrome.
4. **Back-scroll on iOS.** Closing Expo's gap showed that `listPage` has no
   caller there either, so iOS reaches only the newest page of a long session.
   Not an Expo parity item any more — an iOS one.

## What this audit did not cover

Accessibility beyond reduce-motion, i18n, performance, Android-specific
divergence, and the per-screen visual diff. None of these were sampled; absence
of a finding here means "not looked at", not "fine".
