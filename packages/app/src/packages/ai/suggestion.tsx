import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export function Suggestions({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)} {...props}>
      {children}
    </div>
  )
}

export function Suggestion({
  suggestion,
  onClick,
}: {
  suggestion: string
  onClick?: () => void
}) {
  return (
    <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={onClick}>
      {suggestion}
    </Button>
  )
}
