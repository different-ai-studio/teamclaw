import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { ensurePermission, createDispatcher, loadPrefs, authState } = vi.hoisted(() => ({
  ensurePermission: vi.fn(),
  createDispatcher: vi.fn(),
  loadPrefs: vi.fn(),
  authState: { userId: null as string | null },
}));

vi.mock('@/lib/utils', () => ({ isTauri: () => true }));
vi.mock('@/lib/notifications/desktop-notifier', () => ({ ensurePermission }));
vi.mock('@/lib/notifications/message-dispatcher', () => ({ createDispatcher }));
vi.mock('@/lib/notifications/preferences', () => ({
  loadPrefs,
  isInDndWindow: () => false,
  isSessionMuted: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ session: authState.userId ? { user: { id: authState.userId } } : null }),
}));
vi.mock('@/stores/session-list-store', () => ({
  useSessionListStore: { getState: () => ({ rows: [] }) },
}));
vi.mock('@/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ currentSessionId: null }) },
}));
vi.mock('@/stores/actors-store', () => ({
  useActorsStore: { getState: () => ({ get: () => null }) },
}));

import { useDesktopNotifications, getDispatcher } from '../useDesktopNotifications';

describe('useDesktopNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The dispatcher lives at module scope; a signed-out render clears it so
    // state does not leak between tests.
    authState.userId = null;
    renderHook(() => useDesktopNotifications(null));
    authState.userId = 'user-1';
    ensurePermission.mockResolvedValue(true);
    loadPrefs.mockResolvedValue({ enabled: true, dnd_start_min: null, dnd_end_min: null, dnd_tz: 'UTC' });
    createDispatcher.mockImplementation((deps: unknown) => ({ deps, maybeNotify: vi.fn() }));
  });

  it('defers init until the actor id resolves, then builds a dispatcher with it', async () => {
    // App.tsx resolves the actor id asynchronously, so the first render passes null.
    const { rerender } = renderHook(({ actorId }) => useDesktopNotifications(actorId), {
      initialProps: { actorId: null as string | null },
    });
    await waitFor(() => expect(ensurePermission).not.toHaveBeenCalled());
    expect(getDispatcher()).toBeNull();

    rerender({ actorId: 'actor-1' });
    await waitFor(() => expect(getDispatcher()).not.toBeNull());
    expect(createDispatcher.mock.calls[0][0]).toMatchObject({ currentActorId: 'actor-1' });
  });

  it('re-inits when the actor id changes (team switch)', async () => {
    const { rerender } = renderHook(({ actorId }) => useDesktopNotifications(actorId), {
      initialProps: { actorId: 'actor-1' as string | null },
    });
    await waitFor(() => expect(createDispatcher).toHaveBeenCalledTimes(1));

    rerender({ actorId: 'actor-2' });
    await waitFor(() => expect(createDispatcher).toHaveBeenCalledTimes(2));
    expect(createDispatcher.mock.calls[1][0]).toMatchObject({ currentActorId: 'actor-2' });
  });

  it('does not re-init for an unchanged actor id', async () => {
    const { rerender } = renderHook(({ actorId }) => useDesktopNotifications(actorId), {
      initialProps: { actorId: 'actor-1' as string | null },
    });
    await waitFor(() => expect(createDispatcher).toHaveBeenCalledTimes(1));

    rerender({ actorId: 'actor-1' });
    await waitFor(() => expect(createDispatcher).toHaveBeenCalledTimes(1));
  });

  it('installs no dispatcher when the OS denies permission', async () => {
    ensurePermission.mockResolvedValue(false);
    renderHook(() => useDesktopNotifications('actor-1'));
    await waitFor(() => expect(ensurePermission).toHaveBeenCalledTimes(1));
    expect(createDispatcher).not.toHaveBeenCalled();
    expect(getDispatcher()).toBeNull();
  });
});
