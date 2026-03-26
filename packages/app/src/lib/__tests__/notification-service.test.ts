import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue('granted'),
}))

vi.mock('@/lib/permission-policy', () => ({
  getPermissionPolicy: vi.fn(() => 'default'),
}))

// Mock localStorage
const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: vi.fn((k: string) => store[k] ?? null),
  setItem: vi.fn((k: string, v: string) => { store[k] = v }),
  removeItem: vi.fn((k: string) => { delete store[k] }),
})

// Mock Notification constructor
const mockNotification = { onclick: null as any }
vi.stubGlobal('Notification', vi.fn(() => mockNotification))

import { notificationService } from '@/lib/notification-service'
import { appShortName } from '@/lib/build-config'

describe('notification-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.keys(store).forEach(k => delete store[k])
    // Reset window visibility to allow notifications in tests
    notificationService.isWindowVisible = false
    // Reset the internal throttle map by waiting or creating new instance
    // The singleton is already imported, so we just ensure clean state
  })

  it('getLevel returns default "important" when nothing stored', () => {
    expect(notificationService.getLevel()).toBe('important')
  })

  it('setLevel persists to localStorage', () => {
    notificationService.setLevel('all')
    expect(store[`${appShortName}-notification-level`]).toBe('all')
  })

  it('getLevel reads from localStorage', () => {
    store[`${appShortName}-notification-level`] = 'mute'
    expect(notificationService.getLevel()).toBe('mute')
  })

  it('send does not create notification when level is mute', async () => {
    store[`${appShortName}-notification-level`] = 'mute'
    await notificationService.send('task_completed', 'Test', 'body', 'sess-1')
    expect(Notification).not.toHaveBeenCalled()
  })

  it('send creates notification when level allows', async () => {
    store[`${appShortName}-notification-level`] = 'all'
    await notificationService.send('info', 'Test Title', 'Test Body', 'sess-2')
    expect(Notification).toHaveBeenCalledWith('Test Title', { body: 'Test Body', silent: false })
  })

  it('send creates notification for action_required at important level', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    await notificationService.send('action_required', 'Auth Required', 'Please approve', 'sess-3')
    expect(Notification).toHaveBeenCalledWith('Auth Required', { body: 'Please approve', silent: false })
  })

  it('send creates notification for task_completed at important level', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    await notificationService.send('task_completed', 'Task Done', 'Completed successfully', 'sess-4')
    expect(Notification).toHaveBeenCalledWith('Task Done', { body: 'Completed successfully', silent: false })
  })

  it('send does not create notification for info at important level', async () => {
    store[`${appShortName}-notification-level`] = 'important'
    await notificationService.send('info', 'FYI', 'Just letting you know', 'sess-5')
    expect(Notification).not.toHaveBeenCalled()
  })

  it('invokes onClick callback when notification is clicked', async () => {
    store[`${appShortName}-notification-level`] = 'all'
    const onClick = vi.fn()
    await notificationService.send('info', 'Click Me', 'body', 'sess-6', onClick)
    expect(Notification).toHaveBeenCalled()
    // Simulate click
    expect(mockNotification.onclick).toBeTruthy()
    mockNotification.onclick()
    expect(onClick).toHaveBeenCalled()
  })

  it('suppresses notification when window is visible', async () => {
    store[`${appShortName}-notification-level`] = 'all'
    // Set window as visible
    notificationService.isWindowVisible = true
    await notificationService.send('task_completed', 'Task Done', 'Completed', 'sess-7')
    expect(Notification).not.toHaveBeenCalled()
  })

  it('sends notification when window is not visible', async () => {
    store[`${appShortName}-notification-level`] = 'all'
    // Set window as not visible
    notificationService.isWindowVisible = false
    await notificationService.send('task_completed', 'Task Done', 'Completed', 'sess-8')
    expect(Notification).toHaveBeenCalledWith('Task Done', { body: 'Completed', silent: false })
  })
})
