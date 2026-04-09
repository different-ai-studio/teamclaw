import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, opts?: Record<string, unknown>) => {
      if (opts?.count != null && typeof fallback === "string") {
        return fallback.replace("{{count}}", String(opts.count))
      }
      if (opts?.linked != null && opts?.unlinked != null && typeof fallback === "string") {
        return fallback
          .replace("{{roles}}", String(opts.roles))
          .replace("{{skills}}", String(opts.skills))
          .replace("{{linked}}", String(opts.linked))
          .replace("{{unlinked}}", String(opts.unlinked))
      }
      return fallback
    },
  }),
}))

vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ workspacePath: "/workspace" }),
}))

const loadRolesSkillsWorkspaceState = vi.fn()

vi.mock("@/lib/roles/loader", () => ({
  loadRolesSkillsWorkspaceState: (...args: unknown[]) => loadRolesSkillsWorkspaceState(...args),
}))

vi.mock("@/components/settings/shared", () => ({
  SettingCard: ({ children, className }: any) => <div className={className}>{children}</div>,
}))

vi.mock("@/components/settings/RolesSection", () => ({
  RolesSection: ({ onOpenSkill, focusRoleSlug }: any) => (
    <div>
      <div>Roles pane</div>
      {focusRoleSlug ? <div>Focused role: {focusRoleSlug}</div> : null}
      <button onClick={() => onOpenSkill?.("java-complexity-review")}>Open skill</button>
    </div>
  ),
}))

vi.mock("@/components/settings/SkillsSection", () => ({
  SkillsSection: ({ onOpenRole, focusSkillName, roleUsageBySkill }: any) => (
    <div>
      <div>Skills pane</div>
      {focusSkillName ? <div>Focused skill: {focusSkillName}</div> : null}
      <div>Usage keys: {Object.keys(roleUsageBySkill ?? {}).join(",")}</div>
      <button onClick={() => onOpenRole?.("java-sort-reviewer")}>Open role</button>
    </div>
  ),
}))

import { RolesSkillsSection } from "@/components/settings/RolesSkillsSection"

describe("RolesSkillsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadRolesSkillsWorkspaceState.mockResolvedValue({
      roles: [],
      skills: [],
      skillUsageByRole: {
        "java-sort-reviewer": ["java-complexity-review"],
      },
      roleUsageBySkill: {
        "java-complexity-review": ["java-sort-reviewer"],
      },
      metrics: {
        rolesCount: 2,
        skillsCount: 5,
        linkedSkillsCount: 3,
        unlinkedSkillsCount: 2,
      },
    })
  })

  it("renders summary and defaults to roles tab", async () => {
    render(<RolesSkillsSection />)

    expect(screen.getByText("Roles & Skills")).toBeDefined()
    await waitFor(() => {
      expect(screen.getByText("Roles pane")).toBeDefined()
    })
    expect(screen.getByText("2 roles · 5 skills · 3 linked · 2 unlinked")).toBeDefined()
  })

  it("switches to skills tab when a linked skill is opened from roles", async () => {
    render(<RolesSkillsSection />)

    await waitFor(() => {
      expect(screen.getByText("Roles pane")).toBeDefined()
    })

    fireEvent.click(screen.getByText("Open skill"))

    await waitFor(() => {
      expect(screen.getByText("Skills pane")).toBeDefined()
      expect(screen.getByText("Focused skill: java-complexity-review")).toBeDefined()
    })
  })

  it("switches back to roles tab when a linked role is opened from skills", async () => {
    render(<RolesSkillsSection />)

    await waitFor(() => {
      expect(screen.getByText("Roles pane")).toBeDefined()
    })

    await waitFor(() => {
      fireEvent.click(screen.getByText("Open skill"))
    })

    await waitFor(() => {
      expect(screen.getByText("Skills pane")).toBeDefined()
    })

    fireEvent.click(screen.getByText("Open role"))

    await waitFor(() => {
      expect(screen.getByText("Roles pane")).toBeDefined()
      expect(screen.getByText("Focused role: java-sort-reviewer")).toBeDefined()
    })
  })
})
