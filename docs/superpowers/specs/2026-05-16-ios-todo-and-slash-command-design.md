# iOS Todo Dock + Slash Command Chip — Design Spec

Status: draft
Owner: zhoujinliang@gmail.com
Date: 2026-05-16

## Summary

Two focused UI improvements to the iOS app's chat surfaces:

1. **Todo dock in StreamingDetailView (per-turn message detail).** Moves the
   `todo_update` rendering out of the main chat feed and into a sticky,
   collapsible dock at the bottom of the per-turn detail view. Auto-collapses
   when every item is completed. Matches the desktop frontend's inline
   variant in styling (numbered list, status icons, count summary, scrollable).
2. **Slash command chip on user_prompt bubbles in SessionDetailView.** When a
   user message starts with `/foo`, the leading command is rendered as a
   monospaced pill inside the bubble, with any remaining text below it.

Both changes are consumer-side only. The ACP event flow, `ChatTimelineReducer`,
`TimelineState`, and SwiftData persistence layer are unchanged — `todo_update`
events still land in `events: [AgentEvent]` exactly as today.

## Motivation

- The current main-feed `FeedItem.todo` bubble clutters the chat history with
  a snapshot row that the reducer also keeps mutating in place — users see a
  "todo bubble" anchored at the position of the first `todo_update`, but its
  content shifts under them as the agent progresses, and it's surrounded by
  unrelated chat turns. Hard to scan and disconnected from the work it
  describes.
- When the user is watching one specific turn in `StreamingDetailView` (the
  per-turn message detail view), they have no access to the agent's current
  plan from that screen — they'd have to back out to the session list and
  scroll to find the todo bubble.
- Slash-command user prompts (`/plan-ceo-review …`, `/qa`, etc.) render
  identically to any other text in the chat, so the user can't quickly tell
  at a glance which messages invoked a command.

## Non-goals

- No changes to the daemon's todo or `AvailableCommands` ACP semantics.
- No new persistence — `todo_update` events continue to live in
  `AgentEvent`/SwiftData; no new tables, no new columns.
- No changes to the composer's existing slash-command popup (already works).
- No richer todo model (e.g. server-side todo CRUD); we keep parsing the
  daemon's text payload (`[done]/[wip]/[todo]` line prefixes).
- No command chip rendering inside StreamingDetailView. Slash command chip
  is SessionDetailView-only.
- No top sticky header variant for the dock — bottom dock only.

## Affected views

- `SessionDetailView` (main chat feed inside one session)
- `StreamingDetailView` (per-turn detail pushed via NavigationLink)
- `EventBubbleView` (renders one `AgentEvent` row; consumed by both views)
- `TodoListView` (existing shared UI — deleted; replaced by `TodoDockView`)

## Design

### Data flow (unchanged + one derived field)

`ChatTimelineReducer` already coalesces `todo_update` ACP events into a
single in-place-replaced entry inside `TimelineState.entries`. That entry
is projected into `events: [AgentEvent]` as an `AgentEvent` whose
`eventType == "todo_update"` and whose `text` is the canonical
multiline string format:

```
[done] First item
[wip]  Second item
[todo] Third item
```

The reducer is the source of truth and is **not modified**.

`SessionDetailViewModel` gains one derived property:

```swift
public var latestTodoText: String? {
    events.last(where: { $0.eventType == "todo_update" })?.text
}
```

Because `events` is the `@Observable` storage that backs the existing
chat surfaces, every consumer of `latestTodoText` re-evaluates when the
reducer mutates the todo entry's text. No additional plumbing needed.

### Todo dock

#### Position

`StreamingDetailView` gains a `.safeAreaInset(edge: .bottom)` that
renders `TodoDockView` when `viewModel.latestTodoText != nil`. The dock
floats above the bottom of the scrollview, does not move with scroll,
and is rendered nowhere else (not in `SessionDetailView`, not in the
session list).

#### Visual

Matches the desktop frontend's `InlineTodoList` variant in
`packages/app/src/components/chat/TodoList.tsx`, translated to native
SwiftUI:

- Container: liquid-glass capsule, 22pt corner radius, horizontal margin 14pt,
  bottom margin 8pt above the home indicator.
- Collapsed (header-only): single 36pt-tall row showing
  `checklist` icon + label `"{count} tasks · {completed} done"` + a
  trailing chevron. The whole row is the toggle target.
- Expanded: header row plus a scrollable item list. Max item-list height
  ≈ 175pt; longer lists scroll inside the dock.
- Each item row: `"{index}.  {status icon}  {content}"`. Item indices
  start at 1. Content text is `.subheadline`. Items with `status == .completed`
  use `.foregroundStyle(.secondary)` + `.strikethrough()`.
