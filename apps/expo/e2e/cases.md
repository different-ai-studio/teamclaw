# Expo E2E Case Catalog

Date: 2026-05-25
Owner: Codex
App: `apps/expo`
Status: Proposed case set for manual and future automated E2E coverage

## Goal

Increase Expo E2E coverage from one representative case into a broad set of
cases that protects the main mobile product surfaces:

- onboarding and auth routing
- tab shell navigation
- sessions list, create, detail, composer, members, and batch actions
- ideas list, create, detail, archive, and restore
- actors list, invite, actor detail, and access management
- global search and history
- settings, notifications, teams, workspaces, shortcuts, and profile flows
- real-chain MQTT, push, invite-link, and agent-runtime behavior

The repo currently has no Expo-specific Maestro or Detox harness. These cases
are written so they can be used as a manual E2E checklist now and converted to
automation once stable selectors and seed/cleanup helpers exist.

## Tracks

Use these tracks to keep the suite useful instead of making one huge flaky
bucket.

| Track | Purpose | Backend | Default run |
| --- | --- | --- | --- |
| `expo-pr-candidate` | Fast deterministic smoke once a mobile harness exists | seeded Supabase or controlled mocks | future PR gate |
| `expo-nightly-real-chain` | Real Supabase, MQTT, push, and runtime integration | real services | nightly/manual |
| `expo-manual-needs-selectors` | Valuable cases blocked by labels, system UI, or native dialogs | real services | manual until hardened |

## Seed Profiles

Prepare these data profiles once and reuse them across cases.

### Profile A: Signed-out User

- no Supabase session
- app starts at `/`

### Profile B: Ready User With Team

- valid `apps/expo/.dev-session.json`
- one active team
- current user's member actor
- one additional human member actor
- at least one agent actor, which may be offline
- two sessions with different timestamps and messages
- two ideas with different statuses
- one workspace
- one shortcut folder and one session shortcut

### Profile C: Real-chain Agent Team

- all Profile B data
- one connected TeamClaw daemon for an agent actor
- workspace bound to that agent
- MQTT reachable

### Profile D: Push-capable Device

- all Profile B data
- simulator or device can register a native push token
- FC notification fan-out can target the seeded user

## Selector Hardening Needed

Automation should add stable labels or `testID`s for these controls before
converting the full matrix to Maestro or Detox.

| Surface | Needed selector |
| --- | --- |
| Sessions header create icon | `New Session` |
| New session collaborators row | `Add collaborators` |
| New session first-message input | `First message` |
| Session composer input | `Message composer` |
| Session composer send button | `Send message` |
| Tabs | `Sessions tab`, `Ideas tab`, `Actors tab`, `Search tab` |
| Settings close and rows | `Settings`, `Workspaces`, `Notifications`, `All teams` |
| Workspace create input | `Workspace name` |
| Invite display-name input | `Invite display name` |
| Idea title and description inputs | `Idea title`, `Idea description` |

## Case Matrix

### Onboarding And Auth

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-001 | `expo-pr-candidate` | Signed-out launch routes to welcome | Profile A | Launch app at `/` | Welcome screen is visible, no authenticated tabs are visible | none |
| EXPO-E2E-002 | `expo-pr-candidate` | Welcome to auth choice | Profile A | Tap get started | `Set up Teamclaw` is visible, private workspace and sign-in choices are visible | none |
| EXPO-E2E-003 | `expo-nightly-real-chain` | Anonymous private workspace bootstrap | Profile A, Supabase anon enabled | Choose private workspace, create first team if prompted | App reaches `Sessions`, team identity is visible in settings | delete generated team/user if supported |
| EXPO-E2E-004 | `expo-nightly-real-chain` | Email OTP sign-in happy path | test email inbox or test OTP helper | Enter email, submit OTP, finish team bootstrap | App reaches `Sessions`; user email appears in Settings | cleanup seeded user/session |
| EXPO-E2E-005 | `expo-nightly-real-chain` | Invite link join from signed-out state | valid invite token | Open `teamclaw://invite/<token>`, continue through auth | User joins invited team and reaches `Sessions` | revoke invite and delete joined actor |
| EXPO-E2E-006 | `expo-pr-candidate` | Dev session restore | Profile B | Open `/dev-session` or matching deep link | `Sessions` appears, missing dev-session warning is absent | none |
| EXPO-E2E-007 | `expo-pr-candidate` | Bootstrap failure stays recoverable | invalid Supabase env or forced API failure | Launch app | Friendly bootstrap error appears and retry is available | none |

