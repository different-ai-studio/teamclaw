import { mqttSubscribe, mqttUnsubscribe } from "@/lib/mqtt-bridge";

export const subscribedSessionTopics = new Set<string>();

const subscribedTeamSessionTopics = new Set<string>();
const pendingSessionSubscriptions = new Map<string, Promise<void>>();
const pendingTeamSessionSubscriptions = new Map<string, Promise<void>>();
let subscriptionEpoch = 0;

function teamSessionLiveTopic(teamId: string): string {
  return `amux/${teamId}/session/+/live`;
}

function sessionLiveTopic(teamId: string, sessionId: string): string {
  return `amux/${teamId}/session/${sessionId}/live`;
}

function isSessionLiveTopicForTeam(topic: string, teamId: string): boolean {
  return topic.startsWith(`amux/${teamId}/session/`) && topic.endsWith("/live");
}

export function hasTeamSessionLiveSubscription(teamId: string): boolean {
  return subscribedTeamSessionTopics.has(teamSessionLiveTopic(teamId));
}

export async function ensureTeamSessionLiveSubscribed(teamId: string): Promise<void> {
  const topic = teamSessionLiveTopic(teamId);
  while (true) {
    if (subscribedTeamSessionTopics.has(topic)) return;
    const pending = pendingTeamSessionSubscriptions.get(topic);
    if (pending) {
      await pending;
      continue;
    }

    const epoch = subscriptionEpoch;
    const subscription = mqttSubscribe(topic);
    pendingTeamSessionSubscriptions.set(topic, subscription);
    try {
      await subscription;
    } finally {
      if (pendingTeamSessionSubscriptions.get(topic) === subscription) {
        pendingTeamSessionSubscriptions.delete(topic);
      }
    }
    if (subscriptionEpoch === epoch) {
      subscribedTeamSessionTopics.add(topic);
      const overlapping = [...subscribedSessionTopics].filter((sessionTopic) =>
        isSessionLiveTopicForTeam(sessionTopic, teamId),
      );
      await Promise.all(
        overlapping.map(async (sessionTopic) => {
          try {
            await mqttUnsubscribe(sessionTopic);
          } catch (error) {
            console.warn("[MQTT] unsubscribe overlapping session/live topic failed", {
              topic: sessionTopic,
              error,
            });
          } finally {
            subscribedSessionTopics.delete(sessionTopic);
          }
        }),
      );
      return;
    }
  }
}

export async function ensureSessionLiveSubscribed(
  teamId: string,
  sessionId: string,
): Promise<void> {
  if (hasTeamSessionLiveSubscription(teamId)) return;

  const topic = sessionLiveTopic(teamId, sessionId);
  while (true) {
    if (hasTeamSessionLiveSubscription(teamId)) return;
    if (subscribedSessionTopics.has(topic)) return;
    const pending = pendingSessionSubscriptions.get(topic);
    if (pending) {
      await pending;
      continue;
    }

    const epoch = subscriptionEpoch;
    const subscription = mqttSubscribe(topic);
    pendingSessionSubscriptions.set(topic, subscription);
    try {
      await subscription;
    } finally {
      if (pendingSessionSubscriptions.get(topic) === subscription) {
        pendingSessionSubscriptions.delete(topic);
      }
    }
    if (subscriptionEpoch === epoch) {
      subscribedSessionTopics.add(topic);
      return;
    }
  }
}

export function resetSessionLiveSubscriptionState(): void {
  subscriptionEpoch += 1;
  subscribedSessionTopics.clear();
  subscribedTeamSessionTopics.clear();
  pendingSessionSubscriptions.clear();
  pendingTeamSessionSubscriptions.clear();
}

export const resetSessionLiveSubscriptionStateForTests = resetSessionLiveSubscriptionState;
