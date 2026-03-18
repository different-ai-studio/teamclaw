import { useMemo } from 'react'
import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TiptapImage from '@tiptap/extension-image'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { SearchHighlightExtension } from '@/components/editors/TiptapSearchBar'

/**
 * Returns the shared Tiptap extension set used by both Markdown and HTML editors.
 * Callers can append editor-specific extensions via `extraExtensions`.
 */
export function useTiptapExtensions(options?: {
  extraExtensions?: AnyExtension[]
  imageConfig?: { inline?: boolean; allowBase64?: boolean }
}): AnyExtension[] {
  const extraExtensions = options?.extraExtensions
  const imageInline = options?.imageConfig?.inline ?? false
  const imageBase64 = options?.imageConfig?.allowBase64 ?? true

  return useMemo(() => {
    const base: AnyExtension[] = [
      StarterKit,
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'text-primary underline' },
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TiptapImage.configure({ inline: imageInline, allowBase64: imageBase64 }),
      SearchHighlightExtension,
    ]
    return extraExtensions ? [...base, ...extraExtensions] : base
  }, [extraExtensions, imageInline, imageBase64])
}
