import * as React from "react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

type Provider = "openai" | "anthropic" | "google" | "azure" | "amazon-bedrock" | string

const providerColors: Record<string, string> = {
  openai: "bg-black text-white",
  anthropic: "bg-[#f97316] text-white",
  google: "bg-[#4285f4] text-white",
  azure: "bg-[#2563eb] text-white",
  "amazon-bedrock": "bg-[#111827] text-white",
  volcengine: "bg-[#3370ff] text-white",
  deepseek: "bg-[#4D6BFE] text-white",
}

export function ModelSelector({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
    </Popover>
  )
}

export function ModelSelectorTrigger({
  asChild = false,
  children,
}: {
  asChild?: boolean
  children: React.ReactNode
}) {
  return <PopoverTrigger asChild={asChild}>{children}</PopoverTrigger>
}

export function ModelSelectorContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent className={cn("w-[360px] p-0", className)} {...props}>
      <Command>{children}</Command>
    </PopoverContent>
  )
}

export function ModelSelectorInput(props: React.ComponentProps<typeof CommandInput>) {
  return <CommandInput {...props} />
}

export function ModelSelectorList(props: React.ComponentProps<typeof CommandList>) {
  return <CommandList {...props} />
}

export function ModelSelectorEmpty(props: React.ComponentProps<typeof CommandEmpty>) {
  return <CommandEmpty {...props} />
}

export function ModelSelectorGroup({
  heading,
  children,
}: {
  heading: string
  children: React.ReactNode
}) {
  return <CommandGroup heading={heading}>{children}</CommandGroup>
}

export function ModelSelectorItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandItem>) {
  return (
    <CommandItem className={cn("gap-2", className)} {...props}>
      {children}
    </CommandItem>
  )
}

export function ModelSelectorLogo({ provider }: { provider: Provider }) {
  const colorClass = providerColors[provider] ?? "bg-muted text-foreground"
  return (
    <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px]", colorClass)}>
      {provider.slice(0, 1).toUpperCase()}
    </span>
  )
}

export function ModelSelectorLogoGroup({
  className,
  children,
}: React.ComponentProps<"div">) {
  return <div className={cn("ml-auto flex items-center gap-1", className)}>{children}</div>
}

export function ModelSelectorName({ children }: React.ComponentProps<"span">) {
  return <span className="text-xs">{children}</span>
}
