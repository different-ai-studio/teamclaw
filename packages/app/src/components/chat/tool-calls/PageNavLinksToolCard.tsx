import React from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navigateActiveBrowserTab } from '@/lib/remote-tools/browser-navigate'
import { parsePageNavLinksFromToolCall } from '@/lib/remote-tools/link-utils'
import { TOOL_SHOW_PAGE_NAV_LINKS } from '@/lib/remote-tools/types'
import type { ToolCall } from '@/stores/session'

type PageNavLinksToolCardProps = {
  toolCall: ToolCall
}

export const PageNavLinksToolCard = React.memo(function PageNavLinksToolCard({
  toolCall,
}: PageNavLinksToolCardProps) {
  const { t } = useTranslation()
  const parsed = parsePageNavLinksFromToolCall(
    toolCall.arguments as Record<string, unknown> | undefined,
    toolCall.rawInput,
  )

  if (!parsed) {
    return (
      <div
        data-testid="page-nav-links-tool"
        className="text-[12px] text-muted-foreground px-[10px] py-[6px]"
      >
        {t('chat.toolCall.pageNav.invalid', '无效的导航链接')}
      </div>
    )
  }

  const handleNavigate = (url: string) => {
    void navigateActiveBrowserTab(url).catch((e) => {
      console.warn('[page-nav-links] navigate failed', e)
    })
  }

  return (
    <div
      data-testid="page-nav-links-tool"
      data-tool-name={TOOL_SHOW_PAGE_NAV_LINKS}
      className="flex flex-wrap gap-2 px-[10px] py-[8px]"
    >
      {parsed.links.map((link, index) => (
        <button
          key={`${link}-${index}`}
          type="button"
          data-testid="page-nav-link-button"
          data-nav-url={link}
          title={link}
          onClick={() => handleNavigate(link)}
          className={cn(
            'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-paper px-3 py-1.5',
            'text-[12px] text-ink-2 transition-colors hover:bg-selected',
          )}
        >
          <ExternalLink className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
          <span className="truncate">{parsed.labels[index] ?? link}</span>
        </button>
      ))}
    </div>
  )
})
