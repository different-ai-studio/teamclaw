import * as React from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { markOnboardingCompleted, hasCompletedOnboarding } from "@/lib/onboarding"

export interface OnboardingStep {
  target: string
  title: string
  description: string
}

interface OnboardingTourProps {
  id: string
  steps: OnboardingStep[]
  enabled: boolean
  onFinish?: () => void
}

type SpotlightRect = {
  top: number
  left: number
  width: number
  height: number
}

const PADDING = 4

function getSpotlightRect(selector: string): SpotlightRect | null {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) return null

  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  return {
    top: Math.max(8, rect.top - PADDING),
    left: Math.max(8, rect.left - PADDING),
    width: rect.width + PADDING * 2,
    height: rect.height + PADDING * 2,
  }
}

export function OnboardingTour({ id, steps, enabled, onFinish }: OnboardingTourProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)
  const [stepIndex, setStepIndex] = React.useState(0)
  const [rect, setRect] = React.useState<SpotlightRect | null>(null)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (!enabled || steps.length === 0 || hasCompletedOnboarding(id)) return
    setIsOpen(true)
    setStepIndex(0)
  }, [enabled, id, steps.length])

  const finish = React.useCallback(() => {
    markOnboardingCompleted(id)
    setIsOpen(false)
    onFinish?.()
  }, [id, onFinish])

  React.useEffect(() => {
    if (!isOpen) return

    const step = steps[stepIndex]
    if (!step) return

    const updateRect = () => {
      const nextRect = getSpotlightRect(step.target)
      setRect(nextRect)
    }

    const target = document.querySelector<HTMLElement>(step.target)
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ block: "nearest", inline: "nearest" })
    }
    updateRect()

    window.addEventListener("resize", updateRect)
    window.addEventListener("scroll", updateRect, true)

    return () => {
      window.removeEventListener("resize", updateRect)
      window.removeEventListener("scroll", updateRect, true)
    }
  }, [isOpen, stepIndex, steps])

  React.useEffect(() => {
    if (!isOpen || rect) return
    const timer = window.setTimeout(() => {
      const step = steps[stepIndex]
      if (!step) return
      const fallbackRect = getSpotlightRect(step.target)
      if (fallbackRect) {
        setRect(fallbackRect)
        return
      }
      if (stepIndex >= steps.length - 1) {
        finish()
      } else {
        setStepIndex((current) => current + 1)
      }
    }, 150)

    return () => window.clearTimeout(timer)
  }, [finish, isOpen, rect, stepIndex, steps])

  if (!mounted || !isOpen || !rect) return null

  const step = steps[stepIndex]
  if (!step) return null

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const cardWidth = Math.min(360, viewportWidth - 32)
  const roomOnRight = viewportWidth - (rect.left + rect.width)
  const roomBelow = viewportHeight - (rect.top + rect.height)

  let cardLeft = rect.left
  let cardTop = rect.top + rect.height + 16

  if (roomOnRight > cardWidth + 24) {
    cardLeft = rect.left + rect.width + 16
    cardTop = rect.top
  } else if (roomBelow < 180) {
    cardTop = Math.max(16, rect.top - 180)
  }

  cardLeft = Math.min(Math.max(16, cardLeft), viewportWidth - cardWidth - 16)
  cardTop = Math.min(Math.max(16, cardTop), viewportHeight - 180)

  return createPortal(
    <div
      data-testid="onboarding-tour-overlay"
      className="fixed inset-0 z-[300] no-drag"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <div className="absolute inset-0 bg-black/55" />
      <div
        className="absolute rounded-[20px] border border-white/70 bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-all duration-200 pointer-events-none"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        }}
      />

      <div
        data-testid="onboarding-tour-card"
        className="absolute w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-border bg-background p-4 shadow-2xl no-drag"
        style={{ top: cardTop, left: cardLeft, WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          {stepIndex + 1} / {steps.length}
        </div>
        <h3 className="text-base font-semibold">{step.title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{step.description}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={finish}>
            {t("onboarding.common.skip", "Skip")}
          </Button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
              >
                {t("onboarding.common.back", "Back")}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                if (stepIndex >= steps.length - 1) {
                  finish()
                } else {
                  setStepIndex((current) => current + 1)
                }
              }}
            >
              {stepIndex >= steps.length - 1
                ? t("onboarding.common.done", "Done")
                : t("onboarding.common.next", "Next")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
