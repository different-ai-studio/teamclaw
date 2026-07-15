import type { ConnectionState, TeamMqttClient } from "../../lib/mqtt/team-mqtt";

export type MqttDebugStatus = ConnectionState | "unavailable" | "unconfigured";

export type MqttDebugInput = {
  mqtt: TeamMqttClient | null;
  mqttUrl: string | null;
  observedState: ConnectionState | null;
};

export type MqttDebugPresentation = {
  status: MqttDebugStatus;
  title: string;
  detail: string;
};

export function buildMqttDebugPresentation(
  input: MqttDebugInput,
): MqttDebugPresentation {
  if (!input.mqttUrl) {
    return {
      status: "unconfigured",
      title: "MQTT 未配置",
      detail: "当前环境没有可用的 MQTT URL。",
    };
  }

  if (!input.mqtt) {
    return {
      status: "unavailable",
      title: "MQTT 未启动",
      detail: "当前团队还没有 shared MQTT client。",
    };
  }

  const status = input.observedState ?? "connected";
  switch (status) {
    case "connected":
      return {
        status,
        title: "MQTT 已连接",
        detail: "shared MQTT client 已可用。",
      };
    case "connecting":
      return {
        status,
        title: "MQTT 连接中",
        detail: "正在等待 broker 连接完成。",
      };
    case "disconnected":
    default:
      return {
        status: "disconnected",
        title: "MQTT 已断开",
        detail: "shared MQTT client 收到断开状态。",
      };
  }
}
