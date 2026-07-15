import AsyncStorage from "@react-native-async-storage/async-storage";

import { uuidV4 } from "../../lib/uuid";

const STORAGE_KEY = "teamclaw.expoDeviceId.v1";

type DeviceIdStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export async function getExpoDeviceId(
  storage: DeviceIdStorage = AsyncStorage,
): Promise<string> {
  const existing = await storage.getItem(STORAGE_KEY);
  if (existing?.trim()) return existing;
  const next = `expo-${uuidV4()}`;
  await storage.setItem(STORAGE_KEY, next);
  return next;
}
