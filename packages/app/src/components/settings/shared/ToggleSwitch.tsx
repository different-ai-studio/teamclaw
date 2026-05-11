import type * as React from 'react'
import { cn } from '@/lib/utils'

export function ToggleSwitch({
  enabled,
  onChange,
  disabled = false,
  className,
  ...buttonProps
}: {
  enabled: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>) {
  return (
    <button
      {...buttonProps}
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={(event) => {
        buttonProps.onClick?.(event)
        if (!event.defaultPrevented && !disabled) {
          onChange(!enabled)
        }
      }}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border/80 shadow-inner transition-colors",
        enabled ? "bg-primary" : "bg-muted",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 transform rounded-full shadow-sm ring-1 ring-black/10 transition-transform dark:ring-white/15",
          enabled
            ? "translate-x-6 bg-primary-foreground"
            : "translate-x-1 bg-white dark:bg-background",
        )}
      />
    </button>
  )
}
