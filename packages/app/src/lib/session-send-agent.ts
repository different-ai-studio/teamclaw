import { useSessionStore } from "@/stores/session";

/** Send a plain-text agent prompt into the active Cloud session (MQTT/outbox path). */
export async function sendAgentPromptInActiveSession(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  await useSessionStore.getState().sendMessage(trimmed);
}
