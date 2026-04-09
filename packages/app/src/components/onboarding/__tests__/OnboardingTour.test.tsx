import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { appShortName } from "@/lib/build-config"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ""
})

import { OnboardingTour } from "../OnboardingTour"

describe("OnboardingTour", () => {
  it("renders the first step when enabled", async () => {
    const target = document.createElement("div")
    target.setAttribute("data-onboarding-id", "target")
    target.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 100,
        width: 200,
        height: 80,
        bottom: 180,
        right: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect
    document.body.appendChild(target)

    render(
      <OnboardingTour
        id="main-workspace"
        enabled
        steps={[
          {
            target: '[data-onboarding-id="target"]',
            title: "First step",
            description: "Explain the page",
          },
        ]}
      />,
    )

    expect(await screen.findByText("First step")).toBeTruthy()
    expect(screen.getByText("Explain the page")).toBeTruthy()
    expect(screen.getByTestId("onboarding-tour-card").className).toContain("no-drag")
  })

  it("marks the tour as completed when done", async () => {
    const target = document.createElement("div")
    target.setAttribute("data-onboarding-id", "target")
    target.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 100,
        width: 200,
        height: 80,
        bottom: 180,
        right: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect
    document.body.appendChild(target)

    render(
      <OnboardingTour
        id="main-workspace"
        enabled
        steps={[
          {
            target: '[data-onboarding-id="target"]',
            title: "First step",
            description: "Explain the page",
          },
        ]}
      />,
    )

    fireEvent.click(await screen.findByText("Done"))

    expect(localStorage.getItem(`${appShortName}-onboarding-main-workspace`)).toBe("done")
  })

  it("does not reopen after completion", () => {
    localStorage.setItem(`${appShortName}-onboarding-main-workspace`, "done")

    const target = document.createElement("div")
    target.setAttribute("data-onboarding-id", "target")
    target.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 100,
        width: 200,
        height: 80,
        bottom: 180,
        right: 300,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect
    document.body.appendChild(target)

    render(
      <OnboardingTour
        id="main-workspace"
        enabled
        steps={[
          {
            target: '[data-onboarding-id="target"]',
            title: "First step",
            description: "Explain the page",
          },
        ]}
      />,
    )

    expect(screen.queryByText("First step")).toBeNull()
  })
})
