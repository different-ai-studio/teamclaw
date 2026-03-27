import * as React from "react"

import { appShortName } from "@/lib/build-config"
import { cn } from "@/lib/utils"
import { EditableWithFileChips } from "./editable-with-file-chips"

// Types re-exported from dedicated module
export type { MentionedPerson, PromptInputMessage, PromptInputContextValue } from "./prompt-input-types"
import type { MentionedPerson, PromptInputMessage, PromptInputContextValue } from "./prompt-input-types"

// UI components re-exported from dedicated module
export {
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputAttachment,
} from "./prompt-input-ui"

// Insert hook factories
import {
  useInsertMentionHook,
  useInsertFileMentionHook,
  useInsertSkillMentionHook,
} from "./prompt-input-insert-hooks"

const PromptInputContext = React.createContext<PromptInputContextValue | null>(null)

export function usePromptInputContext() {
  const context = React.useContext(PromptInputContext)
  if (!context) {
    throw new Error("PromptInput components must be used within <PromptInput />")
  }
  return context
}

export function PromptInput({
  className,
  children,
  onSubmit,
  onFilesChange,
  onFilePathsDrop,
  onMentionTrigger,
  onMentionClose,
  onCommandTrigger,
  onCommandClose,
  onHashTrigger,
  onHashClose,
  multiple = false,
  value,
  onValueChange,
  ...props
}: React.ComponentProps<"form"> & {
  onSubmit?: (message: PromptInputMessage) => void
  onFilesChange?: (files: File[]) => void
  onFilePathsDrop?: (paths: string[]) => void
  onMentionTrigger?: (query: string) => void
  onMentionClose?: () => void
  onCommandTrigger?: (query: string) => void
  onCommandClose?: () => void
  onHashTrigger?: (query: string) => void
  onHashClose?: () => void
  multiple?: boolean
  globalDrop?: boolean
  value?: string
  onValueChange?: (value: string) => void
}) {
  const [internalText, setInternalText] = React.useState("")
  const [files, setFilesState] = React.useState<File[]>([])
  const [mentions, setMentions] = React.useState<MentionedPerson[]>([])
  const [isDragging, setIsDragging] = React.useState(false)
  const [textareaRefState, setTextareaRefState] = React.useState<React.RefObject<HTMLDivElement | null>>({ current: null })
  const mentionStartRefState = React.useRef<number | null>(null)
  const commandStartRefState = React.useRef<number | null>(null)
  const text = value ?? internalText
  const setText = React.useCallback(
    (next: string) => {
      if (onValueChange) {
        onValueChange(next)
      } else {
        setInternalText(next)
      }
    },
    [onValueChange]
  )

  // Wrap setFiles - internal state update only
  // onFilesChange should be called separately with delta (new files only)
  const setFiles = React.useCallback((newFiles: File[] | ((prev: File[]) => File[])) => {
    setFilesState(newFiles)
  }, [])

  // Clear files helper - only clears internal state
  // Parent component should handle its own state clearing
  const clearFiles = React.useCallback(() => {
    setFilesState([])
  }, [])

  // Clear mentions helper
  const clearMentions = React.useCallback(() => {
    setMentions([])
  }, [])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    onSubmit?.({ text: text.trim(), files, mentions })
    clearFiles()
    clearMentions()
  }
  
  // Handle drag and drop
  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Only set dragging to false if we're leaving the form element
    if (event.currentTarget === event.target) {
      setIsDragging(false)
    }
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDragging(false)

    // Check for file paths dragged from file tree
    const filePath = event.dataTransfer.getData(`application/x-${appShortName}-filepath`)
    if (filePath) {
      onFilePathsDrop?.([filePath])
      return
    }

    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length > 0) {
      // Determine which files to add
      const filesToAdd = multiple ? droppedFiles : [droppedFiles[0]]

      // Update internal state (append for multiple, replace for single)
      setFiles((prevFiles) => multiple ? [...prevFiles, ...filesToAdd] : filesToAdd)

      // Notify parent with only the NEW files (delta)
      onFilesChange?.(filesToAdd)
    }
  }

  return (
    <PromptInputContext.Provider value={{ 
      text, setText, files, setFiles, clearFiles, 
      mentions, setMentions, clearMentions,
      onSubmit, onFilesChange, onMentionTrigger, onMentionClose, 
      onCommandTrigger, onCommandClose, onHashTrigger, onHashClose,
      multiple,
      textareaRef: textareaRefState, setTextareaRef: setTextareaRefState,
      mentionStartRef: mentionStartRefState,
      commandStartRef: commandStartRefState
    }}>
      <form
        className={cn(
          "relative rounded-2xl border border-border bg-white shadow-sm transition-colors",
          isDragging && "border-primary border-2 bg-primary/5",
          className
        )}
        onSubmit={handleSubmit}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        {...props}
      >
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 pointer-events-none">
            <div className="text-sm font-medium text-primary">
              Drop files here
            </div>
          </div>
        )}
        {children}
      </form>
    </PromptInputContext.Provider>
  )
}

