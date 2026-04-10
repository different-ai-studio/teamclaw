# iOS Session Page Redesign

**Date:** 2026-04-10
**Branch:** feature/ios-mobile-improvement
**Files affected:** `ChatDetailView.swift`, `ChatInputBar.swift`

---

## Overview

Two improvements to the iOS session chat page:

1. **Navigation bar** — liquid glass back button + `···` capsule menu replacing the bare collaborator avatars
2. **Input bar** — iMessage-style single-row layout replacing the two-row toolbar + input layout

---

## 1. Navigation Bar (ChatDetailView)

### Back Button

- Hide the default NavigationStack back chevron with `.navigationBarBackButtonHidden(true)`
- Add `ToolbarItem(placement: .navigationBarLeading)` with a custom button
- Button shape: circle, using `.liquidGlass(in: Circle(), interactive: true)`
- Icon: `Image(systemName: "chevron.left")`
- Action: `dismiss()` via `@Environment(\.dismiss)`

### `···` Capsule Menu

- Replace the existing `collaboratorAvatars` toolbar item with a SwiftUI `Menu`
- Menu label: `Image(systemName: "ellipsis")` wrapped in `.liquidGlass(in: Capsule(), interactive: true)` with padding to form a capsule shape
- Menu placement: `ToolbarItem(placement: .navigationBarTrailing)`
- Five menu items:

| Label | SF Symbol | Action |
|---|---|---|
| 选择模型 | `cpu` | `showModelPicker = true` |
| 邀请成员 | `person.badge.plus` | no-op placeholder |
| 归档 Session | `archivebox` | no-op placeholder |
| 分享 | `square.and.arrow.up` | `ShareLink(item: session.title)` |
| Session 详情 | `info.circle` | no-op placeholder |

- Remove `collaboratorAvatars` computed property and the `session.isCollaborative` toolbar condition
- Keep `@State private var showModelPicker` — now triggered from menu instead of input bar

---

## 2. Input Bar (ChatInputBar)

### Removed

- Top toolbar row (gear button + `PhotosPicker` paperclip)
- `onModelTap: () -> Void` callback parameter
- `Divider()` at top of bar

### New Layout

Single `HStack` row inside `.padding(.horizontal, 12).padding(.vertical, 8)`:

```
[ + ]  [ text field ············ [↑] ]
```

**`+` button (left):**
- `PhotosPicker` wrapping a button with `Image(systemName: "plus")`
- Shape: circle, `.liquidGlass(in: Circle(), interactive: true)`
- Size: 34×34 pt
- Disabled when `isDisabled`
- Same `onChange(of: photoPickerItem)` logic as before

**Text field (middle):**
- `TextField` with `axis: .vertical`, `lineLimit(1...5)`
- Pill-shaped background: `RoundedRectangle(cornerRadius: 20)` filled with `Color(.systemBackground)`
- Disabled when `isDisabled || isStreaming`
- Placeholder: `isDisabled ? "桌面端离线" : "输入消息..."`

**Send/Cancel button (right, inside text field trailing edge):**
- Positioned via `overlay(alignment: .trailing)` on the text field
- Visible only when `!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isStreaming`
- Not streaming + has text → `arrow.up` in blue circle, calls `onSend()`
- Streaming → `stop.fill` in red circle, calls `onCancel()`
- Button size: 28×28 pt, offset `.trailing` padding of 6 pt inside the field

### Updated ChatDetailView call site

Remove `onModelTap` from the `ChatInputBar(...)` call in `ChatDetailView`.

---

## Out of Scope

- Actual implementation of "邀请成员", "归档 Session", "Session 详情" — placeholders only
- Keyboard return key behavior (SwiftUI default: newline on return for multiline TextField)
