import * as React from "react"
import { Paperclip, Plus, Send, Square, User } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import type { PromptInputContextValue } from "./prompt-input-types"

export function PromptInputTools({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-1", className)} {...props} />
}

export function PromptInputButton({
  className,
  variant = "ghost",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant={variant}
      size="sm"
      className={cn("h-8 gap-2 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export function PromptInputSubmit({
  className,
  status = "ready",
  disabled,
  onStop,
  ...props
}: React.ComponentProps<typeof Button> & {
  status?: "submitted" | "streaming" | "ready" | "error"
  onStop?: () => void
}) {
  const showStop = status === "streaming"

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (showStop && onStop) {
      e.preventDefault()
      onStop()
    }
  }

  return (
    <Button
      type={showStop ? "button" : "submit"}
      variant="outline"
      size="icon"
      disabled={showStop ? false : disabled}
      className={cn("h-8 w-8", showStop && "text-red-500 hover:text-red-600 hover:bg-red-50", className)}
      onClick={handleClick}
      {...props}
    >
      {showStop ? <Square className="h-3.5 w-3.5 fill-current" /> : <Send className="h-3.5 w-3.5" />}
    </Button>
  )
}

export function PromptInputActionMenu({ children }: React.ComponentProps<"div">) {
  return <DropdownMenu>{children}</DropdownMenu>
}

export function PromptInputActionMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-8 w-8 text-muted-foreground", className)}
        {...props}
      >
        <Plus className="h-4 w-4" />
        <span className="sr-only">Actions</span>
      </Button>
    </DropdownMenuTrigger>
  )
}

export function PromptInputActionMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return <DropdownMenuContent className={className} {...props} />
}

// Factory function that creates attachment-related components bound to a context
export function createAttachmentComponents(useContext: () => PromptInputContextValue) {
  function PromptInputActionAddAttachments() {
    const { setFiles, onFilesChange, multiple } = useContext()
    const inputRef = React.useRef<HTMLInputElement>(null)

    return (
      <>
        <DropdownMenuItem onClick={() => inputRef.current?.click()}>
          <Paperclip className="mr-2 h-4 w-4" />
          Add attachments
        </DropdownMenuItem>
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          className="hidden"
          onChange={(event) => {
            const selectedFiles = Array.from(event.target.files ?? [])
            if (selectedFiles.length > 0) {
              const filesToAdd = multiple ? selectedFiles : [selectedFiles[0]]
              setFiles((prevFiles) => multiple ? [...prevFiles, ...filesToAdd] : filesToAdd)
              onFilesChange?.(filesToAdd)
            }
            event.target.value = ''
          }}
        />
      </>
    )
  }

  function PromptInputAttachments({
    className,
    children,
    ...props
  }: React.ComponentProps<"div"> & {
    children: (attachment: File) => React.ReactNode
  }) {
    const { files } = useContext()
    if (files.length === 0) return null
    return (
      <div className={cn("flex flex-wrap gap-2", className)} {...props}>
        {files.map((file) => (
          <React.Fragment key={file.name}>{children(file)}</React.Fragment>
        ))}
      </div>
    )
  }

  function PromptInputMentions({
    className,
    ...props
  }: React.ComponentProps<"div">) {
    const { mentions, setMentions } = useContext()

    if (mentions.length === 0) return null

    const removeMention = (id: string) => {
      setMentions(prev => prev.filter(m => m.id !== id))
    }

    return (
      <div className={cn("flex flex-wrap gap-1.5 px-3 pb-2", className)} {...props}>
        {mentions.map((person) => (
          <span
            key={person.id}
            className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-700 rounded-md text-xs"
          >
            <User className="h-3 w-3" />
            <span className="truncate max-w-[150px]">{person.name}</span>
            <button
              type="button"
              onClick={() => removeMention(person.id)}
              className="ml-0.5 hover:text-purple-900 text-purple-500"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    )
  }

  return {
    PromptInputActionAddAttachments,
    PromptInputAttachments,
    PromptInputMentions,
  }
}

export function PromptInputAttachment({
  data,
  className,
  ...props
}: React.ComponentProps<"div"> & { data: File }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-lg bg-muted px-2 py-1 text-xs", className)} {...props}>
      <span className="truncate">{data.name}</span>
      <Badge variant="outline" className="text-[10px]">
        {Math.round(data.size / 1024)} KB
      </Badge>
    </div>
  )
}
