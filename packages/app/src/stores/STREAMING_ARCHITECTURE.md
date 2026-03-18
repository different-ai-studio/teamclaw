# Streaming Architecture - Anti-Duplication Design

## 🎯 Core Principle: Single Source of Truth

**CRITICAL**: Message content has **ONE** authoritative source depending on lifecycle stage:

```
┌─────────────────────────────────────────────────────────┐
│  STREAMING PHASE           │  COMPLETED PHASE            │
├────────────────────────────┼─────────────────────────────┤
│  streamingContent          │  message.content            │
│  (from delta buffer)       │  (from parts)               │
│                            │                             │
│  Built incrementally       │  Built once from            │
│  from text_delta events    │  final text parts           │
│  via typewriter reveal     │  in handleMessageCompleted  │
└────────────────────────────┴─────────────────────────────┘
```

**NEVER mix these two sources** - mixing causes duplication.

## 🔴 Root Cause of Past Duplication Bugs

### The Problem

```typescript
// ❌ WRONG: Multiple content sources
msg.content = partsSnapshot;  // From message.part.updated
streamingContent += delta;     // From message.part.delta

// On completion:
finalContent = longest(msg.content, streamingContent, event.finalContent);
// → If snapshot and buffer overlap → DUPLICATION!
```

### Why It Happened

1. **Tool call completes** → OpenCode sends `message.part.updated` with full text snapshot
2. **Old code updated `msg.content`** = snapshot content
3. **Meanwhile, delta events arrive** → append to textBuffer
4. **Typewriter appends buffer to `msg.content`** → msg.content = snapshot + buffer remainder
5. **On completion**: Selected "longest" content → **snapshot + buffer = DUPLICATION**

## ✅ Correct Architecture

### Streaming Phase

```typescript
// In handleMessagePartUpdated (text_delta):
appendTextBuffer(delta);  // → textBuffer

// In typewriterTick:
revealedText = streamingContent + chunk;  // Build incrementally
useStreamingStore.setState({ streamingContent: revealedText });
// ❌ DO NOT: msg.content += chunk  (causes duplication!)

// In handleMessagePartCreated (text snapshot):
// ❌ DO NOT: msg.content = parts.join()  (causes duplication!)
// ✅ CORRECT: Only update parts[], leave msg.content alone
```

### Completion Phase

```typescript
// In handleMessageCompleted:
// Build final content ONLY from parts (single source of truth)
const finalContent = message.parts
  .filter(p => p.type === "text")
  .map(p => p.text || p.content)
  .join("");

message.content = finalContent;  // Final write, once
// ❌ DO NOT mix with streamingContent or event.finalContent
```

### Display Phase

```typescript
// In ChatMessage.tsx:
const textContent = isStreaming 
  ? streamingContent    // Streaming: show buffer reveals
  : message.content;    // Completed: show parts content
```

## 📋 Critical Rules

### Rule 1: Streaming Never Writes to msg.content

During streaming (`message.isStreaming === true`):
- ✅ Update `streamingContent` (from delta buffer)
- ✅ Update `message.parts[]` (for reasoning blocks, tool calls)
- ❌ **NEVER** write to `message.content`

### Rule 2: Completion Builds from Parts Only

In `handleMessageCompleted`:
- ✅ Build `message.content` from `message.parts` (authoritative)
- ❌ **NEVER** use `streamingContent` as final content
- ❌ **NEVER** use "longest content" strategy
- ❌ **NEVER** mix multiple content sources

### Rule 3: flushAllPending is Display-Only

`flushAllPending()`:
- ✅ Flush `textBuffer` → `streamingContent` (for display)
- ✅ Flush `reasoningBuffers` → `parts[]` (for thinking blocks)
- ❌ **NEVER** flush to `message.content`
- Purpose: Ensure last few chars appear before completion, prevent visual glitches

### Rule 4: Text Snapshots Don't Update content

In `handleMessagePartCreated` for `type === "text"`:
- ✅ Update `message.parts[]` (new part or replace existing)
- ❌ **NEVER** extract text from parts and write to `message.content`
- Reason: Snapshot may overlap with buffered deltas → duplication

## 🧪 Testing Checklist

When modifying streaming code, verify:

1. **No duplication**:
   - [ ] Send "先执行pwd寻找灵感，然后写200字散文"
   - [ ] Check final message has no repeated paragraphs
   - [ ] Check last sentence appears only once

2. **Typewriter works after tool calls**:
   - [ ] Send "先执行pwd，然后写散文"
   - [ ] Tool completes → AI response has typewriter effect
   - [ ] No sudden flash of full content

3. **Reasoning blocks don't duplicate**:
   - [ ] Long reasoning content streams smoothly
   - [ ] No duplicate thinking process blocks

4. **Auto-scroll works**:
   - [ ] Content near bottom scrolls automatically
   - [ ] No content hidden behind input area

5. **Session switching**:
   - [ ] Switch during streaming → no content loss
   - [ ] Return to session → full content visible

## 📝 Change History

### 2026-03-17: Core Architecture Refactor (Anti-Duplication)

**Problem**: Last paragraph of AI messages duplicated after tool calls.

**Root Cause**: Mixed content sources (parts snapshot + delta buffer) with "longest wins" strategy.

**Solution**: Enforced single source of truth principle:
- Streaming: `streamingContent` (from delta buffer only)
- Completed: `message.content` (from parts only)

**Files Changed**:
- `streaming.ts::typewriterTick` - Only update `streamingContent`, not `msg.content`
- `streaming.ts::flushAllPending` - Flush to `streamingContent`, not `msg.content`
- `session-sse-message-handlers.ts::handleMessagePartCreated` - Don't update `msg.content` for text snapshots
- `session-sse-message-handlers.ts::handleMessageCompleted` - Build `msg.content` from parts only

**Test Coverage**: All 7 message handler tests pass.

**Regression Prevention**: This document + comprehensive tests + clear code comments.

---

**⚠️  IMPORTANT FOR FUTURE DEVELOPERS**:

If you see duplicated content in messages:
1. Check if `msg.content` is being updated during streaming → **BUG**
2. Check if `handleMessageCompleted` mixes multiple content sources → **BUG**
3. Check if typewriter appends to `msg.content` → **BUG**

The only correct flow is:
```
Delta events → textBuffer → typewriter reveal → streamingContent (display)
                                                      ↓
                                              Message completes
                                                      ↓
                                     Parts → build msg.content (final)
```

### 2026-03-17 23:58+: Typewriter Sequencing & Content Preservation

**Problem 1**: Thinking and text reveal simultaneously (mixed typewriter).

**Root Cause**: `typewriterTick` calculates `textChars` and checks `hasReasoningChars` independently, revealing both in same frame.

**Solution**: Priority system - text waits for reasoning:

```typescript
// In typewriterTick:
let hasReasoningChars = false;
for (const buf of reasoningBuffers.values()) {
  if (buf.length > 0) { hasReasoningChars = true; break; }
}

// CRITICAL: Only reveal text when reasoning is fully revealed
const textChars = hasReasoningChars ? 0 : Math.min(CHARS_PER_FRAME, textBuffer.length);
```

**Problem 2**: Opening text chars missing when pending message ID replaced.

**Root Cause**: `setStreaming(newId)` without content parameter resets `streamingContent` to `""`, losing already-revealed text.

**Solution**: Preserve existing content:

```typescript
// In handleMessageCreated (hasPendingMessage branch):
const currentStreamingContent = useStreamingStore.getState().streamingContent;
useStreamingStore.getState().setStreaming(event.id, currentStreamingContent);
```

**Result**: Sequential display (thinking → text), no content loss during ID transitions.
