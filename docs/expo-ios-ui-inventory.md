# Expo ↔ iOS UI surface inventory

Companion to `expo-ios-parity-audit.md`, which covers the six parity axes. This
file covers one thing only: **every iOS UI surface, what it maps to in Expo, and
whether anyone has actually compared the two.**

## Why it exists

The audit's Axis 6 named a handful of surfaces as "present but visually
unverified" and left the rest implicit. Two surfaces were then found broken by
using the app rather than by reading the list — the session composer (a
hardcoded fake agent name and two dead buttons) and the session member sheet.
Neither was on it.

The problem was that the list was a sample, so "not on the list" carried no
information. This one is exhaustive: **70 iOS surfaces**, every one placed. A
surface missing from here is a bug in this document.

## Status vocabulary

| | Meaning |
|---|---|
| ✅ | Diffed against the Swift source; differences were deliberate and are noted |
| ◻ | An Expo counterpart exists. **Nobody has compared them.** Says nothing about quality |
| ⚠ | Compared, and a concrete difference is recorded below |
| ✖ | No Expo counterpart |

◻ is the honest default and the majority state. It is not a pass.

## Coverage

Rows carrying two marks (`✅ header ◻ body`) are counted by their first, so the
✅ column is the optimistic reading of a partially-checked surface.

| Status | Count |
|---|---|
| ✅ verified | 53 |
| ⚠ known gap | 2 |
| ◻ unverified | 14 |
| ✖ missing | 1 |
| **Total** | **70** |

Counts move as rows are worked. Last updated after the shared-primitives sweep
(mentions, slash commands, chip bar, banners, todo dock, plans panel,
segmented filter, avatar cluster) and the small-surface batch.

A note on the small ones: several are ✅ because there is nothing to port, not
because something was built. `GlassButtonStyle` and `AppTab` resolve to SwiftUI
primitives with no RN counterpart; `IdeaUIPresentation` is three constants.
Marking them verified means someone looked and concluded that, which is the
point of the column.

---

## AMUXSharedUI — cross-screen primitives

| iOS | LOC | Expo | |
|---|---|---|---|
| `AMUXAnimation` | 57 | `ui/theme.ts` → `motion` | ✅ |
| `AMUXTheme` | 133 | `ui/theme.ts` | ⚠ light-only; no Sumi dark set (excluded by the user) |
| `CommandChip` | 48 | — | ✅ nothing to port: `extractSlashCommand` has no production caller on iOS either, only its own tests. Expo's `slashPrefix` is a different job (autocomplete trigger, not message-render splitting) |
| `ConnectionBanner` | 60 | `sessions/components/ConnectionBannerOverlay.tsx` | ✅ states + colour ⚠ full-width strip, not iOS's floating capsule (deliberate — clears the pinned glass header) |
| `MarkdownRenderer` | 141 | inline in `SessionMessageRow.tsx` | ✅ ⚠ no table sanitiser needed — iOS indents table rows to coax swift-markdown-ui; react-native-markdown-display parses GFM tables directly |
| `MentionsPopup` | 119 | `sessions/components/MentionsPopup.tsx` | ✅ |
| `PermissionBanner` | 68 | `sessions/components/PermissionBanner.tsx` | ✅ |
| `SessionPlansPanelView` | 102 | `sessions/components/SessionPlansPanel.tsx` | ✅ ⚠ Expo adds a close control iOS has no need for (its panel is a safeAreaInset) |
| `SlashCommandsPopup` | 118 | `sessions/components/SlashCommandsPopup.tsx` | ✅ |
| `StreamingTextView` | 51 | inline in `SessionMessageRow.tsx` | ✅ blinking cursor present; Expo blinks at 300ms vs iOS 500ms |
| `TodoDockView` | 92 | `sessions/components/TodoDock.tsx` | ✅ |
| `TodoItemStyling` | 21 | `TodoDock.tsx` / `SessionPlansPanel.tsx` glyph maps | ✅ |
| `ToolCallView` | 343 | `components/ToolCallLine.tsx` + `tool-display.ts` | ✅ |
| `ViewModifiers` | 50 | `ui/GlassSurface.tsx` | ✅ this *is* the `liquidGlass` modifier — the pre-26 fallback it documents is exactly what `GlassSurface` implements on iOS, and Android now renders opaque |

## AMUXUI/AgentDetail — the session screen