### App Shell And Navigation

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-008 | `expo-pr-candidate` | Bottom tabs navigate without losing auth state | Profile B | Visit Sessions, Ideas, Actors, Search tabs | Each tab title appears; no redirect to auth occurs | none |
| EXPO-E2E-009 | `expo-pr-candidate` | Settings opens from sessions shell and closes | Profile B | Open Settings from the sessions shortcuts/profile path | `Settings`, team name, app version, and sign out row are visible; close returns to prior screen | none |
| EXPO-E2E-010 | `expo-manual-needs-selectors` | Pull-to-refresh surfaces stay stable | Profile B | Pull refresh on Sessions, Ideas, Actors | Existing rows remain visible or reload without blank-state flicker | none |

### Sessions List

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-011 | `expo-pr-candidate` | Sessions list loads grouped rows | Profile B | Open Sessions | Seeded sessions are visible, ordered by recent activity, grouped by date | none |
| EXPO-E2E-012 | `expo-pr-candidate` | Sessions search filters rows | Profile B | Search for a seeded session title, clear search | Matching row remains, non-matches disappear, clear restores list | none |
| EXPO-E2E-013 | `expo-pr-candidate` | Empty sessions state | ready team with zero sessions and at least one actor | Open Sessions | `No Sessions` state appears with new-session affordance | none |
| EXPO-E2E-014 | `expo-pr-candidate` | Sessions load error state | forced listSessions failure | Open Sessions | `Couldn't load sessions` and Retry are visible | none |
| EXPO-E2E-015 | `expo-manual-needs-selectors` | Batch select and archive sessions | Profile B with disposable sessions | Long-press row, select multiple, archive | Batch bar appears, selected sessions disappear after archive | restore or delete disposable sessions |
| EXPO-E2E-016 | `expo-manual-needs-selectors` | Mark read and unread batch actions | Profile B with unread sessions | Select rows, mark read, mark unread | Unread badge/count updates consistently | reset read markers |
| EXPO-E2E-017 | `expo-manual-needs-selectors` | Pin and unpin a session | Profile B | Open row context menu, pin, then unpin | Pinned row moves into pinned section, then returns | unpin row |

### Session Creation

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-018 | `expo-pr-candidate` | Create human collaboration session with first message | Profile B | New Session, add human peer, enter first message, start | Detail route opens, title derives from first message, at least two actors, first message visible | delete created session/messages |
| EXPO-E2E-019 | `expo-pr-candidate` | New session validation blocks empty collaborator or message | Profile B | Open New Session with no collaborator, then with no message | Start button stays disabled until both requirements are met | none |
| EXPO-E2E-020 | `expo-nightly-real-chain` | Create session linked to idea | Profile B with open idea | New Session from idea or select idea in create flow | Detail opens and first message includes idea context/preface | delete created session/messages |
| EXPO-E2E-021 | `expo-nightly-real-chain` | Agent-backed create starts runtime | Profile C | New Session, select online agent and workspace config, start | Detail opens, runtime bar shows starting/running state | stop runtime, delete session |
| EXPO-E2E-022 | `expo-pr-candidate` | Offline agent create fails clearly | Profile B with offline agent | New Session, select offline agent, start | Inline error says daemon is offline and form values remain | none |

