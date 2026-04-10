# iOS Session Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign ChatDetailView's navigation bar (liquid glass back + `···` menu) and ChatInputBar (iMessage-style single row).

**Architecture:** Two self-contained file edits. `ChatInputBar` is fully rewritten — removes the two-row toolbar layout and adds a liquid glass `+` button and inline send/cancel button. `ChatDetailView` adds a custom back button, replaces the collaborator avatars toolbar item with a `Menu`, and drops `onModelTap` from the input bar call site.

**Tech Stack:** SwiftUI, SwiftData, PhotosUI, iOS 26 `glassEffect` (with iOS 17–25 fallback via existing `liquidGlass()` modifier in `Shared/LiquidGlassBar.swift`)

---

## File Map

| File | Change |
|------|--------|
| `TeamClawMobile/TeamClawMobile/Features/Chat/ChatInputBar.swift` | Full rewrite |
| `TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailView.swift` | Add dismiss env, replace toolbar, remove `onModelTap` call |

---

## Task 1: Rewrite ChatInputBar

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Features/Chat/ChatInputBar.swift`

The existing file has two rows: a toolbar row (gear + paperclip) and an input row. Replace both with a single `HStack` row: liquid glass `+` (PhotosPicker), multi-line TextField, and an inline send/cancel button that appears only when there is text or streaming is active.

- [ ] **Step 1: Replace the file contents**

Open `TeamClawMobile/TeamClawMobile/Features/Chat/ChatInputBar.swift` and replace everything with:

```swift
import PhotosUI
import SwiftUI

struct ChatInputBar: View {
    @Binding var text: String
    let isDisabled: Bool
    let isStreaming: Bool
    let onSend: () -> Void
    let onCancel: () -> Void
    let onImageSelected: (UIImage) -> Void

    @State private var photoPickerItem: PhotosPickerItem?

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            PhotosPicker(
                selection: $photoPickerItem,
                matching: .images
            ) {
                Image(systemName: "plus")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 34, height: 34)
                    .liquidGlass(in: Circle())
            }
            .disabled(isDisabled)
            .onChange(of: photoPickerItem) { _, newItem in
                guard let newItem else { return }
                Task {
                    if let data = try? await newItem.loadTransferable(type: Data.self),
                       let image = UIImage(data: data) {
                        onImageSelected(image)
                    }
                    photoPickerItem = nil
                }
            }

            TextField(
                isDisabled ? "桌面端离线" : "输入消息...",
                text: $text,
                axis: .vertical
            )
            .lineLimit(1...5)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .padding(.trailing, showActionButton ? 40 : 0)
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .disabled(isDisabled || isStreaming)
            .overlay(alignment: .bottomTrailing) {
                if showActionButton {
                    actionButton
                        .padding(.trailing, 6)
                        .padding(.bottom, 5)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    private var showActionButton: Bool {
        isStreaming || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @ViewBuilder
    private var actionButton: some View {
        if isStreaming {
            Button(action: onCancel) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(.red, in: Circle())
            }
        } else {
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(canSend ? Color.blue : Color.secondary, in: Circle())
            }
            .disabled(!canSend)
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isDisabled
    }
}
```

- [ ] **Step 2: Verify the build compiles**

```bash
cd TeamClawMobile && xcodebuild \
  -project TeamClawMobile.xcodeproj \
  -scheme TeamClawMobile \
  -destination 'generic/platform=iOS Simulator' \
  -quiet build 2>&1 | grep -E "error:|BUILD"
```

Expected: `** BUILD SUCCEEDED **` (no `error:` lines)

- [ ] **Step 3: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Chat/ChatInputBar.swift
git commit -m "feat(ios): iMessage-style input bar with liquid glass + button"
```

---

## Task 2: Update ChatDetailView

**Files:**
- Modify: `TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailView.swift`

Four changes in this file:
1. Add `@Environment(\.dismiss) private var dismiss`
2. Add `.navigationBarBackButtonHidden(true)` to the body
3. Replace the existing toolbar block (which conditionally showed collaborator avatars) with two toolbar items: a liquid glass back button (leading) and a `Menu` (trailing)
4. Remove `onModelTap:` from the `ChatInputBar(...)` call

- [ ] **Step 1: Add `dismiss` environment property**

In `ChatDetailView`, after the `@StateObject private var viewModel` line, add:

```swift
@Environment(\.dismiss) private var dismiss
```

The property block should look like:

```swift
@Environment(\.modelContext) private var modelContext
@Environment(\.dismiss) private var dismiss
@StateObject private var viewModel: ChatDetailViewModel
```

- [ ] **Step 2: Add `.navigationBarBackButtonHidden(true)`**

After `.navigationBarTitleDisplayMode(.inline)`, add:

```swift
.navigationBarBackButtonHidden(true)
```

- [ ] **Step 3: Replace the toolbar block**

Find and replace the entire `.toolbar { ... }` block (currently lines 137–143 — the block that conditionally shows `collaboratorAvatars`):

**Remove this:**
```swift
.toolbar {
    if session.isCollaborative && !session.collaboratorIDs.isEmpty {
        ToolbarItem(placement: .navigationBarTrailing) {
            collaboratorAvatars
        }
    }
}
```

**Replace with:**
```swift
.toolbar {
    ToolbarItem(placement: .navigationBarLeading) {
        Button {
            dismiss()
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 17, weight: .medium))
                .frame(width: 36, height: 36)
                .liquidGlass(in: Circle())
        }
    }

    ToolbarItem(placement: .navigationBarTrailing) {
        Menu {
            Button {
                showModelPicker = true
            } label: {
                Label("选择模型", systemImage: "cpu")
            }
            Button { } label: {
                Label("邀请成员", systemImage: "person.badge.plus")
            }
            Button { } label: {
                Label("归档 Session", systemImage: "archivebox")
            }
            ShareLink(item: session.title) {
                Label("分享", systemImage: "square.and.arrow.up")
            }
            Button { } label: {
                Label("Session 详情", systemImage: "info.circle")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .liquidGlass(in: Capsule())
        }
    }
}
```

- [ ] **Step 4: Remove `onModelTap` from the ChatInputBar call**

Find the `ChatInputBar(...)` call and remove the `onModelTap:` line:

**Remove this line** from the call:
```swift
onModelTap: { showModelPicker = true },
```

The updated call should be:
```swift
ChatInputBar(
    text: $viewModel.inputText,
    isDisabled: !viewModel.isDesktopOnline,
    isStreaming: viewModel.isStreaming,
    onSend: { viewModel.sendMessage() },
    onCancel: { viewModel.cancelStreaming() },
    onImageSelected: { image in
        _ = image
    }
)
```

- [ ] **Step 5: Delete the `collaboratorAvatars` computed property**

Remove the entire `// MARK: - Collaborator Avatars` section and the `collaboratorAvatars` computed property (currently lines 157–170).

- [ ] **Step 6: Verify the build compiles**

```bash
cd TeamClawMobile && xcodebuild \
  -project TeamClawMobile.xcodeproj \
  -scheme TeamClawMobile \
  -destination 'generic/platform=iOS Simulator' \
  -quiet build 2>&1 | grep -E "error:|BUILD"
```

Expected: `** BUILD SUCCEEDED **`

- [ ] **Step 7: Commit**

```bash
git add TeamClawMobile/TeamClawMobile/Features/Chat/ChatDetailView.swift
git commit -m "feat(ios): liquid glass back button and ··· session menu"
```
