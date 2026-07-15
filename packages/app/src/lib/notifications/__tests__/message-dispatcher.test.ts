import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../desktop-notifier', () => ({ notify }));

import { createDispatcher } from '../message-dispatcher';

const baseDeps = () => ({
  currentActorId: 'me',
  isParticipant: vi.fn().mockResolvedValue(true),
  isSessionMuted: vi.fn().mockResolvedValue(false),
  inDnd: () => false,
  isCurrentlyViewing: () => false,
  hasFocus: () => true,
  getActorDisplayName: vi.fn().mockResolvedValue('Alice'),
});

const msg = (over: any = {}) => ({
  id: 'm1', session_id: 's1', sender_actor_id: 'other',
  kind: 'text', content: 'hello', ...over,
});

describe('maybeNotify', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips self-sent', async () => {
    const d = createDispatcher(baseDeps());
    await d.maybeNotify(msg({ sender_actor_id: 'me' }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips kind=system', async () => {
    const d = createDispatcher(baseDeps());
    await d.maybeNotify(msg({ kind: 'system' }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips when not participant', async () => {
    const deps = baseDeps(); deps.isParticipant = vi.fn().mockResolvedValue(false);
    const d = createDispatcher(deps);
    await d.maybeNotify(msg());
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips when muted', async () => {
    const deps = baseDeps(); deps.isSessionMuted = vi.fn().mockResolvedValue(true);
    const d = createDispatcher(deps);
    await d.maybeNotify(msg());
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips when in DnD', async () => {
    const deps = baseDeps(); deps.inDnd = () => true;
    const d = createDispatcher(deps);
    await d.maybeNotify(msg());
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips when currently viewing and focused', async () => {
    const deps = baseDeps(); deps.isCurrentlyViewing = () => true;
    const d = createDispatcher(deps);
    await d.maybeNotify(msg());
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies otherwise', async () => {
    const d = createDispatcher(baseDeps());
    await d.maybeNotify(msg());
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Alice', body: 'hello' });
  });
});