### Session Detail And Composer

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-023 | `expo-pr-candidate` | Open session detail with persisted history | Profile B with seeded messages | Tap seeded session row | Header title, participant count, day separator, and seeded messages are visible | none |
| EXPO-E2E-024 | `expo-pr-candidate` | Back from detail returns to sessions list | Profile B | Open detail, tap back | Sessions list is visible and tab bar returns | none |
| EXPO-E2E-025 | `expo-nightly-real-chain` | Composer sends text when realtime is live | Profile B with MQTT reachable | Open detail, type message, send | Message appears, composer clears, no send error | delete message |
| EXPO-E2E-026 | `expo-pr-candidate` | Composer draft survives route away and back | Profile B | Type draft, navigate away, return to same session | Draft text is restored | clear draft |
| EXPO-E2E-027 | `expo-pr-candidate` | Offline composer shows helper and blocks send | Profile B with MQTT disabled | Open detail | Offline banner/helper visible, send disabled or safe no-op | none |
| EXPO-E2E-028 | `expo-nightly-real-chain` | Incoming MQTT message appears without refresh | Profile C | Open detail, publish `message.created` event externally | New message appears once and in chronological order | delete injected message |
| EXPO-E2E-029 | `expo-pr-candidate` | Duplicate live message is not rendered twice | Profile B with controlled MQTT helper | Inject same message event twice | Timeline contains one row for the message id | delete injected message |
| EXPO-E2E-030 | `expo-manual-needs-selectors` | Slash command popup and command insert | Profile B | Type `/`, select command | Popup appears and command text is inserted/sent as expected | clear composer |
| EXPO-E2E-031 | `expo-manual-needs-selectors` | Mention popup and mention metadata path | Profile B with peer actor | Type `@`, select peer, send | Mention text appears and message persists | delete message |
| EXPO-E2E-032 | `expo-manual-needs-selectors` | Reply to a message | Profile B with seeded messages | Long-press message, choose reply, send reply | Reply preview appears and row links to original | delete reply |
| EXPO-E2E-033 | `expo-manual-needs-selectors` | Edit own message | Profile B with own seeded message | Long-press own message, edit content | Updated content appears after save and persists after refresh | restore content |
| EXPO-E2E-034 | `expo-manual-needs-selectors` | Delete own message | Profile B with disposable message | Long-press own message, delete | Message disappears and stays gone after refresh | none |
| EXPO-E2E-035 | `expo-nightly-real-chain` | Attachment drawer uploads image/file | Profile B with storage configured | Open attach, pick supported file, send | Attachment tile appears in composer and message row | delete uploaded object/message |
| EXPO-E2E-036 | `expo-pr-candidate` | Session mute toggle persists | Profile B | Open detail, toggle mute, leave and return | Muted icon/state is retained | reset mute row |
| EXPO-E2E-037 | `expo-manual-needs-selectors` | Share session link | Profile B | Tap share in detail | Native share sheet receives `teamclaw://session/<id>` | none |

### Session Members And Runtime

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-038 | `expo-pr-candidate` | Open session members sheet | Profile B | From detail, open members | Existing participants are visible | none |
| EXPO-E2E-039 | `expo-pr-candidate` | Add human member to session | Profile B with extra human actor | Members, Add member, select actor, confirm | Actor appears in participants and detail count updates after reload | remove actor from session |
| EXPO-E2E-040 | `expo-pr-candidate` | Remove human member from session | Profile B with disposable participant | Remove participant | Participant disappears and toast confirms removal | re-add if needed |
| EXPO-E2E-041 | `expo-nightly-real-chain` | Add online agent to existing session | Profile C | Members, Add agent, select online agent | Agent appears, runtime start request is issued, runtime row updates | stop runtime, remove participant |
| EXPO-E2E-042 | `expo-nightly-real-chain` | Change running agent model | Profile C with runtime | Members, change model, enter model | Runtime model bar updates | restore model |
| EXPO-E2E-043 | `expo-nightly-real-chain` | Restart agent runtime | Profile C with runtime | Members, restart agent | Runtime stop/start requests are sent and status changes | stop test runtime |

### Ideas

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-044 | `expo-pr-candidate` | Ideas list loads and filters | Profile B | Open Ideas, switch All/Mine/Open/Done | Counts and visible rows match seed data | none |
| EXPO-E2E-045 | `expo-pr-candidate` | Ideas search filters rows | Profile B | Search seeded idea title, clear | Matching idea appears, clear restores list | none |
| EXPO-E2E-046 | `expo-pr-candidate` | Create idea without workspace | Profile B | Create Idea, enter title/description, create | Idea detail opens and shows created content | archive/delete idea |
| EXPO-E2E-047 | `expo-pr-candidate` | Create idea linked to workspace | Profile B with workspace | Create Idea, pick workspace, create | Detail/list show workspace label | archive/delete idea |
| EXPO-E2E-048 | `expo-pr-candidate` | Idea detail status change | Profile B with disposable idea | Open detail, change status | Status changes and list filter reflects new status | restore status |
| EXPO-E2E-049 | `expo-pr-candidate` | Archive and restore idea | Profile B with disposable idea | Archive idea, open archived ideas, restore | Idea moves out of active list and returns after restore | none |
| EXPO-E2E-050 | `expo-nightly-real-chain` | Create session from idea | Profile B with open idea | From idea detail, start session | New session is linked to idea and first prompt includes idea context | delete session |

