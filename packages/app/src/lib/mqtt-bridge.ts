import { isTauri } from './utils'
import * as tauriBridge from './mqtt-bridge-tauri'
import * as browserBridge from './mqtt-browser-bridge'

export type { IncomingEnvelope } from './mqtt-bridge-tauri'

function impl() {
  return isTauri() ? tauriBridge : browserBridge
}

export const mqttConnect: typeof tauriBridge.mqttConnect = (args) => impl().mqttConnect(args)
export const mqttSubscribe: typeof tauriBridge.mqttSubscribe = (topic) => impl().mqttSubscribe(topic)
export const mqttUnsubscribe: typeof tauriBridge.mqttUnsubscribe = (topic) => impl().mqttUnsubscribe(topic)
export const mqttPublish: typeof tauriBridge.mqttPublish = (topic, bytes, retain) =>
  impl().mqttPublish(topic, bytes, retain)
export const mqttStatus: typeof tauriBridge.mqttStatus = () => impl().mqttStatus()
export const listenForEnvelopes: typeof tauriBridge.listenForEnvelopes = (handler) =>
  impl().listenForEnvelopes(handler)
// Local daemon SSE fast-path status. Tauri-only: the browser bridge has no
// local daemon, so this resolves to a no-op unlisten there.
export const listenForDaemonLiveStatus: typeof tauriBridge.listenForDaemonLiveStatus = (
  handler,
) =>
  isTauri()
    ? tauriBridge.listenForDaemonLiveStatus(handler)
    : Promise.resolve(() => {})