| iOS | LOC | Expo | |
|---|---|---|---|
| `AddAgentSheet` | 139 | `MemberPickerSheet.tsx` + `runtime-start.ts` | ✅ same workspace fallback chain (stored default → agent-owned → refuse, never another agent's row) ⚠ Expo closes the sheet on failure where iOS keeps it open with the error |
| `AddMemberSheet` | 48 | `MemberPickerSheet.tsx` | ✅ iOS separates humans/agents with two sheets, Expo with one sheet and a candidate filter — same guarantee that agents never arrive half-configured |
| `AgentChipBar` | 169 | `components/AgentChipBar.tsx` | ✅ chip visuals + interrupt confirm ⚠ chips are all agent participants, not a per-turn selection |
| `AgentsSheet` | 197 | `AgentConfigSheet.tsx` + `ModelPickerSheet.tsx` | ✅ model switch ◻ stop-mid-stream confirm |
| `AttachmentDrawerSheet` | 165 | `screens/AttachmentDrawerSheet.tsx` | ✅ Files/Camera/Photos, 5-photo cap matches |
| `CameraImagePicker` | 45 | `app/(app)/attach.tsx` (expo-image-picker) | ✅ |
| `ComposerState` | 30 | `components/composer-state.ts` | ✅ |
| `EventFeedView` | 908 | `SessionMessageRow.tsx` + `session-feed-items.ts` | ✅ bubbles, tool calls ◻ rest |
| `RecordingWaveform` | 55 | `components/RecordingWaveform.tsx` | ✅ |
| `SessionComposer` | 538 | `components/SessionComposerShell.tsx` | ✅ |
| `SessionDetailView` | 993 | `screens/SessionDetailScreen.tsx` | ◻ header/glass only |
| `SessionMemberSheet` | 179 | `screens/SessionMemberSheet.tsx` | ✅ |
| `StreamingDetailView` | 292 | `AgentTurnDetailModal` in `SessionDetailScreen.tsx` | ⚠ see below |

## AMUXUI/Collab — ideas

| iOS | LOC | Expo | |
|---|---|---|---|
| `ArchivedIdeasView` | 48 | `app/(app)/archived-ideas.tsx` | ✅ ⚠ inline Restore button where iOS swipes; more discoverable, same outcome |
| `IdeaDetailView` | 859 | `screens/IdeaDetailScreen.tsx` | ✅ activity feed, attachments, progress composer ◻ rest |
| `IdeaImageAttachments` | 205 | `components/IdeaImageAttachmentStrip.tsx` | ✅ |
| `IdeaListView` | 236 | `screens/IdeasListScreen.tsx` + `IdeaRow.tsx` | ✅ |
| `IdeaSheets` | 446 | `app/(app)/new-idea.tsx` | ◻ |
| `IdeaStatsSheet` | 383 | `screens/IdeaStatsSheet.tsx` | ✅ |
| `IdeaUIPresentation` | 5 | `ideas/idea-types.ts` | ✅ three constants (title, plural, `lightbulb`); the SF Symbol is on the iOS tab bar |

## AMUXUI/Members — actors

| iOS | LOC | Expo | |
|---|---|---|---|
| `ActorResourceListView` | 207 | `screens/ActorResourceListScreen.tsx` | ✅ |
| `MemberInviteSheet` | 194 | `app/(app)/invite.tsx` | ✅ |
| `MemberListContent` | 1598 | `ActorsListScreen.tsx` + `ActorDetailScreen.tsx` | ✅ `ActorRow`, team resources, default agent, info rows ◻ rest |
| `MemberListView` | 376 | `screens/ActorsListScreen.tsx` | ◻ |
| `TeamStatsSheet` | 361 | `screens/TeamStatsSheet.tsx` | ✅ |

`MemberListContent` is the largest single file on either side and holds
`ActorDetailView` (431–1378) plus five row types. Only a slice is verified.

## AMUXUI/Onboarding + Root

| iOS | LOC | Expo | |
|---|---|---|---|
| `ApertureSplashView` | 142 | `screens/ApertureSplashScreen.tsx` | ✅ |
| `ZeroAgentReminderSheet` | 48 | `screens/ZeroAgentReminderSheet.tsx` | ✅ |
| `AppTab` | 10 | `app/(app)/(tabs)/_layout.tsx` | ✅ a 4-case enum; expo-router keys tabs by route name instead |
| `ConnectionBannerOverlay` | 24 | `components/ConnectionBannerOverlay.tsx` | ✅ |
| `IdeasTab` | 209 | `app/(app)/(tabs)/ideas.tsx` | ✅ header ◻ body |
| `MembersTab` | 145 | `app/(app)/(tabs)/actors.tsx` | ✅ header ◻ body |
| `RootTabView` | 318 | `app/(app)/(tabs)/_layout.tsx` | ✅ glass tab bar |
| `SearchTab` | 144 | `app/(app)/(tabs)/search.tsx` | ◻ |
| `SessionsTab` | 363 | `app/(app)/(tabs)/sessions/index.tsx` | ✅ header ◻ body |

## AMUXUI/SessionList

| iOS | LOC | Expo | |
|---|---|---|---|
| `AgentConfigSheet` | 129 | `components/AgentConfigSheet.tsx` | ✅ |
| `DaemonStatusBanner` | 104 | `components/DaemonStatusBanner.tsx` | ✅ |
| `NewSessionSheet` | 599 | `screens/NewSessionScreen.tsx` | ◻ |
| `ParticipantCluster` | 102 | `ui/atoms/AvatarStack.tsx` | ✅ ⚠ Expo adds a "+N" overflow chip; iOS drops the overflow silently by design ("a recognition affordance, not a participant count"). Kept — neither row shows a count elsewhere, so Expo's chip adds information rather than noise |
| `SessionListHelpers` | 546 | `components/SessionRow.tsx` + `session-row-runtime.ts` | ✅ |

## AMUXUI/Settings, Shared, Shortcuts

| iOS | LOC | Expo | |
|---|---|---|---|
| `NotificationsSettingsView` | 98 | `app/(app)/notifications.tsx` | ✅ Expo is a superset — same push toggle and DND window, plus per-category toggles iOS has no equivalent of |
| `SettingsView` | 911 | `screens/SettingsScreen.tsx` | ✅ surface coverage ◻ visual |
| `UpgradeAccountSheet` | 294 | `app/(app)/upgrade-account.tsx` | ◻ |
| `GlassButtonStyle` | 32 | `ui/button.tsx` | ✅ nothing to port: both helpers resolve to `.glassProminent`/`.bordered`, which RN has no equivalent of. Its useful content is the caveat (never inside a toolbar — iOS 26 already glazes those), which does not apply |
| `HaiSheet` | 79 | — | ✖ see below |
| `LiquidGlassBar` | 76 | `ui/GlassHeader.tsx` + `GlassSurface.tsx` | ✅ |
| `SegmentedFilterBar` | 81 | `actors/components/SegmentedFilter.tsx` | ✅ |
| `ShortcutMenuRow` | 225 | inside `shortcuts/ShortcutsDrawer.tsx` | ◻ |
| `ShortcutPresentation` | 24 | `isWebUrl` + `openShortcutTarget` in `ShortcutsDrawer.tsx` | ✅ |
| `ShortcutsDrawer` | 287 | `shortcuts/ShortcutsDrawer.tsx` | ◻ |
| `ShortcutWebView` | 204 | `shortcuts/ShortcutWebScreen.tsx` | ✅ |

## AMUXApp — the app target

These live outside the packages, which is why the original audit missed them
entirely: it swept `Packages/` only. All six are auth/onboarding, none verified.

| iOS | LOC | Expo | |
|---|---|---|---|
| `ChooseAuthView` | 309 | `onboarding/screens/ChooseAuthScreen.tsx` | ◻ |
| `ContentView` | 382 | `app/_layout.tsx` + `app/index.tsx` | ◻ |
| `LoginView` | 464 | `onboarding/screens/AuthScreen.tsx` | ◻ |
| `OnboardingViews` | 94 | `onboarding/screens/CreateTeamScreen.tsx` | ◻ |
| `OrgTeamPickerView` | 70 | `app/(app)/teams.tsx` | ◻ |
| `WelcomeView` | 168 | `onboarding/screens/WelcomeScreen.tsx` | ◻ |

---

## Every ⚠ in detail

### ~~`ToolCallView` (343 LOC) — no structured equivalent~~ — fixed

**Correction:** this entry first described iOS's rendering as a card with a
status chip. It is a *line* — `CompactToolLine`, which is what the feed
actually uses: a 5pt status dot, the tool name in tracked uppercase mono, and a
one-line argument summary, expanding to the raw arguments with a separate
RESULT disclosure. A turn can run a dozen tools, and cards would not fit.

Expo had no tool-call component: `agent_tool_call` and `agent_tool_result`
arrived as two unrelated "TOOL CALL" note cards, and the `success` flag on the
second was never read, so **a failed tool was pixel-identical to a successful
one**.

Now ported as `ToolCallLine` + `tool-display.ts` (`toolSummary`,
`foldToolResults`). Marked ✅ in the table above.

### `StreamingDetailView` (292 LOC) — a pushed screen vs. a modal

iOS pushes a full navigation destination keyed by `TurnRoute`, which pins to a
specific `frozenTurnID` so a tap on an old turn shows that turn rather than the
newest. It hosts `EventFeedView` (live thinking, tool calls, partial output), a
`TodoDockView` bottom inset, and calls `requestTurnHistory` to backfill from the
daemon.

Expo shows `AgentTurnDetailModal`, a grouped summary. Turn-history backfill is
wired; the pinning semantics, the todo dock inset and the live event feed are
not.

### `AMUXTheme` — light only

Excluded by the user. Recorded so the count stays honest.

### `EventFeedView` — bubbles verified, tool rendering not

The bubble geometry was diffed in `a3d357e5`. The tool-call and thinking
branches of the same file were not; they route into the two gaps above.

## The one ✖

`HaiSheet` (79 LOC) has no Expo counterpart. It supplies sheet chrome — grabber,
corner radius, Mist backdrop, `HaiSheetRow`. Expo uses expo-router modal routes
with default platform chrome. In practice iOS only uses it from
`NewSessionSheet`, so the blast radius is one screen, not every sheet.

## Expo-only surfaces

No iOS counterpart, and none needed: `app/(app)/mqtt-debug.tsx`,
`app/dev-session.tsx` (both dev tools), `app/(app)/workspaces.tsx`,
`app/(app)/edit-profile.tsx`, `app/(app)/home.tsx`.

## How to use this

Work down the ◻ rows. Verifying one means opening both files side by side and
either marking it ✅ or writing a ⚠ row with the specific difference. The 14
unverified rows are the remaining Axis 6 work, and they are not evenly sized —
`MemberListContent` (1598), `SessionDetailView` (993), `NewSessionSheet` (599)
and `LoginView` (464) are most of the mass.
