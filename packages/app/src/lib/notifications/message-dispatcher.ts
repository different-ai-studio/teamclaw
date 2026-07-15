import { notify } from './desktop-notifier';

export interface IncomingMessage {
  id: string;
  session_id: string;
  sender_actor_id: string;
  kind: 'text' | 'system' | 'idea_event' | 'agent_reply' | string;
  content: string;
}

export interface DispatcherDeps {
  currentActorId: string | null | undefined;
  isParticipant: (sessionId: string) => Promise<boolean>;
  isSessionMuted: (sessionId: string) => Promise<boolean>;
  inDnd: () => boolean;
  isCurrentlyViewing: (sessionId: string) => boolean;
  hasFocus: () => boolean;
  getActorDisplayName: (actorId: string) => Promise<string>;
}

export interface Dispatcher {
  maybeNotify(msg: IncomingMessage): Promise<void>;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return {
    async maybeNotify(msg) {
      if (msg.kind === 'system') return;
      if (!deps.currentActorId || msg.sender_actor_id === deps.currentActorId) return;
      if (!await deps.isParticipant(msg.session_id)) return;
      if (await deps.isSessionMuted(msg.session_id)) return;
      if (deps.inDnd()) return;
      if (deps.isCurrentlyViewing(msg.session_id) && deps.hasFocus()) return;

      const title = await deps.getActorDisplayName(msg.sender_actor_id);
      await notify({ title, body: msg.content });
    },
  };
}
