import * as React from "react"
import { Link2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"

export function Sources({ children }: { children: React.ReactNode }) {
  return <Popover>{children}</Popover>
}

export function SourcesTrigger({ count }: { count: number }) {
  return (
    <PopoverTrigger asChild>
      <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
        <Link2 className="h-3 w-3" />
        Sources ({count})
      </Button>
    </PopoverTrigger>
  )
}

export function SourcesContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent className={cn("w-[360px] space-y-2", className)} {...props}>
      {children}
    </PopoverContent>
  )
}

export function Source({
  href,
  title,
}: {
  href: string
  title: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-md border border-border p-2 text-xs hover:bg-muted"
    >
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1 truncate text-muted-foreground">{href}</div>
    </a>
  )
}
