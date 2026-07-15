// Telemetry-only per-install id. NOT a routing identity (routing uses actor_id).
// Lets two desktop installs of the same actor appear as separate version rows.
const KEY = "teamclaw.client-version.device-id";

export function getDesktopDeviceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return "desktop-unknown";
  }
}