### Actors And Invites

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-051 | `expo-pr-candidate` | Actors list loads and filters | Profile B | Open Actors, switch All/Humans/Agents | Humans and agents sections match seed data | none |
| EXPO-E2E-052 | `expo-pr-candidate` | Actors search filters rows | Profile B | Search peer display name, clear | Matching actor appears and clear restores list | none |
| EXPO-E2E-053 | `expo-pr-candidate` | Actor detail opens for member | Profile B | Tap human actor | Profile/detail fields are visible | none |
| EXPO-E2E-054 | `expo-pr-candidate` | Actor detail opens for agent | Profile B | Tap agent actor | Agent configuration, access, and workspace sections are visible | none |
| EXPO-E2E-055 | `expo-nightly-real-chain` | Create member invite link | Profile B | Actors, Invite, teammate, name, create | Invite deeplink is visible, copy works | revoke/delete invite |
| EXPO-E2E-056 | `expo-nightly-real-chain` | Create agent invite link | Profile B | Invite, agent, name, create | Agent invite deeplink is visible | revoke/delete invite |
| EXPO-E2E-057 | `expo-nightly-real-chain` | Reinvite actor from actor detail | Profile B with actor | Open actor detail, reinvite | New invite link is generated | revoke invite |
| EXPO-E2E-058 | `expo-nightly-real-chain` | Remove actor access guard | Profile B with disposable actor | Remove actor from team | Actor disappears from list and related session picker | recreate if needed |

### Global Search

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-059 | `expo-pr-candidate` | Search returns sessions, ideas, and members | Profile B | Open Search, enter shared run id | Separate Sessions, Ideas, and Members sections appear | none |
| EXPO-E2E-060 | `expo-pr-candidate` | Search result navigation to session | Profile B | Search session, tap result | Matching session detail opens | none |
| EXPO-E2E-061 | `expo-pr-candidate` | Search result navigation to idea | Profile B | Search idea, tap result | Matching idea detail opens | none |
| EXPO-E2E-062 | `expo-pr-candidate` | Search result navigation to actor | Profile B | Search member, tap result | Matching actor detail opens | none |
| EXPO-E2E-063 | `expo-pr-candidate` | Search history records and clears | Profile B | Search term, wait, clear field, clear history | Recent chip appears and can be cleared | clear search history |
| EXPO-E2E-064 | `expo-pr-candidate` | No results state | Profile B | Search impossible token | `No results` state appears | none |

### Settings, Profile, Notifications, Teams

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-065 | `expo-pr-candidate` | Settings identity and team metadata | Profile B | Open Settings | Display name, team name, role, id, app version are visible | none |
| EXPO-E2E-066 | `expo-pr-candidate` | Edit profile display name | Profile B | Settings, edit profile, change name | New name appears in Settings and actor list | restore name |
| EXPO-E2E-067 | `expo-nightly-real-chain` | Edit profile avatar | Profile B with image picker available | Settings, edit profile, choose image | Avatar preview and persisted avatar update | delete uploaded avatar |
| EXPO-E2E-068 | `expo-pr-candidate` | Local notification toggles persist | Profile B | Settings, Notifications, toggle Agent replies and Mentions, leave and return | Toggle states are retained on device | reset AsyncStorage prefs |
| EXPO-E2E-069 | `expo-nightly-real-chain` | Remote push preferences persist | Profile B | Notifications, toggle Enable push and DND times | Supabase prefs load back after relaunch | reset push prefs |
| EXPO-E2E-070 | `expo-pr-candidate` | Teams list opens from settings | Profile B | Settings, All teams | Team list is visible and current team is indicated | none |
| EXPO-E2E-071 | `expo-nightly-real-chain` | Rename team | Profile B with disposable team | Teams, rename current team | New name appears in settings and teams list | restore name |
| EXPO-E2E-072 | `expo-manual-needs-selectors` | Sign out returns to public route | Profile B | Settings, Sign out, confirm native alert | App returns to welcome/auth route | recreate dev session if needed |
| EXPO-E2E-073 | `expo-nightly-real-chain` | Anonymous upgrade path opens | anonymous Profile B | Settings, Upgrade account | Upgrade screen opens and email/OAuth options are visible | none |

### Workspaces

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-074 | `expo-pr-candidate` | Workspaces list opens from settings | Profile B | Settings, Workspaces | Active workspace list and create row are visible | none |
| EXPO-E2E-075 | `expo-pr-candidate` | Create workspace | Profile B | Enter workspace name, Create | Workspace appears in Active list | archive/delete workspace |
| EXPO-E2E-076 | `expo-pr-candidate` | Edit workspace local path | Profile B with workspace | Edit path, enter path, submit | New path appears in mono row | restore path |
| EXPO-E2E-077 | `expo-pr-candidate` | Archive and restore workspace | Profile B with disposable workspace | Archive, then restore from Archived section | Workspace moves between Active and Archived | none |
| EXPO-E2E-078 | `expo-nightly-real-chain` | Bind workspace to agent | Profile B with agent | Workspaces, Bind an agent, pick agent | Bound agent label appears | unbind agent |

