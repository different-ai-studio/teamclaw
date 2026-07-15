const DEFAULT_NATIVE_MQTT_URL = "mqtts://ai.ucar.cc:8883";

export function getOptionalMqttUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_MQTT_URL?.trim();
  return url && url.length > 0 ? url : DEFAULT_NATIVE_MQTT_URL;
}
