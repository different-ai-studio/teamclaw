import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface IncomingEnvelope {
  topic: string;
  bytes: Uint8Array;
}

interface RawBatchedEnvelope {
  topic: string;
  b64: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function mqttConnect(args: {
  brokerUrl?: string;
  brokerHost: string;
  brokerPort: number;
  username: string;
  password: string;
  clientId: string;
  teamId: string;
  useTls: boolean;
}): Promise<void> {
  await invoke("mqtt_connect", {
    ...(args.brokerUrl ? { brokerUrl: args.brokerUrl } : {}),
    brokerHost: args.brokerHost,
    brokerPort: args.brokerPort,
    username: args.username,
    password: args.password,
    clientId: args.clientId,
    teamId: args.teamId,
    useTls: args.useTls,
  });
}

export async function mqttSubscribe(topic: string): Promise<void> {
  await invoke("mqtt_subscribe", { topic });
}

export async function mqttUnsubscribe(topic: string): Promise<void> {
  await invoke("mqtt_unsubscribe", { topic });
}

export async function mqttPublish(topic: string, bytes: Uint8Array, retain = false): Promise<void> {
  await invoke("mqtt_publish", {
    topic,
    bytes: Array.from(bytes),
    retain,
  });
}

export async function mqttStatus(): Promise<{ connected: boolean; subscribedTopics: string[] }> {
  return invoke("mqtt_status");
}

/** Local daemon SSE fast-path status (`daemon-live:connected` from Rust). */
export async function listenForDaemonLiveStatus(
  handler: (connected: boolean) => void,
): Promise<UnlistenFn> {
  return listen<boolean>("daemon-live:connected", (msg) => handler(msg.payload));
}

export async function listenForEnvelopes(
  handler: (env: IncomingEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<RawBatchedEnvelope[]>("mqtt:envelopes", (msg) => {
    for (const raw of msg.payload) {
      try {
        handler({ topic: raw.topic, bytes: b64ToBytes(raw.b64) });
      } catch (e) {
        console.warn("[mqtt-bridge] skipping bad envelope b64:", raw.topic, e);
      }
    }
  });
}
