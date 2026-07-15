import type { Message } from "@/stores/session";

function compare(a: Message, b: Message): number {
  const ta = a.timestamp?.getTime?.() ?? 0;
  const tb = b.timestamp?.getTime?.() ?? 0;
  if (ta !== tb) return ta - tb;
  return (a.id || "").localeCompare(b.id || "");
}

export function insertMessageSorted(
  messages: Message[],
  newMessage: Message
): Message[] {
  // CRITICAL: Check for duplicate message ID before inserting
  // This prevents creating duplicate messages when retry scenarios cause
  // message.updated to be sent multiple times for the same messageId
  const existingIndex = messages.findIndex((m) => m.id === newMessage.id);
  if (existingIndex !== -1) {
    console.warn('[insertMessageSorted] Message already exists, skipping insert:', {
      messageId: newMessage.id,
      role: newMessage.role,
    });
    return messages;
  }
  
  if (messages.length === 0) return [newMessage];
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(messages[mid], newMessage) < 0) lo = mid + 1;
    else hi = mid;
  }
  return [...messages.slice(0, lo), newMessage, ...messages.slice(lo)];
}
