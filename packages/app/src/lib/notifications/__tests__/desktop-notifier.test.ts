import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

import * as plugin from '@tauri-apps/plugin-notification';
import { ensurePermission, notify } from '../desktop-notifier';

describe('desktop-notifier', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when permission is already granted', async () => {
    (plugin.isPermissionGranted as any).mockResolvedValue(true);
    expect(await ensurePermission()).toBe(true);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it('requests permission when not granted', async () => {
    (plugin.isPermissionGranted as any).mockResolvedValue(false);
    (plugin.requestPermission as any).mockResolvedValue('granted');
    expect(await ensurePermission()).toBe(true);
    expect(plugin.requestPermission).toHaveBeenCalledOnce();
  });

  it('notify calls sendNotification with truncated body', async () => {
    await notify({ title: 'Alice', body: 'x'.repeat(200) });
    expect(plugin.sendNotification).toHaveBeenCalledOnce();
    const arg = (plugin.sendNotification as any).mock.calls[0][0];
    expect(arg.title).toBe('Alice');
    expect(arg.body.length).toBeLessThanOrEqual(80);
  });
});
