/** How often to re-probe a local daemon agent that still looks ready via MQTT retain. */
export const LOCAL_AGENT_READY_PROBE_INTERVAL_MS = 20_000

/** Retry interval after a reachability probe fails (connecting/offline/ready paths). */
export const AGENT_REACHABILITY_PROBE_RETRY_MS = 30_000

/** Quick-chat readiness HTTP probe interval when onboarding reports daemon ready. */
export const QUICK_CHAT_DAEMON_PROBE_INTERVAL_MS = 20_000
