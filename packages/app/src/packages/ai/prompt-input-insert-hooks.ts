import * as React from "react"
import type { MentionedPerson, PromptInputContextValue } from "./prompt-input-types"

// Shared cursor-positioning helper for contenteditable
// Walks through the DOM tree to find the target position, accounting for file/skill/command chips
function walkToPosition(
  editable: HTMLElement,
  targetPos: number,
): { node: Node; offset: number } | null {
  let currentPos = 0
  let targetNode: Node | null = null
  let targetOffset = 0

  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length || 0
      if (currentPos + len >= targetPos) {
        targetNode = node
        targetOffset = targetPos - currentPos
        return true
      }
      currentPos += len
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement

      // File chip: count as @{filepath} length
      if (el.classList.contains("file-chip")) {
        const filepath = el.getAttribute("data-filepath") || ""
        const chipLength = `@{${filepath}}`.length
        if (currentPos + chipLength >= targetPos) {
          const nextSibling = node.nextSibling
          if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
            targetNode = nextSibling
            targetOffset = 0
          } else {
            targetNode = node.parentNode
            const children = Array.from(node.parentNode?.childNodes || [])
            targetOffset = children.indexOf(node as ChildNode) + 1
          }
          return true
        }
        currentPos += chipLength
        return false
      }

      // Skill chip: count as /{skillname} length
      if (el.classList.contains("skill-chip")) {
        const skillname = el.getAttribute("data-skillname") || ""
        const chipLength = `/{${skillname}}`.length
        if (currentPos + chipLength >= targetPos) {
          const nextSibling = node.nextSibling
          if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
            targetNode = nextSibling
            targetOffset = 0
          } else {
            targetNode = node.parentNode
            const children = Array.from(node.parentNode?.childNodes || [])
            targetOffset = children.indexOf(node as ChildNode) + 1
          }
          return true
        }
        currentPos += chipLength
        return false
      }

      // Command chip: count as /[commandname] length
      if (el.classList.contains("command-chip")) {
        const commandname = el.getAttribute("data-commandname") || ""
        const chipLength = `/[${commandname}]`.length
        if (currentPos + chipLength >= targetPos) {
          const nextSibling = node.nextSibling
          if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
            targetNode = nextSibling
            targetOffset = 0
          } else {
            targetNode = node.parentNode
            const children = Array.from(node.parentNode?.childNodes || [])
            targetOffset = children.indexOf(node as ChildNode) + 1
          }
          return true
        }
        currentPos += chipLength
        return false
      }

      // Regular element: walk through children
      for (let i = 0; i < node.childNodes.length; i++) {
        if (walk(node.childNodes[i])) return true
      }
    }
    return false
  }

  walk(editable)
  return targetNode ? { node: targetNode, offset: targetOffset } : null
}

function setCursorAtPosition(editable: HTMLElement, targetPos: number) {
  try {
    const result = walkToPosition(editable, targetPos)
    if (result) {
      const range = document.createRange()
      const sel = window.getSelection()
      range.setStart(result.node, result.offset)
      range.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  } catch (err) {
    console.warn("Failed to set cursor position:", err)
  }
}

// Internal context access - must be used from the PromptInputContext module
// The context is passed as a parameter to avoid circular imports
export function createInsertMention(context: PromptInputContextValue) {
  const { text, setText, setMentions, onMentionClose, textareaRef, mentionStartRef } = context

  return (person: MentionedPerson) => {
    // Find the last valid @ (not part of @{...})
    let lastValidAtIndex = -1
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '@') {
        const afterAt = text.slice(i + 1)
        const isFileMention = afterAt.match(/^\{[^}]*\}/)
        if (!isFileMention) {
          lastValidAtIndex = i
          break
        }
      }
    }

    if (lastValidAtIndex !== -1) {
      const beforeAt = text.slice(0, lastValidAtIndex)
      const afterAt = text.slice(lastValidAtIndex)
      const queryEndMatch = afterAt.match(/^@[^\s]*/)
      const queryEnd = queryEndMatch ? queryEndMatch[0].length : 1
      const afterQuery = text.slice(lastValidAtIndex + queryEnd).trimStart()

      const mentionText = `@${person.name} `
      const newText = `${beforeAt}${mentionText}${afterQuery}`
      setText(newText)

      const targetPos = beforeAt.length + mentionText.length

      setTimeout(() => {
        const editable = textareaRef.current
        if (editable) {
          editable.focus()
          setCursorAtPosition(editable, targetPos)
        }
      }, 10)
    }

    setMentions(prev => {
      if (prev.some(m => m.id === person.id)) return prev
      return [...prev, person]
    })

    mentionStartRef.current = null
    onMentionClose?.()
  }
}

