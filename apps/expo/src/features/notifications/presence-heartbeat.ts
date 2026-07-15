export type ForegroundPresenceHeartbeat = {
  enterForeground: () => void;
  enterBackground: () => void;
  dispose: () => void;
};

export function createForegroundPresenceHeartbeat({
  deviceId,
  writeForeground,
  now = () => new Date(),
  intervalMs = 20_000,
  leaseMs = 45_000,
}: {
  deviceId: string;
  writeForeground: (deviceId: string, until: Date) => Promise<void>;
  now?: () => Date;
  intervalMs?: number;
  leaseMs?: number;
}): ForegroundPresenceHeartbeat {
  let timer: ReturnType<typeof setInterval> | null = null;

  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };
  const writeLease = (until: Date) => {
    void writeForeground(deviceId, until).catch(() => {
      // Presence is a best-effort foreground hint for push suppression.
    });
  };
  const writeForegroundLease = () => {
    writeLease(new Date(now().getTime() + leaseMs));
  };

  return {
    enterForeground() {
      clear();
      writeForegroundLease();
      timer = setInterval(writeForegroundLease, intervalMs);
    },
    enterBackground() {
      clear();
      writeLease(now());
    },
    dispose() {
      clear();
    },
  };
}
