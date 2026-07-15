import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"

export function Conversation({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)} {...props}>
      {children}
    </div>
  )
}

export function ConversationContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <ScrollArea className={cn("flex-1", className)}>
      <div className="mx-auto w-full max-w-3xl px-6 py-4" {...props}>
        {children}
      </div>
    </ScrollArea>
  )
}

export function ConversationScrollButton({
  className,
  onClick,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <div className="pointer-events-none absolute bottom-4 right-6">
      <Button
        type="button"
        size="icon"
        variant="outline"
        className={cn("pointer-events-auto h-8 w-8 rounded-full", className)}
        onClick={onClick}
        {...props}
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
    </div>
  )
}
