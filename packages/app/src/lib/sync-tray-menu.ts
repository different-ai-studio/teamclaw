import i18n from '@/lib/i18n'
import { isTauri } from '@/lib/utils'

/** Push current i18n strings into native tray + app menu bar. */
export async function syncTrayMenuLabels(): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('update_tray_menu_labels', {
      showMain: i18n.t('tray.showMain', '打开主窗口'),
      agentSettings: i18n.t('tray.agentSettings', '本地 Agent 设置…'),
      quit: i18n.t('tray.quitAndStopAgent', '退出并停止 Agent'),
    })
    await invoke('update_app_menu_labels', {
      settings: i18n.t('menu.settings', '设置…'),
    })
  } catch {
    // Tray / app menu may be unavailable in web / early boot — ignore.
  }
}