### Shortcuts

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-079 | `expo-pr-candidate` | Shortcuts drawer opens from sessions | Profile B with shortcuts | Tap shortcuts/grid | Drawer or shortcuts screen shows seeded folder/shortcut | none |
| EXPO-E2E-080 | `expo-pr-candidate` | Open session shortcut | Profile B with session shortcut | Open shortcuts, tap session shortcut | Matching session detail opens | none |
| EXPO-E2E-081 | `expo-pr-candidate` | Navigate shortcut folder and back | Profile B with folder | Open folder, back to parent | Child rows appear, then parent rows return | none |
| EXPO-E2E-082 | `expo-pr-candidate` | Rename shortcut | Profile B with disposable shortcut | Edit shortcuts, rename row | New label persists after reload | restore label |
| EXPO-E2E-083 | `expo-pr-candidate` | Delete shortcut | Profile B with disposable shortcut | Edit shortcuts, delete row, confirm | Shortcut disappears | recreate if needed |
| EXPO-E2E-084 | `expo-manual-needs-selectors` | Open external URL shortcut | Profile B with URL shortcut | Tap URL shortcut | Native browser/linking opens supported URL | none |

### Push, Deep Links, And Device Events

| ID | Track | Case | Preconditions | Steps | Assertions | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| EXPO-E2E-085 | `expo-nightly-real-chain` | Push token registration | Profile D | Launch ready app | Push token row is upserted for user/device/platform | delete token row if needed |
| EXPO-E2E-086 | `expo-nightly-real-chain` | Notification tap routes to session | Profile D with push payload | Deliver notification containing session id, tap it | Matching session detail opens once | delete notification artifacts |
| EXPO-E2E-087 | `expo-nightly-real-chain` | Duplicate notification response is deduped | Profile D | Replay same notification response twice | Only one navigation occurs | none |
| EXPO-E2E-088 | `expo-nightly-real-chain` | Foreground presence heartbeat | Profile B | Keep app foregrounded | Presence row updates for device/user | delete or expire presence row |
| EXPO-E2E-089 | `expo-nightly-real-chain` | Invite deep link while app is foregrounded | Profile B with valid invite | Open invite link while app is open | Invite is claimed and toast appears | leave invited team/delete actor |
| EXPO-E2E-090 | `expo-nightly-real-chain` | Invite deep link cold start | Profile A with valid invite | Launch app through invite link | Pending invite is stored and claimed after auth | revoke invite/delete actor |

## Suggested Automation Order

Convert in this order once selectors are in place.

1. EXPO-E2E-006, 008, 011, 012, 018, 023, 024
2. EXPO-E2E-044, 045, 046, 051, 052, 059, 064
3. EXPO-E2E-065, 074, 075, 079, 080
4. EXPO-E2E-025, 028, 041, 055, 069, 086 for nightly only

This gives a useful PR smoke lane first, then broadens into the real-chain
paths that are expected to be slower or more environment-sensitive.

## Cleanup Rules

Every automated run should generate a `runId` and include it in created data:

- sessions: `expo-e2e-session-<runId>`
- messages: `expo-e2e-message-<runId>`
- ideas: `expo-e2e-idea-<runId>`
- actors: `Expo E2E Actor <runId>`
- workspaces: `expo-e2e-workspace-<runId>`
- shortcuts: `expo-e2e-shortcut-<runId>`
- invite names: `Expo E2E Invite <runId>`

Cleanup should be admin-side or helper-side, not through the app UI, unless the
case specifically tests archive/delete behavior.

## Minimum First Automated Suite

When a mobile E2E harness is added, the first suite should contain:

- EXPO-E2E-006: Dev session restore
- EXPO-E2E-008: Bottom tabs navigate
- EXPO-E2E-011: Sessions list loads
- EXPO-E2E-012: Sessions search
- EXPO-E2E-018: Create human collaboration session with first message
- EXPO-E2E-023: Open session detail with persisted history
- EXPO-E2E-024: Back from detail
- EXPO-E2E-044: Ideas list loads and filters
- EXPO-E2E-051: Actors list loads and filters
- EXPO-E2E-059: Global search returns mixed results
- EXPO-E2E-065: Settings identity and team metadata

That set gives broad app coverage without depending on OTP, native pickers,
push delivery, online agents, or live model quality.
