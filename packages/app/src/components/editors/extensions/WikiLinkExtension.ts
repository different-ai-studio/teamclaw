import { Node, mergeAttributes } from '@tiptap/core'
import type {
  MarkdownToken,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownTokenizer,
  JSONContent,
  RenderContext,
} from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { parseWikiLinkText, serializeWikiLink } from '@/lib/wiki-link-utils'
import { useKnowledgeStore } from '@/stores/knowledge'
import { useWorkspaceStore } from '@/stores/workspace'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    wikiLink: {
      insertWikiLink: (attrs: {
        target: string
        alias?: string | null
        heading?: string | null
      }) => ReturnType
    }
  }
}

export const WikiLinkExtension = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: { default: '' },
      alias: { default: null },
      heading: { default: null },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-wiki-link]',
        getAttrs: (el) => {
          const element = el as HTMLElement
          return {
            target: element.getAttribute('data-target') || '',
            alias: element.getAttribute('data-alias') || null,
            heading: element.getAttribute('data-heading') || null,
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { target, alias, heading } = node.attrs as {
      target: string
      alias: string | null
      heading: string | null
    }
    const displayText = alias || (heading ? `${target}#${heading}` : target)

    const dataAttrs: Record<string, string> = {
      'data-wiki-link': '',
      'data-target': target,
      class: 'wiki-link',
    }
    if (alias) dataAttrs['data-alias'] = alias
    if (heading) dataAttrs['data-heading'] = heading

    return ['span', mergeAttributes(HTMLAttributes, dataAttrs), displayText]
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      const { target, alias, heading } = node.attrs as {
        target: string
        alias: string | null
        heading: string | null
      }
      const displayText = alias || (heading ? `${target}#${heading}` : target)

      dom.textContent = displayText
      dom.setAttribute('data-wiki-link', '')
      dom.setAttribute('data-target', target)
      if (alias) dom.setAttribute('data-alias', alias)
      if (heading) dom.setAttribute('data-heading', heading)

      const setClass = () => {
        const resolved = useKnowledgeStore.getState().resolveWikiLink(target)
        dom.className = resolved ? 'wiki-link' : 'wiki-link wiki-link--unresolved'
      }
      setClass()

      const unsubscribe = useKnowledgeStore.subscribe(
        (state, prevState) => {
          if (state.wikiFileMap !== prevState.wikiFileMap) setClass()
        },
      )

      return { dom, destroy: () => unsubscribe() }
    }
  },

  addOptions() {
    return {
      suggestion: {
        char: '[[',
        allowSpaces: true,
        items: () => [],
        command: () => {},
        render: () => ({}),
      },
    }
  },

  addCommands() {
    return {
      insertWikiLink:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              target: attrs.target,
              alias: attrs.alias ?? null,
              heading: attrs.heading ?? null,
            },
          })
        },
    }
  },

  // --- Markdown roundtrip via @tiptap/markdown (marked-based) ---

  markdownTokenName: 'wikiLink',

  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => {
      const idx = src.indexOf('[[')
      return idx === -1 ? -1 : idx
    },
    tokenize: (src: string): MarkdownToken | undefined => {
      const match = /^\[\[([^\]\n]+)\]\]/.exec(src)
      if (!match) return undefined

      const raw = match[0]
      const inner = match[1]
      const parts = parseWikiLinkText(inner)

      // Reject empty/whitespace-only targets so marked falls through to literal text
      if (!parts.target) return undefined

      return {
        type: 'wikiLink',
        raw,
        text: inner,
        target: parts.target,
        alias: parts.alias,
        heading: parts.heading,
      }
    },
  } satisfies MarkdownTokenizer,

  parseMarkdown(token: MarkdownToken, _helpers: MarkdownParseHelpers) {
    return {
      type: 'wikiLink',
      attrs: {
        target: (token.target as string) || '',
        alias: (token.alias as string | null) || null,
        heading: (token.heading as string | null) || null,
      },
    }
  },

  renderMarkdown(node: JSONContent, _helpers: MarkdownRendererHelpers, _ctx: RenderContext) {
    const attrs = node.attrs ?? {}
    return serializeWikiLink({
      target: (attrs.target as string) || '',
      alias: (attrs.alias as string | null) || null,
      heading: (attrs.heading as string | null) || null,
    })
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
      new Plugin({
        key: new PluginKey('wikiLinkClick'),
        props: {
          handleClick: (_view, _pos, event) => {
            const rawTarget = event.target
            if (!(rawTarget instanceof Element)) return false

            // The click may land on the span itself or a child text node
            const linkEl = rawTarget.closest('[data-wiki-link]') as HTMLElement | null
            if (!linkEl) return false

            const wikiTarget = linkEl.getAttribute('data-target')
            if (!wikiTarget) return false

            const headingAttr = linkEl.getAttribute('data-heading') || undefined

            const knowledge = useKnowledgeStore.getState()
            const workspace = useWorkspaceStore.getState()
            const workspacePath = workspace.workspacePath
            if (!workspacePath) return false

            const resolved = knowledge.resolveWikiLink(wikiTarget)
            if (resolved) {
              const absolutePath = `${workspacePath}/${resolved}`
              workspace.selectFile(absolutePath, undefined, headingAttr)
            } else {
              // Create a new note from the wiki link target, then open it
              knowledge
                .createNoteFromLink(wikiTarget)
                .then((newPath) => {
                  workspace.selectFile(newPath, undefined, headingAttr)
                })
                .catch((err) => {
                  console.error('[WikiLinkExtension] failed to create note:', err)
                })
            }

            return true
          },
        },
      }),
    ]
  },
})
