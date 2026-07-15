import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notificationsMock = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  listMutedSessionIds: vi.fn(),
}))

vi.mock('@/lib/backend', () => ({
  getBackend: () => ({ notifications: notificationsMock }),
}))

import { DEFAULT_PREFS, isInDndWindow, isSessionMuted, loadPrefs } from '../preferences'

describe('notification preferences helpers', () => {
  beforeEach(() => {
    notificationsMock.loadPreferences.mockReset()
    notificationsMock.listMutedSessionIds.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to default preferences when backend load fails', async () => {
    notificationsMock.loadPreferences.mockRejectedValue(new Error('network down'))

    await expect(loadPrefs('user-1')).resolves.toEqual(DEFAULT_PREFS)
    expect(console.warn).toHaveBeenCalledWith(
      '[notifications] loadPrefs failed, using defaults',
      expect.any(Error),
    )
  })

  it('treats session as unmuted when backend mute lookup fails', async () => {
    notificationsMock.listMutedSessionIds.mockRejectedValue(new Error('network down'))

    await expect(isSessionMuted('user-1', 'session-1')).resolves.toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      '[notifications] isSessionMuted failed, treating as unmuted',
      expect.any(Error),
    )
  })
})

describe('isInDndWindow', () => {
  it('disabled when start is null', () => {
    expect(isInDndWindow({ dnd_start_min: null, dnd_end_min: null, dnd_tz: 'Asia/Shanghai' },
                         new Date())).toBe(false);
  });

  it('cross-midnight 22:00-07:00 Asia/Shanghai', () => {
    const prefs = { dnd_start_min: 1320, dnd_end_min: 420, dnd_tz: 'Asia/Shanghai' };
    expect(isInDndWindow(prefs, new Date('2026-05-17T15:30:00Z'))).toBe(true);
    expect(isInDndWindow(prefs, new Date('2026-05-17T22:30:00Z'))).toBe(true);
    expect(isInDndWindow(prefs, new Date('2026-05-17T04:00:00Z'))).toBe(false);
  });
})
