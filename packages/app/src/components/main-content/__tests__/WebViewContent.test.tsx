import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebViewContent } from "../WebViewContent"
import { useTeamMembersStore } from "@/stores/team-members"
import { useTeamModeStore } from "@/stores/team-mode"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  isTauri: () => true,
}))

describe("WebViewContent", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })))
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => {},
    })
    useTeamModeStore.setState({ teamMode: true })
    useTeamMembersStore.setState({ members: [] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("falls back to device hostname when team member name is unavailable", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_set_bounds") return Promise.resolve()
      if (command === "get_device_info") {
        return Promise.resolve({
          nodeId: "node-123",
          platform: "macos",
          arch: "aarch64",
          hostname: "matts-mac",
        })
      }
      if (command === "webview_create") return Promise.resolve()
      if (command === "webview_hide") return Promise.resolve()
      throw new Error(`unexpected command: ${command}`)
    })

    render(<WebViewContent url="https://example.test/device-name" />)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "webview_create",
        expect.objectContaining({
          deviceNo: "node-123",
          deviceName: "matts-mac",
        }),
      )
    })
  })

  it("uses device hostname with the persistent device id outside team mode", async () => {
    useTeamModeStore.setState({ teamMode: false })
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_set_bounds") return Promise.resolve()
      if (command === "get_persistent_device_id") return Promise.resolve("persisted-node")
      if (command === "get_device_hostname") return Promise.resolve("standalone-mac")
      if (command === "webview_create") return Promise.resolve()
      if (command === "webview_hide") return Promise.resolve()
      throw new Error(`unexpected command: ${command}`)
    })

    render(<WebViewContent url="https://example.test/persistent-device-name" />)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "webview_create",
        expect.objectContaining({
          deviceNo: "persisted-node",
          deviceName: "standalone-mac",
        }),
      )
    })
  })
})
