import { describe, expect, it } from "vitest";

import { buildMqttDebugPresentation } from "../features/debug/mqtt-debug-state";

describe("buildMqttDebugPresentation", () => {
  it("reports unconfigured when the MQTT URL is missing", () => {
    expect(
      buildMqttDebugPresentation({
        mqtt: null,
        mqttUrl: null,
        observedState: null,
      }),
    ).toMatchObject({
      status: "unconfigured",
      title: "MQTT 未配置",
    });
  });

  it("reports unavailable when no shared client exists", () => {
    expect(
      buildMqttDebugPresentation({
        mqtt: null,
        mqttUrl: "ws://localhost:1884/mqtt",
        observedState: null,
      }),
    ).toMatchObject({
      status: "unavailable",
      title: "MQTT 未启动",
    });
  });

  it("treats an available client as connected until a later event arrives", () => {
    expect(
      buildMqttDebugPresentation({
        mqtt: {} as never,
        mqttUrl: "ws://localhost:1884/mqtt",
        observedState: null,
      }),
    ).toMatchObject({
      status: "connected",
      title: "MQTT 已连接",
    });
  });

  it("uses the observed connection state when present", () => {
    expect(
      buildMqttDebugPresentation({
        mqtt: {} as never,
        mqttUrl: "ws://localhost:1884/mqtt",
        observedState: "disconnected",
      }),
    ).toMatchObject({
      status: "disconnected",
      title: "MQTT 已断开",
    });
  });
});
