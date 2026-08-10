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

| Status | Count | of which partial |
|---|---|---|
| ✅ verified | 22 | 7 |
| ⚠ known gap | 3 | — |
| ◻ unverified | 44 | — |
| ✖ missing | 1 | — |
| **Total** | **70** | |

---

## AMUXSharedUI — cross-screen primitives

| iOS | LOC | Expo | |
|---|---|---|---|
| `AMUXAnimation` | 57 | `ui/theme.ts` → `motion` | ✅ |
| `AMUXTheme` | 133 | `ui/theme.ts` | ⚠ light-only; no Sumi dark set (excluded by the user) |
| `CommandChip` | 48 | `sessions/components/slash-commands.ts` | ◻ |
| `ConnectionBanner` | 60 | `sessions/components/ConnectionBannerOverlay.tsx` | ◻ |
| `MarkdownRenderer` | 141 | inline in `SessionMessageRow.tsx` | ◻ |
| `MentionsPopup` | 119 | `sessions/components/MentionsPopup.tsx` | ◻ |
| `PermissionBanner` | 68 | `sessions/components/PermissionBanner.tsx` | ◻ |
| `SessionPlansPanelView` | 102 | `sessions/components/SessionPlansPanel.tsx` | ◻ |
| `SlashCommandsPopup` | 118 | `sessions/components/SlashCommandsPopup.tsx` | ◻ |
| `StreamingTextView` | 51 | inline in `SessionMessageRow.tsx` | ◻ |
| `TodoDockView` | 92 | `sessions/components/TodoDock.tsx` | ◻ |
| `TodoItemStyling` | 21 | `sessions/components/todo-dock-parser.ts` | ◻ |
| `ToolCallView` | 343 | — | ⚠ see below |
| `ViewModifiers` | 50 | scattered | ◻ |

## AMUXUI/AgentDetail — the session screen

| iOS | LOC | Expo | |
|---|---|---|---|
| `AddAgentSheet` | 139 | `MemberPickerSheet.tsx` | ◻ |
| `AddMemberSheet` | 48 | `MemberPickerSheet.tsx` | ◻ |
| `AgentChipBar` | 169 | `components/AgentChipBar.tsx` | ◻ |
| `AgentsSheet` | 197 | partly `AgentConfigSheet.tsx` | ◻ per-agent model switch + stop-mid-stream confirm unconfirmed |
| `AttachmentDrawerSheet` | 165 | `screens/AttachmentDrawerSheet.tsx` | ◻ |
| `CameraImagePicker` | 45 | `app/(app)/attach.tsx` (expo-image-picker) | ✅ |
| `ComposerState` | 30 | `components/composer-state.ts` | ✅ |
| `EventFeedView` | 908 | `SessionMessageRow.tsx` + `session-feed-items.ts` | ✅ bubbles ⚠ tool calls |
| `RecordingWaveform` | 55 | `components/RecordingWaveform.tsx` | ✅ |
| `SessionComposer` | 538 | `components/SessionComposerShell.tsx` | ✅ |
| `SessionDetailView` | 993 | `screens/SessionDetailScreen.tsx` | ◻ header/glass only |
| `SessionMemberSheet` | 179 | `screens/SessionMemberSheet.tsx` | ◻ **next** |
| `StreamingDetailView` | 292 | `AgentTurnDetailModal` in `SessionDetailScreen.tsx` | ⚠ see below |

## AMUXUI/Collab — ideas

| iOS | LOC | Expo | |
|---|---|---|---|
| `ArchivedIdeasView` | 48 | `app/(app)/archived-ideas.tsx` | ◻ |
| `IdeaDetailView` | 859 | `screens/IdeaDetailScreen.tsx` | ✅ activity feed, attachments, progress composer ◻ rest |
| `IdeaImageAttachments` | 205 | `components/IdeaImageAttachmentStrip.tsx` | ✅ |
| `IdeaListView` | 236 | `screens/IdeasListScreen.tsx` + `IdeaRow.tsx` | ✅ |
| `IdeaSheets` | 446 | `app/(app)/new-idea.tsx` | ◻ |
| `IdeaStatsSheet` | 383 | `screens/IdeaStatsSheet.tsx` | ✅ |
| `IdeaUIPresentation` | 5 | `ideas/idea-types.ts` | ◻ |

## AMUXUI/Members — actors