- Status icons (SF Symbols):
  - `.completed` — `checkmark.circle.fill`, green
  - `.inProgress` — `clock`, blue (was `arrow.triangle.2.circlepath` in old
    TodoListView; matches desktop's `Clock3` icon)
  - `.pending` — `circle`, secondary
  - `.cancelled` — `xmark.circle`, secondary
- Animation: `easeInOut(0.2)` on max-height + opacity, mirroring the
  desktop dock's collapse transition.

#### Collapse behavior

- `@State private var todoCollapsed: Bool = false` in `StreamingDetailView`.
- On first appearance (`.task` block) and on every change of
  `viewModel.latestTodoText`, re-parse the text. If `items.allSatisfy { $0.status == .completed }`
  is true and the items list is non-empty, set `todoCollapsed = true`.
  When the next push introduces a non-completed item (e.g. agent added a new
  todo or moved one back to wip), set `todoCollapsed = false`.
- User taps on the header always toggles, overriding the rule for the
  current state — the rule only fires on text changes, not on each render.

### Slash command chip

#### Detection

Pure function in `AMUXSharedUI`:

```swift
public func extractSlashCommand(_ text: String) -> (command: String, rest: String)?
```

Regex: `^/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$`

- Must start at character 0 of `text` (after trimming nothing — leading
  whitespace disqualifies; users rarely type `" /cmd"` intentionally).
- Command name: leading letter, then any word characters or dashes
  (matches the daemon's `SlashCommand.name` charset).
- Anything after the first whitespace becomes `rest` (may be empty,
  may include newlines).
- Bare `/` or `/123` or non-slash text → returns `nil`.
- Does **not** check `availableCommands` for membership. Historical messages
  may reference commands no longer registered; chip should still render so
  the user can recognize what was sent.

#### Rendering

In `EventBubbleView`, both `selfUserBubble` and `otherUserBubble`:

```swift
if let parsed = extractSlashCommand(event.text ?? "") {
    VStack(alignment: .leading, spacing: 4) {
        CommandChip(name: parsed.command)
        if !parsed.rest.isEmpty {
            Text(parsed.rest)
                // …existing text styling for the bubble variant…
        }
    }
} else {
    Text(event.text ?? "")
        // …existing text styling…
}
```

`CommandChip` is a small capsule view in `AMUXSharedUI`:

- Shape: `Capsule()`
- Background: `liquidGlass(in: Capsule(), interactive: false)`
- Content: monospaced caption, semibold, `"/{name}"` (the leading slash
  is part of the rendered text, not a separate icon — keeps the chip
  visually self-contained without an extra glyph slot)
- Padding: 8pt horizontal, 3pt vertical
- Tint: inherits from bubble — in `selfUserBubble` the chip background
  is `Color.amux.mist.opacity(0.25)` over the cinnabar bubble; in
  `otherUserBubble` the chip uses default glass over the neutral bubble

The chip is only applied to `user_prompt` events. It does not affect
assistant bubbles, thinking blocks, tool blocks, or markdown rendering.

## File-level change list

### New files

- `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoDockView.swift`
  - `public enum TodoItemStatus { case pending, inProgress, completed, cancelled }`
  - `public struct TodoItem { content: String; status: TodoItemStatus }`
  - `public func parseTodoText(_ text: String) -> [TodoItem]`
    - Recognizes `[done]`, `[wip]`, `[todo]`, `[cancelled]` prefixes;
      unknown / missing prefix → `.pending`
  - `public struct TodoDockView: View { text: String; isCollapsed: Binding<Bool> }`

- `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/CommandChip.swift`
  - `public func extractSlashCommand(_ text: String) -> (command: String, rest: String)?`
  - `public struct CommandChip: View { name: String }`

- `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/CommandChipParsingTests.swift`
- `apps/ios/Packages/AMUXSharedUI/Tests/AMUXSharedUITests/TodoDockParsingTests.swift`

### Modified files

- `apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift`
  - Add `public var latestTodoText: String? { … }`.

- `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/FeedItem.swift`
  - Remove `case todo(AgentEvent)` from the `FeedItem` enum.
  - Remove the `id` getter arm for `.todo`.
  - In `buildFeedItems`, replace `case "todo_update": result.append(.todo(event))`
    with `case "todo_update": continue` (or drop the case entirely so it
    falls into `default`, which today is a debug fallback — `continue` is
    explicit about the intent and skips the fallback row).

- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/EventFeedView.swift`
  - Remove the `case "todo_update":` arm in `EventBubbleView.body`
    (the `TodoListView(text:)` invocation is orphaned).
  - In `selfUserBubble`: replace the inner `Text(event.text ?? "")` with
    the conditional chip + remainder layout described above.
  - Same change in `otherUserBubble`.

- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/SessionDetailView.swift`
  - In `feedItemRow(_:)`, drop `.todo(let event)` from the multi-case pattern:
    `case .userMessage(let event), .permission(let event), .error(let event):`
  - No other changes — the bubble's render call still routes through
    `EventBubbleView`, which now handles the chip.

- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/StreamingDetailView.swift`
  - Add `@State private var todoCollapsed: Bool = false`.
  - Wrap the existing body in a `safeAreaInset(edge: .bottom)` modifier:
    ```swift
    .safeAreaInset(edge: .bottom) {
        if let text = viewModel.latestTodoText {
            TodoDockView(text: text, isCollapsed: $todoCollapsed)
        }
    }
    ```
  - Add a `.task(id: viewModel.latestTodoText)` that re-parses the text
    and updates `todoCollapsed` per the rule above.

### Deleted files

- `apps/ios/Packages/AMUXSharedUI/Sources/AMUXSharedUI/TodoListView.swift`
  - Last consumer is the `todo_update` arm of `EventBubbleView`, removed
    above. Replaced functionally by `TodoDockView`.

### Test changes

- `apps/ios/Packages/AMUXCore/Tests/AMUXCoreTests/` — find existing tests
  that assert `FeedItem.todo` is produced for `todo_update` events and
  flip them to assert no FeedItem is produced for that event type. The
  reducer's `todo_update` in-place-replace behavior tests stay intact.

- New: `CommandChipParsingTests` covers
  - `/cmd args here` → `("cmd", "args here")`
  - `/cmd` → `("cmd", "")`
  - `/cmd-with-dash` → matches
  - `/cmd_under` → matches (`_` is in `\w`)
  - `/123` → `nil` (must start with letter)
  - `/` alone → `nil`
  - `not a command` → `nil`
  - ` /cmd` (leading space) → `nil`
  - `/cmd\nrest of text` → `("cmd", "rest of text")` (newline counts as
    whitespace separator; `rest` includes any following text)

- New: `TodoDockParsingTests` covers
  - All four prefix types parse to the right status
  - Lines with no recognized prefix → `.pending`
  - Empty text → `[]`
  - Trailing whitespace on item content is trimmed
  - Status counts sum correctly across mixed input

## Implementation order

Each step is independently compilable; steps 6–8 land together.

1. Add `TodoDockView.swift` (+ parser, types, tests) — no consumers yet.
2. Add `CommandChip.swift` (+ parser, tests) — no consumers yet.
3. Add `latestTodoText` derived prop on `SessionDetailViewModel`.
4. Wire `TodoDockView` into `StreamingDetailView` via `safeAreaInset`.
5. Update `selfUserBubble` / `otherUserBubble` in `EventBubbleView` to use
   the chip + remainder layout.
6. Remove `FeedItem.todo` enum case + its `id` arm + `buildFeedItems` arm.
7. Remove the orphan `case "todo_update":` in `EventBubbleView`.
8. Drop `.todo` from `SessionDetailView.feedItemRow`'s switch (compile-forced).
9. Delete `TodoListView.swift`.
10. Update existing tests that referenced `FeedItem.todo`.

## Edge cases

- **Empty todo (no items recognized).** `parseTodoText` returns `[]`;
  `TodoDockView` short-circuits and renders nothing — but the parent
  `safeAreaInset` only mounts the dock when `latestTodoText != nil`, so
  this state arises only if the daemon emits a `todo_update` with empty
  text. In that case the dock renders a header showing `"0 tasks · 0 done"`.
  Acceptable; the daemon shouldn't be sending empty updates in practice.
- **Long item content.** Items wrap inside their row; the scrollable
  list handles overflow vertically.
- **Multi-line slash command body.** The chip renders the command name
  only; the entire body (including newlines) goes into the rest line.
  `Text(rest)` wraps natively.
- **Slash command at the start of a multi-message conversation.** Each
  qualifying user_prompt independently renders its own chip — chips are
  per-bubble, not session-scoped.
- **Daemon retires a slash command name.** Historical messages still
  render the chip (parser is regex-only, not membership-checked). The
  composer popup separately won't suggest it (popup uses
  `availableCommands` which is server-authoritative).
- **Concurrent live updates while user is reading the dock.** The reducer's
  in-place mutation of the todo entry shifts `events.last(where:)`'s
  return-value text under the dock; `@Observable` propagates the change
  and the dock re-renders without animation jank because each row keys
  on `(index, status, content)` via the parsed array.

## Out-of-scope follow-ups (not in this spec)

- Animating individual item status transitions in the dock (today the
  whole list re-renders on each update).
- Tap-to-jump from a todo item to the tool call that produced it.
- Sticky-pinned dock variant for `SessionDetailView` (we chose
  StreamingDetailView only).
- Inline slash command chip in the composer text field as the user types
  (the popup already covers discovery).
