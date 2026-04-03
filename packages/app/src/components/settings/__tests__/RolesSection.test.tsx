import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => d ?? k, i18n: { language: "en", changeLanguage: vi.fn() } }),
}))

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: vi.fn((sel: (s: any) => any) => sel({ workspacePath: null })),
}))

vi.mock("@/lib/utils", () => ({ cn: (...a: string[]) => a.join(" "), isTauri: () => false }))

vi.mock("../shared", () => ({
  SettingCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}))

import { RolesSection } from "../RolesSection"

describe("RolesSection", () => {
  it("renders the Roles title", () => {
    render(<RolesSection />)
    expect(screen.getByText("Roles")).toBeTruthy()
  })

  it("shows workspace selection prompt when no workspace", () => {
    render(<RolesSection />)
    expect(screen.getByText("Please select a workspace directory first")).toBeTruthy()
  })
})