| iOS | LOC | Expo | |
|---|---|---|---|
| `ActorResourceListView` | 207 | `screens/ActorResourceListScreen.tsx` | ✅ |
| `MemberInviteSheet` | 194 | `app/(app)/invite.tsx` | ◻ |
| `MemberListContent` | 1598 | `ActorsListScreen.tsx` + `ActorDetailScreen.tsx` | ✅ `ActorRow`, team resources, default agent, info rows ◻ rest |
| `MemberListView` | 376 | `screens/ActorsListScreen.tsx` | ◻ |
| `TeamStatsSheet` | 361 | `screens/TeamStatsSheet.tsx` | ✅ |

`MemberListContent` is the largest single file on either side and holds
`ActorDetailView` (431–1378) plus five row types. Only a slice is verified.

## AMUXUI/Onboarding + Root

| iOS | LOC | Expo | |
|---|---|---|---|
| `ApertureSplashView` | 142 | `screens/ApertureSplashScreen.tsx` | ✅ |
| `ZeroAgentReminderSheet` | 48 | `screens/ZeroAgentReminderSheet.tsx` | ◻ |
| `AppTab` | 10 | `app/(app)/(tabs)/_layout.tsx` | ◻ |
| `ConnectionBannerOverlay` | 24 | `components/ConnectionBannerOverlay.tsx` | ◻ |
| `IdeasTab` | 209 | `app/(app)/(tabs)/ideas.tsx` | ✅ header ◻ body |
| `MembersTab` | 145 | `app/(app)/(tabs)/actors.tsx` | ✅ header ◻ body |
| `RootTabView` | 318 | `app/(app)/(tabs)/_layout.tsx` | ✅ glass tab bar |
| `SearchTab` | 144 | `app/(app)/(tabs)/search.tsx` | ◻ |
| `SessionsTab` | 363 | `app/(app)/(tabs)/sessions/index.tsx` | ✅ header ◻ body |

## AMUXUI/SessionList

| iOS | LOC | Expo | |
|---|---|---|---|
| `AgentConfigSheet` | 129 | `components/AgentConfigSheet.tsx` | ◻ |
| `DaemonStatusBanner` | 104 | `components/DaemonStatusBanner.tsx` | ✅ |
| `NewSessionSheet` | 599 | `screens/NewSessionScreen.tsx` | ◻ |
| `ParticipantCluster` | 102 | `ui/atoms/AvatarStack.tsx` | ◻ |
| `SessionListHelpers` | 546 | `components/SessionRow.tsx` + `session-row-runtime.ts` | ✅ |

## AMUXUI/Settings, Shared, Shortcuts

| iOS | LOC | Expo | |
|---|---|---|---|
| `NotificationsSettingsView` | 98 | `app/(app)/notifications.tsx` | ◻ |
| `SettingsView` | 911 | `screens/SettingsScreen.tsx` | ✅ surface coverage ◻ visual |
| `UpgradeAccountSheet` | 294 | `app/(app)/upgrade-account.tsx` | ◻ |
| `GlassButtonStyle` | 32 | `ui/button.tsx` | ◻ |
| `HaiSheet` | 79 | — | ✖ see below |
| `LiquidGlassBar` | 76 | `ui/GlassHeader.tsx` + `GlassSurface.tsx` | ✅ |
| `SegmentedFilterBar` | 81 | `actors/components/SegmentedFilter.tsx` | ◻ |
| `ShortcutMenuRow` | 225 | inside `shortcuts/ShortcutsDrawer.tsx` | ◻ |
| `ShortcutPresentation` | 24 | inside `shortcuts/ShortcutsDrawer.tsx` | ◻ |
| `ShortcutsDrawer` | 287 | `shortcuts/ShortcutsDrawer.tsx` | ◻ |
| `ShortcutWebView` | 204 | `shortcuts/ShortcutWebScreen.tsx` | ◻ |

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

### `ToolCallView` (343 LOC) — no structured equivalent

iOS renders every tool call as its own card: name, a `ToolDisplay`-formatted
argument summary, output, and a status chip that moves through
running → completed → failed. `CompactToolLine` is the collapsed form used in
the feed.

Expo has no tool-call component at all — `grep -ri toolcall apps/expo/src`
returns nothing. `session-turn-detail.ts` folds `agent_tool_call` and
`agent_tool_result` into one "tools" group and renders them as counted text
lines. The information reaches the user; the structure does not. Tool failures
in particular are not visually distinct from successes.

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
either marking it ✅ or writing a ⚠ row with the specific difference. The 44
unverified rows are the remaining Axis 6 work, and they are not evenly sized —
`MemberListContent` (1598), `SessionDetailView` (993), `NewSessionSheet` (599)
and `LoginView` (464) are most of the mass.
