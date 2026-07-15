import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

export async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === 'granted';
}

export interface NotifyOpts {
  title: string;
  body: string;
}

export async function notify(opts: NotifyOpts): Promise<void> {
  await sendNotification({
    title: opts.title,
    body: truncate(opts.body, 80),
  });
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
