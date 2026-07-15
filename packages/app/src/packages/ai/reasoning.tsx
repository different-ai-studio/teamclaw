import * as React from "react"
import { Brain } from "lucide-react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"

export function Reasoning({
  children,
}: {
  children: React.ReactNode
  duration?: number
}) {
  return <Popover>{children}</Popover>
}

export function ReasoningTrigger() {
  return (
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
        <Brain className="h-3 w-3" />
        Reasoning
      </Button>
    </PopoverTrigger>
  )
}

export function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent className={cn("w-[360px] text-xs text-muted-foreground", className)} {...props}>
      {children}
    </PopoverContent>
  )
}