export function PromptInputHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("px-3 pt-3", className)} {...props} />
}

export function PromptInputBody({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("px-4 pt-4", className)} {...props} />
}

export function PromptInputFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-between px-2 pb-2 pt-4", className)}
      {...props}
    />
  )
}

export function PromptInputTextarea({
  className,
  value,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onPaste,
  placeholder,
}: {
  className?: string
  value?: string
  onKeyDown?: (event: React.KeyboardEvent) => void
  onCompositionStart?: (event: React.CompositionEvent) => void
  onCompositionEnd?: (event: React.CompositionEvent) => void
  onPaste?: (event: React.ClipboardEvent) => void
  placeholder?: string
}) {
  const { 
    text, setText, onSubmit, files, setFiles, multiple, clearFiles, onFilesChange,
    mentions, clearMentions,
    onMentionTrigger, onMentionClose,
    onCommandTrigger, onCommandClose, onHashTrigger, onHashClose, setTextareaRef,
    mentionStartRef,
    commandStartRef
  } = usePromptInputContext()
  
  const textareaRef = React.useRef<HTMLDivElement>(null)
  
  // Track IME composition state (for Chinese/Japanese/Korean input)
  const isComposingRef = React.useRef(false)

  // Register editable ref to context
  React.useEffect(() => {
    setTextareaRef(textareaRef)
  }, [setTextareaRef])

  // Track hash (#) state
  const hashStartRef = React.useRef<number | null>(null)

  // Check for @ mention trigger
  const checkMentionTrigger = React.useCallback((newText: string, cursorPos: number) => {
    // Find all @ positions before cursor, excluding those in @{...}
    const textBeforeCursor = newText.slice(0, cursorPos)
    
    // Find the last @ that is NOT part of @{...}
    let lastValidAtIndex = -1
    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      if (textBeforeCursor[i] === '@') {
        // Check if this @ is part of @{...}
        const afterAt = newText.slice(i + 1)
        const isFileMention = afterAt.match(/^\{[^}]*\}/)
        
        if (!isFileMention) {
          // This is a valid @ for triggering
          lastValidAtIndex = i
          break
        }
      }
    }
    
    if (lastValidAtIndex === -1) {
      // No valid @ found, close mention if open
      if (mentionStartRef.current !== null) {
        mentionStartRef.current = null
        onMentionClose?.()
      }
      return
    }
    
    // Check if @ is at start or preceded by whitespace
    const charBefore = lastValidAtIndex > 0 ? newText[lastValidAtIndex - 1] : ' '
    if (!/\s/.test(charBefore) && lastValidAtIndex !== 0) {
      // @ is part of a word, not a trigger
      if (mentionStartRef.current !== null) {
        mentionStartRef.current = null
        onMentionClose?.()
      }
      return
    }
    
    const textAfterAt = newText.slice(lastValidAtIndex + 1, cursorPos)
    
    // Check if there's a space after @, which would close the mention
    if (textAfterAt.includes(' ')) {
      if (mentionStartRef.current !== null) {
        mentionStartRef.current = null
        onMentionClose?.()
      }
      return
    }
    
    // Trigger mention
    mentionStartRef.current = lastValidAtIndex
    const query = textAfterAt
    onMentionTrigger?.(query)
  }, [onMentionTrigger, onMentionClose])

  // Check for / command trigger
  const checkCommandTrigger = React.useCallback((newText: string, cursorPos: number) => {
    // Find all / positions before cursor, excluding those in /{...}
    const textBeforeCursor = newText.slice(0, cursorPos)
    
    // Find the last / that is NOT part of /{...} or /[...]
    let lastValidSlashIndex = -1
    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      if (textBeforeCursor[i] === '/') {
        // Check if this / is part of /{...} (skill) or /[...] (command)
        const afterSlash = newText.slice(i + 1)
        const isSkillMention = afterSlash.match(/^\{[^}]*\}/)
        const isCommandMention = afterSlash.match(/^\[[^\]]*\]/)
        
        if (!isSkillMention && !isCommandMention) {
          // This is a valid / for triggering
          lastValidSlashIndex = i
          break
        }
      }
    }
    
    if (lastValidSlashIndex === -1) {
      // No valid / found, close command if open
      if (commandStartRef.current !== null) {
        commandStartRef.current = null
        onCommandClose?.()
      }
      return
    }
    
    // Check if / is at start or preceded by whitespace or newline
    const charBefore = lastValidSlashIndex > 0 ? newText[lastValidSlashIndex - 1] : ' '
    if (!/\s/.test(charBefore) && lastValidSlashIndex !== 0) {
      // / is part of a word, not a trigger
      if (commandStartRef.current !== null) {
        commandStartRef.current = null
        onCommandClose?.()
      }
      return
    }
    
    // Check if there's a space after /, which would close the command
    const textAfterSlash = newText.slice(lastValidSlashIndex + 1, cursorPos)
    if (textAfterSlash.includes(' ')) {
      if (commandStartRef.current !== null) {
        commandStartRef.current = null
        onCommandClose?.()
      }
      return
    }
    
    // Trigger command
    commandStartRef.current = lastValidSlashIndex
    const query = textAfterSlash
    onCommandTrigger?.(query)
  }, [onCommandTrigger, onCommandClose])

  // Check for # hash trigger
  const checkHashTrigger = React.useCallback((newText: string, cursorPos: number) => {
    const textBeforeCursor = newText.slice(0, cursorPos)
    const lastHashIndex = textBeforeCursor.lastIndexOf('#')
    
    if (lastHashIndex === -1) {
      if (hashStartRef.current !== null) {
        hashStartRef.current = null
        onHashClose?.()
      }
      return
    }
    
    const charBefore = lastHashIndex > 0 ? newText[lastHashIndex - 1] : ' '
    if (!/\s/.test(charBefore) && lastHashIndex !== 0) {
      if (hashStartRef.current !== null) {
        hashStartRef.current = null
        onHashClose?.()
      }
      return
    }
    
    const textAfterHash = newText.slice(lastHashIndex + 1, cursorPos)
    if (textAfterHash.includes(' ')) {
      if (hashStartRef.current !== null) {
        hashStartRef.current = null
        onHashClose?.()
      }
      return
    }
    
    hashStartRef.current = lastHashIndex
    const query = textAfterHash
    onHashTrigger?.(query)
  }, [onHashTrigger, onHashClose])

  // Handle paste events to support pasting images and files
  const handlePaste = (event: React.ClipboardEvent) => {
    onPaste?.(event)

    // Always prevent default to control paste behavior
    event.preventDefault()

    const clipboardData = event.clipboardData
    const pastedFiles = Array.from(clipboardData.files)
    const pastedText = clipboardData.getData('text/plain')

    // Handle file paste
    if (pastedFiles.length > 0) {
      const filesToAdd = multiple ? pastedFiles : [pastedFiles[0]]
      setFiles((prevFiles) => multiple ? [...prevFiles, ...filesToAdd] : filesToAdd)
      onFilesChange?.(filesToAdd)
    }

    // Handle text paste - insert plain text only.
    // If this paste already contains binary files, strip textual attachment tokens
    // to avoid duplicated visual entries like:
    // [Attachment: x.png] (path: /...)
    let textToInsert = pastedText
    if (pastedFiles.length > 0 && textToInsert) {
      textToInsert = textToInsert
        .replace(/\[Attachment:\s*[^\]]+\]\s*\([^)]*\)/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .trimStart()
    }

    if (textToInsert) {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return

      // Delete any selected content first
      selection.deleteFromDocument()

      // Insert plain text at cursor
      const range = selection.getRangeAt(0)
      const textNode = document.createTextNode(textToInsert)
      range.insertNode(textNode)

      // Move cursor to end of inserted text
      range.setStartAfter(textNode)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)

      // Trigger input event to update state
      const inputEvent = new Event('input', { bubbles: true })
      textareaRef.current?.dispatchEvent(inputEvent)
    }
  }
  
  const handleCompositionStart = (event: React.CompositionEvent) => {
    isComposingRef.current = true
    onCompositionStart?.(event)
  }
  
  const handleCompositionEnd = (event: React.CompositionEvent) => {
    isComposingRef.current = false
    onCompositionEnd?.(event)
  }
  
  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Call the original onKeyDown if provided
    onKeyDown?.(event)
    
    // Check if we're in the middle of IME composition (Chinese/Japanese/Korean input)
    // keyCode 229 indicates the key event is being processed by an IME
    // This is the most reliable way to detect IME composition across browsers
    if (event.keyCode === 229) {
      return
    }
    
    // Close mention/command popover on Escape
    if (event.key === 'Escape') {
      if (mentionStartRef.current !== null) {
        event.preventDefault()
        mentionStartRef.current = null
        onMentionClose?.()
        return
      }
      if (commandStartRef.current !== null) {
        event.preventDefault()
        commandStartRef.current = null
        onCommandClose?.()
        return
      }
      if (hashStartRef.current !== null) {
        event.preventDefault()
        hashStartRef.current = null
        onHashClose?.()
        return
      }
    }
    
    // When a popover is open, prevent ArrowUp/Down from moving the textarea cursor
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        (mentionStartRef.current !== null || commandStartRef.current !== null || hashStartRef.current !== null)) {
      event.preventDefault()
      return
    }

    // Note: Backspace handling for @{file} chips is done in EditableWithFileChips component
    
    // Check for Enter key without Shift
    if (event.key === 'Enter' && !event.shiftKey) {
      // Additional IME composition checks for maximum compatibility
      if (isComposingRef.current || event.nativeEvent.isComposing) {
        // Let the IME handle the Enter key (confirm composition)
        return
      }
      
      // If mention, command, or hash popover is open, don't submit (let popover handle it)
      if (mentionStartRef.current !== null || commandStartRef.current !== null || hashStartRef.current !== null) {
        return
      }
      
      // Prevent default newline behavior
      event.preventDefault()
      
      // Submit the form if there's content
      const currentText = String(value ?? text).trim()
      if (currentText || files.length > 0 || mentions.length > 0) {
        onSubmit?.({ text: currentText, files, mentions })
        clearFiles()
        clearMentions()
      }
    }
  }
  
  // Helper to get caret position in contenteditable (accounting for file chips)
  const getCaretPosition = (element: HTMLElement | null): number => {
    if (!element) return 0
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return 0
    
    const range = sel.getRangeAt(0)
    let position = 0
    
    // Walk through the DOM tree and count characters
    const walk = (node: Node, stopNode: Node, stopOffset: number): boolean => {
      if (node === stopNode) {
        if (node.nodeType === Node.TEXT_NODE) {
          position += stopOffset
        }
        return true
      }
      
      if (node.nodeType === Node.TEXT_NODE) {
        position += node.textContent?.length || 0
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement
        
        // File chip: count as @{filepath} length
        if (el.classList.contains("file-chip")) {
          const filepath = el.getAttribute("data-filepath") || ""
          position += `@{${filepath}}`.length
          
          // Check if we need to stop inside the chip
          if (el.contains(stopNode)) {
            // If cursor is inside chip, treat it as being after the chip
            return true
          }
          
          return false
        }
        
        // Skill chip: count as /{skillname} length
        if (el.classList.contains("skill-chip")) {
          const skillname = el.getAttribute("data-skillname") || ""
          position += `/{${skillname}}`.length
          
          // Check if we need to stop inside the chip
          if (el.contains(stopNode)) {
            // If cursor is inside chip, treat it as being after the chip
            return true
          }
          
          return false
        }
        
        // Command chip: count as /[commandname] length
        if (el.classList.contains("command-chip")) {
          const commandname = el.getAttribute("data-commandname") || ""
          position += `/[${commandname}]`.length
          
          // Check if we need to stop inside the chip
          if (el.contains(stopNode)) {
            // If cursor is inside chip, treat it as being after the chip
            return true
          }
          
          return false
        }
        
        // Regular element: walk through children
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i]
          if (child === stopNode && stopNode.nodeType === Node.ELEMENT_NODE) {
            // Cursor is between children
            return true
          }
          
          if (walk(child, stopNode, stopOffset)) {
            return true
          }
        }
      }
      
      return false
    }
    
    walk(element, range.endContainer, range.endOffset)
    return position
  }

  const handleChangeEditable = (newValue: string) => {
    setText(newValue)
    
    // Get cursor position from contenteditable
    const cursorPos = getCaretPosition(textareaRef.current)
    
    // Check for @ mention trigger, / command trigger, or # hash trigger.
    // @ takes precedence: if cursor is inside @filepath (no space between @ and cursor),
    // slashes in the path must NOT trigger the command popover.
    const textBeforeCursor = newValue.slice(0, cursorPos)
    const lastAt = textBeforeCursor.lastIndexOf('@')
    const lastSlash = textBeforeCursor.lastIndexOf('/')
    const lastHash = textBeforeCursor.lastIndexOf('#')

    // Detect if cursor is inside an @mention (file paths may contain /)
    const isInsideAtMention = (() => {
      if (lastAt === -1) return false
      const charBefore = lastAt > 0 ? newValue[lastAt - 1] : ' '
      if (!/\s/.test(charBefore) && lastAt !== 0) return false
      const textAfterAt = newValue.slice(lastAt + 1, cursorPos)
      return !textAfterAt.includes(' ')
    })()

    // If inside @mention, treat the whole thing as a mention regardless of /
    const effectiveLastSlash = isInsideAtMention ? -1 : lastSlash
    const maxIndex = Math.max(lastAt, effectiveLastSlash, lastHash)
    
    if (maxIndex === -1) {
      if (mentionStartRef.current !== null) {
        mentionStartRef.current = null
        onMentionClose?.()
      }
      if (commandStartRef.current !== null) {
        commandStartRef.current = null
        onCommandClose?.()
      }
      if (hashStartRef.current !== null) {
        hashStartRef.current = null
        onHashClose?.()
      }
    } else if (maxIndex === lastHash) {
      checkHashTrigger(newValue, cursorPos)
      if (mentionStartRef.current !== null) {
        mentionStartRef.current = null
        onMentionClose?.()
      }
      if (commandStartRef.current !== null) {
        commandStartRef.current = null
        onCommandClose?.()
      }
    } else if (maxIndex === effectiveLastSlash) {
      checkCommandTrigger(newValue, cursorPos)
      if (mentionStartRef.current !== null) {
        mentionStartRef.current = null
        onMentionClose?.()
      }
      if (hashStartRef.current !== null) {
        hashStartRef.current = null
        onHashClose?.()
      }
    } else if (maxIndex === lastAt) {
      checkMentionTrigger(newValue, cursorPos)
      if (commandStartRef.current !== null) {
        commandStartRef.current = null
        onCommandClose?.()
      }
      if (hashStartRef.current !== null) {
        hashStartRef.current = null
        onHashClose?.()
      }
    }
  }
  
  return (
    <EditableWithFileChips
      ref={textareaRef}
      value={value ?? text}
      onChange={handleChangeEditable}
      onKeyDown={handleKeyDown}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onPaste={handlePaste}
      placeholder={placeholder}
      className={cn(
        "min-h-[36px] max-h-[200px] resize-none border-0 bg-transparent px-0 py-0.5 text-sm leading-normal shadow-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className
      )}
    />
  )
}

// Export a hook to insert mention into text
export function useInsertMention() {
  return useInsertMentionHook(PromptInputContext)
}

// Hook to insert file mention inline as @{filepath}
export function useInsertFileMention() {
  return useInsertFileMentionHook(PromptInputContext)
}

// Hook to insert skill/command mention inline as /{skillname} or /[commandname]
export function useInsertSkillMention() {
  return useInsertSkillMentionHook(PromptInputContext)
}

// Context-dependent UI components created via factory
import { createAttachmentComponents } from "./prompt-input-ui"

const _contextComponents = createAttachmentComponents(usePromptInputContext)
export const PromptInputActionAddAttachments = _contextComponents.PromptInputActionAddAttachments
export const PromptInputAttachments = _contextComponents.PromptInputAttachments
export const PromptInputMentions = _contextComponents.PromptInputMentions