export function createInsertFileMention(context: PromptInputContextValue) {
  const { text, setText, onMentionClose, textareaRef, mentionStartRef } = context

  return (filePath: string) => {
    let lastValidAtIndex = -1
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '@') {
        const afterAt = text.slice(i + 1)
        const isFileMention = afterAt.match(/^\{[^}]*\}/)
        if (!isFileMention) {
          lastValidAtIndex = i
          break
        }
      }
    }

    if (lastValidAtIndex !== -1) {
      const beforeAt = text.slice(0, lastValidAtIndex)
      const afterAt = text.slice(lastValidAtIndex)
      const queryEndMatch = afterAt.match(/^@[^\s]*/)
      const queryEnd = queryEndMatch ? queryEndMatch[0].length : 1
      const afterQuery = text.slice(lastValidAtIndex + queryEnd)

      const mentionText = `@{${filePath}} `
      const newText = `${beforeAt}${mentionText}${afterQuery}`
      setText(newText)

      setTimeout(() => {
        const editable = textareaRef.current
        if (editable) {
          editable.focus()
          const targetPos = beforeAt.length + mentionText.trimEnd().length
          setCursorAtPosition(editable, targetPos)
        }
      }, 10)
    }

    mentionStartRef.current = null
    onMentionClose?.()
  }
}

export function createInsertSkillMention(context: PromptInputContextValue) {
  const { text, setText, onCommandClose, textareaRef, commandStartRef } = context

  return (skillName: string, type: 'skill' | 'command' = 'skill') => {
    let lastValidSlashIndex = -1
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '/') {
        const afterSlash = text.slice(i + 1)
        const isSkillMention = afterSlash.match(/^\{[^}]*\}/)
        const isCommandMention = afterSlash.match(/^\[[^\]]*\]/)
        if (!isSkillMention && !isCommandMention) {
          lastValidSlashIndex = i
          break
        }
      }
    }

    if (lastValidSlashIndex !== -1) {
      const beforeSlash = text.slice(0, lastValidSlashIndex)
      const afterSlash = text.slice(lastValidSlashIndex)
      const queryEndMatch = afterSlash.match(/^\/[^\s]*/)
      const queryEnd = queryEndMatch ? queryEndMatch[0].length : 1
      const afterQuery = text.slice(lastValidSlashIndex + queryEnd)

      const mentionText = type === 'skill' ? `/{${skillName}} ` : `/[${skillName}] `
      const newText = `${beforeSlash}${mentionText}${afterQuery}`

      setText(newText)

      setTimeout(() => {
        const editable = textareaRef.current
        if (editable) {
          editable.focus()
          const targetPos = beforeSlash.length + mentionText.trimEnd().length
          setCursorAtPosition(editable, targetPos)
        }
      }, 10)
    }

    commandStartRef.current = null
    onCommandClose?.()
  }
}

// React hooks that wrap the factory functions above
export function useInsertMentionHook(PromptInputContext: React.Context<PromptInputContextValue | null>) {
  const context = React.useContext(PromptInputContext)
  if (!context) {
    throw new Error("useInsertMention must be used within <PromptInput />")
  }

  return React.useCallback(
    (person: MentionedPerson) => createInsertMention(context)(person),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.text, context.setText, context.setMentions, context.onMentionClose, context.textareaRef, context.mentionStartRef]
  )
}

export function useInsertFileMentionHook(PromptInputContext: React.Context<PromptInputContextValue | null>) {
  const context = React.useContext(PromptInputContext)
  if (!context) {
    throw new Error("useInsertFileMention must be used within <PromptInput />")
  }

  return React.useCallback(
    (filePath: string) => createInsertFileMention(context)(filePath),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.text, context.setText, context.onMentionClose, context.textareaRef, context.mentionStartRef]
  )
}

export function useInsertSkillMentionHook(PromptInputContext: React.Context<PromptInputContextValue | null>) {
  const context = React.useContext(PromptInputContext)
  if (!context) {
    throw new Error("useInsertSkillMention must be used within <PromptInput />")
  }

  return React.useCallback(
    (skillName: string, type: 'skill' | 'command' = 'skill') => createInsertSkillMention(context)(skillName, type),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.text, context.setText, context.onCommandClose, context.textareaRef, context.commandStartRef]
  )
}
