import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { ReactRenderer } from '@tiptap/react'
import tippy, { type Instance } from 'tippy.js'
import type { SuggestionOptions } from '@tiptap/suggestion'
import type { PageNameEntry } from '@/lib/wiki-link-index'
import { useKnowledgeStore } from '@/stores/knowledge'

// ─── React list component ────────────────────────────────────────────────────

export interface WikiLinkSuggestionProps {
  items: PageNameEntry[]
  command: (item: PageNameEntry) => void
}

export interface WikiLinkSuggestionRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

export const WikiLinkSuggestionList = forwardRef<WikiLinkSuggestionRef, WikiLinkSuggestionProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0)

    useEffect(() => {
      setSelectedIndex(0)
    }, [items])

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((prev) => (prev + items.length - 1) % items.length)
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((prev) => (prev + 1) % items.length)
          return true
        }
        if (event.key === 'Enter') {
          if (items[selectedIndex]) {
            command(items[selectedIndex])
          }
          return true
        }
        return false
      },
    }))

    if (items.length === 0) {
      return (
        <div className="z-50 rounded-md border bg-popover p-2 shadow-md">
          <span className="text-xs text-muted-foreground">No matching pages</span>
        </div>
      )
    }

    return (
      <div className="z-50 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
        {items.map((item, index) => (
          <button
            key={`${item.dir}${item.name}`}
            onClick={() => command(item)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
              index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
            }`}
          >
            <span className="font-medium">{item.name}</span>
            {item.dir && (
              <span className="text-xs text-muted-foreground">{item.dir}</span>
            )}
          </button>
        ))}
      </div>
    )
  },
)

WikiLinkSuggestionList.displayName = 'WikiLinkSuggestionList'

// ─── Suggestion config ────────────────────────────────────────────────────────

export function createWikiLinkSuggestion(): Omit<SuggestionOptions, 'editor'> {
  return {
    char: '[[',
    allowSpaces: true,

    items: ({ query }: { query: string }) => {
      const allPages = useKnowledgeStore.getState().getAllPageNames()
      if (!query) return allPages.slice(0, 20)

      const lower = query.toLowerCase()
      return allPages
        .filter((p) => p.name.toLowerCase().includes(lower))
        .slice(0, 20)
    },

    render: () => {
      let component: ReactRenderer<WikiLinkSuggestionRef, WikiLinkSuggestionProps> | null = null
      let popup: Instance[] | null = null

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(WikiLinkSuggestionList, {
            props: {
              items: props.items as PageNameEntry[],
              command: (item: PageNameEntry) => {
                props.command({ id: item.name, label: item.name })
              },
            },
            editor: props.editor,
          })

          if (!props.clientRect) return

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
          })
        },

        onUpdate: (props: any) => {
          component?.updateProps({
            items: props.items as PageNameEntry[],
            command: (item: PageNameEntry) => {
              props.command({ id: item.name, label: item.name })
            },
          })

          if (popup?.[0] && props.clientRect) {
            popup[0].setProps({
              getReferenceClientRect: props.clientRect as () => DOMRect,
            })
          }
        },

        onKeyDown: (props: any) => {
          if (props.event.key === 'Escape') {
            popup?.[0]?.hide()
            return true
          }
          return component?.ref?.onKeyDown(props) ?? false
        },

        onExit: () => {
          popup?.[0]?.destroy()
          component?.destroy()
        },
      }
    },

    command: ({ editor, range, props }: { editor: any; range: any; props: any }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertWikiLink({ target: props.id as string })
        .run()
    },
  }
}
