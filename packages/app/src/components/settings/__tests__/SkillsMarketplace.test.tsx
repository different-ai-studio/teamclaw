import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

const t = (k: string, d?: string) => d ?? k

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const invoke = vi.fn(async () => ({}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t }),
}))

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ workspacePath: "/workspace" }),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock("@/components/settings/ClawHubMarketplace", () => ({
  ClawHubMarketplace: () => <div>ClawHub shell</div>,
}))

vi.mock("@/lib/utils", () => ({ cn: (...a: string[]) => a.join(" ") }))

import { SkillsMarketplace } from "../SkillsMarketplace"

describe("SkillsMarketplace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).__TAURI__ = {}
    invoke.mockImplementation(async (method: string) => {
      if (method === "fetch_skillssh_leaderboard") {
        return { skills: [], totalInstalls: 0, lastUpdated: 0 }
      }
      if (method === "clawhub_explore") {
        return { items: [], nextCursor: null }
      }
      return {}
    })
  })

  it("switches source immediately and shows skeletons while skills.sh loads", async () => {
    const leaderboard = deferred<{ skills: never[]; totalInstalls: number; lastUpdated: number }>()

    invoke.mockImplementation(async (method: string) => {
      if (method === "fetch_skillssh_leaderboard") {
        return leaderboard.promise
      }
      if (method === "clawhub_explore") {
        return { items: [], nextCursor: null }
      }
      if (method === "clawhub_list_installed") {
        return { skills: {} }
      }
      return {}
    })

    const { container } = render(<SkillsMarketplace />)

    expect(screen.getByText("ClawHub shell")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "skills.sh Marketplace" }))

    expect(screen.queryByText("ClawHub shell")).toBeNull()
    expect(screen.getByText("Install from Source")).toBeTruthy()
    expect(screen.getByPlaceholderText("Search skills...")).toBeTruthy()

    await waitFor(() => {
      expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy()
    })

    await act(async () => {
      leaderboard.resolve({ skills: [], totalInstalls: 0, lastUpdated: 0 })
    })
  })
})
