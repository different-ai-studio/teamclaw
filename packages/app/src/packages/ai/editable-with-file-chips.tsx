import * as React from "react"
import { cn } from "@/lib/utils"

interface EditableWithFileChipsProps {
  value?: string
  onChange?: (value: string) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
  onPaste?: (event: React.ClipboardEvent) => void
  onCompositionStart?: (event: React.CompositionEvent) => void
  onCompositionEnd?: (event: React.CompositionEvent) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
}

export const EditableWithFileChips = React.forwardRef<HTMLDivElement, EditableWithFileChipsProps>(
  ({ value, onChange, onKeyDown, onPaste, onCompositionStart, onCompositionEnd, placeholder, className, disabled, autoFocus }, ref) => {
    const editableRef = React.useRef<HTMLDivElement>(null)
    const isUpdatingRef = React.useRef(false)
    const pendingCursorPositionRef = React.useRef<{ node: Node; offset: number } | null>(null)

    React.useImperativeHandle(ref, () => editableRef.current!)

    // Convert @{filepath}, /{skillname}, and /[commandname] text to HTML with chips
    const valueToHTML = React.useCallback((text: string): string => {
      if (!text) return ""
      
      const parts: string[] = []
      // Match @{filepath}, /{skillname}, and /[commandname]
      const regex = /(@\{([^}]+)\})|(\/{([^}]+)\})|\/(\[([^\]]+)\])/g
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = regex.exec(text)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          const textPart = text.slice(lastIndex, match.index)
          parts.push(escapeHTML(textPart))
        }
        
        if (match[1]) {
          // @{filepath} - file chip (blue)
          const filePath = match[2]
          parts.push(
            `<span class="file-chip inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-md bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-medium whitespace-nowrap" contenteditable="false" data-filepath="${escapeHTML(filePath)}" style="vertical-align: baseline;">` +
            `<svg class="lucide lucide-file-text shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>` +
            `<span class="max-w-[400px] truncate">${escapeHTML(filePath)}</span>` +
            `<span class="chip-remove ml-0.5 cursor-pointer rounded-full hover:bg-blue-200 dark:hover:bg-blue-800 inline-flex items-center justify-center" style="width:14px;height:14px;" data-action="remove">` +
            `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>` +
            `</span>` +
            `</span>`
          )
        } else if (match[3]) {
          // /{skillname} - skill chip (yellow)
          const skillName = match[4]
          parts.push(
            `<span class="skill-chip inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-md bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300 text-xs font-medium whitespace-nowrap" contenteditable="false" data-skillname="${escapeHTML(skillName)}" style="vertical-align: baseline;">` +
            `<svg class="lucide lucide-zap shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>` +
            `<span class="max-w-[400px] truncate">${escapeHTML(skillName)}</span>` +
            `<span class="chip-remove ml-0.5 cursor-pointer rounded-full hover:bg-yellow-200 dark:hover:bg-yellow-800 inline-flex items-center justify-center" style="width:14px;height:14px;" data-action="remove">` +
            `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>` +
            `</span>` +
            `</span>`
          )
        } else if (match[5]) {
          // /[commandname] - command chip (purple)
          const commandName = match[6]
          parts.push(
            `<span class="command-chip inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded-md bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-xs font-medium whitespace-nowrap" contenteditable="false" data-commandname="${escapeHTML(commandName)}" style="vertical-align: baseline;">` +
            `<svg class="lucide lucide-command shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>` +
            `<span class="max-w-[400px] truncate">${escapeHTML(commandName)}</span>` +
            `<span class="chip-remove ml-0.5 cursor-pointer rounded-full hover:bg-purple-200 dark:hover:bg-purple-800 inline-flex items-center justify-center" style="width:14px;height:14px;" data-action="remove">` +
            `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>` +
            `</span>` +
            `</span>`
          )
        }
        
        lastIndex = match.index + match[0].length
      }

      // Add remaining text
      if (lastIndex < text.length) {
        parts.push(escapeHTML(text.slice(lastIndex)))
      }

      return parts.join("")
    }, [])

    // Convert HTML back to @{filepath}, /{skillname}, and /[commandname] text
    const htmlToValue = React.useCallback((element: HTMLElement): string => {
      let result = ""
      
      const traverse = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          result += node.textContent || ""
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement
          if (el.classList.contains("file-chip")) {
            const filepath = el.getAttribute("data-filepath") || ""
            result += `@{${filepath}}`
          } else if (el.classList.contains("skill-chip")) {
            const skillname = el.getAttribute("data-skillname") || ""
            result += `/{${skillname}}`
          } else if (el.classList.contains("command-chip")) {
            const commandname = el.getAttribute("data-commandname") || ""
            result += `/[${commandname}]`
          } else if (el.tagName === "BR") {
            result += "\n"
          } else if (el.tagName === "DIV") {
            // Contenteditable creates divs for new lines
            if (result && !result.endsWith("\n")) {
              result += "\n"
            }
            el.childNodes.forEach(traverse)
          } else {
            el.childNodes.forEach(traverse)
          }
        }
      }

      element.childNodes.forEach(traverse)
      return result
    }, [])

    // Update HTML when value changes
    React.useEffect(() => {
      // Skip if we're in the middle of updating or have pending cursor position
      if (!editableRef.current || isUpdatingRef.current || pendingCursorPositionRef.current) {
        return
      }
      
      const currentText = htmlToValue(editableRef.current)
      
      if (currentText !== (value || "")) {
        const html = valueToHTML(value || "")
        editableRef.current.innerHTML = html || ""
        
        // Restore cursor to end and focus when content was updated externally
        {
          editableRef.current.focus()
          const range = document.createRange()
          const sel = window.getSelection()
          if (editableRef.current.childNodes.length > 0) {
            const lastNode = editableRef.current.childNodes[editableRef.current.childNodes.length - 1]
            range.setStartAfter(lastNode)
            range.collapse(true)
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        }
      }
    }, [value, valueToHTML, htmlToValue])

    const handleInput = React.useCallback(() => {
      if (!editableRef.current) return

      isUpdatingRef.current = true
      const newValue = htmlToValue(editableRef.current)
      onChange?.(newValue)
      
      // Use requestAnimationFrame to ensure cursor is set after all DOM updates
      requestAnimationFrame(() => {
        if (pendingCursorPositionRef.current) {
          const { node, offset } = pendingCursorPositionRef.current
          const range = document.createRange()
          const sel = window.getSelection()
          
          try {
            // Check if node is still in the document
            if (document.contains(node)) {
              range.setStart(node, offset)
              range.collapse(true)
              sel?.removeAllRanges()
              sel?.addRange(range)
            }
          } catch (err) {
            console.warn("Failed to restore cursor:", err)
          }
          
          pendingCursorPositionRef.current = null
        }
        
        isUpdatingRef.current = false
      })
    }, [htmlToValue, onChange])

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      // Delete chip with Backspace
      if (e.key === "Backspace") {
        const sel = window.getSelection()
        
        if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
          const range = sel.getRangeAt(0)
          const container = range.startContainer
          const offset = range.startOffset
          
          let chipToDelete: HTMLElement | null = null
          
          // If cursor is inside a chip (shouldn't happen due to contenteditable="false", but just in case)
          let node = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement
          while (node && node !== editableRef.current) {
            const classes = (node as HTMLElement).classList
            if (classes?.contains("file-chip") || classes?.contains("skill-chip") || classes?.contains("command-chip")) {
              chipToDelete = node as HTMLElement
              break
            }
            node = node.parentElement
          }
          
          // Check if we're right after a chip
          if (!chipToDelete && container.nodeType === Node.ELEMENT_NODE) {
            const element = container as HTMLElement
            
            if (offset > 0) {
              const prevNode = element.childNodes[offset - 1]
              const classes = (prevNode as HTMLElement).classList
              if (prevNode && (classes?.contains("file-chip") || classes?.contains("skill-chip") || classes?.contains("command-chip"))) {
                chipToDelete = prevNode as HTMLElement
              }
            }
          } else if (!chipToDelete && container.nodeType === Node.TEXT_NODE) {
            const textNode = container as Text
            const textContent = textNode.textContent || ""
            
            // Check if we're at the start of a text node, OR if the text before cursor is only whitespace
            if (offset === 0 || textContent.slice(0, offset).trim() === "") {
              // At the start of a text node or only whitespace before cursor, check previous sibling
              const prevSibling = container.previousSibling
              
              if (prevSibling && prevSibling.nodeType === Node.ELEMENT_NODE) {
                const classes = (prevSibling as HTMLElement).classList
                if (classes?.contains("file-chip") || classes?.contains("skill-chip") || classes?.contains("command-chip")) {
                  chipToDelete = prevSibling as HTMLElement
                }
              }
            }
          }
          
          // If we found a chip to delete
          if (chipToDelete) {
            e.preventDefault()
            e.stopPropagation()
            
            // CRITICAL: Record position info BEFORE deleting
            const parent = chipToDelete.parentNode as HTMLElement
            const prevSibling = chipToDelete.previousSibling
            let nextSibling = chipToDelete.nextSibling
            
            // Delete the chip
            chipToDelete.remove()
            
            // Also delete trailing space if the next sibling is a text node starting with space
            if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
              const textContent = nextSibling.textContent || ''
              if (textContent.startsWith(' ')) {
                nextSibling.textContent = textContent.slice(1)
                // If the text node is now empty, remove it
                if (!nextSibling.textContent) {
                  const temp = nextSibling.nextSibling
                  nextSibling.remove()
                  nextSibling = temp
                }
              }
            }
            
            // Determine target cursor position with a robust strategy
            let targetNode: Node | null = null
            let targetOffset = 0
            
            // Strategy 1: If previous sibling is a text node, place cursor at its end
            if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
              targetNode = prevSibling
              targetOffset = prevSibling.textContent?.length || 0
            }
            // Strategy 2: If next sibling is a text node, place cursor at its beginning
            else if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
              targetNode = nextSibling
              targetOffset = 0
            }
            // Strategy 3: Create a new text node where the chip was
            else {
              const textNode = document.createTextNode('')
              
              // Check if nextSibling is an empty BR or empty DIV (contenteditable auto-creates these)
              if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
                const nextEl = nextSibling as HTMLElement
                if (nextEl.tagName === 'BR' || 
                    (nextEl.tagName === 'DIV' && !nextEl.textContent?.trim())) {
                  nextSibling.remove()
                  parent.appendChild(textNode)
                } else {
                  parent.insertBefore(textNode, nextSibling)
                }
              } else if (nextSibling) {
                parent.insertBefore(textNode, nextSibling)
              } else if (prevSibling) {
                if (prevSibling.nextSibling) {
                  parent.insertBefore(textNode, prevSibling.nextSibling)
                } else {
                  parent.appendChild(textNode)
                }
              } else {
                parent.appendChild(textNode)
              }
              
              targetNode = textNode
              targetOffset = 0
            }
            
            // Store cursor position for later restoration
            if (targetNode) {
              pendingCursorPositionRef.current = { node: targetNode, offset: targetOffset }
            }
            
            // Trigger input event to update state (cursor will be set in handleInput via requestAnimationFrame)
            handleInput()
            
            return
          }
        }
      }
      
      onKeyDown?.(e)
    }, [handleInput, onKeyDown])

    React.useEffect(() => {
      if (autoFocus && editableRef.current) {
        editableRef.current.focus()
      }
    }, [autoFocus])

    return (
      <div
        ref={editableRef}
        contentEditable={!disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onClick={(e) => {
          // Handle chip remove button clicks
          const target = e.target as HTMLElement
          const removeBtn = target.closest('[data-action="remove"]')
          if (removeBtn) {
            e.preventDefault()
            const chip = removeBtn.closest('.file-chip, .skill-chip, .command-chip')
            if (chip) {
              chip.remove()
              // Trigger input event to sync value
              handleInput()
            }
          }
        }}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onDrop={(e) => {
          // Prevent contentEditable from handling drops natively (inserting text).
          // Let the event bubble to the parent form's onDrop handler instead.
          e.preventDefault()
        }}
        onDragOver={(e) => {
          e.preventDefault()
        }}
        className={cn(
          "min-h-[36px] max-h-[200px] overflow-y-auto resize-none border-0 bg-transparent px-0 py-0.5 text-sm leading-normal outline-none",
          "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none",
          className
        )}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        style={{
          whiteSpace: "pre-wrap",
          wordWrap: "break-word",
          overflowWrap: "anywhere",
        }}
      />
    )
  }
)

EditableWithFileChips.displayName = "EditableWithFileChips"

function escapeHTML(str: string): string {
  const div = document.createElement("div")
  div.textContent = str
  return div.innerHTML
}
