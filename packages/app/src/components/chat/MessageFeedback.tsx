import * as React from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTelemetryStore } from '@/stores/telemetry'
import type { FeedbackRating } from '@/lib/telemetry/types'

interface MessageFeedbackProps {
  sessionId: string
  messageId: string
}

export function MessageFeedback({ sessionId, messageId }: MessageFeedbackProps) {
  const setFeedback = useTelemetryStore((s) => s.setFeedback)
  const removeFeedback = useTelemetryStore((s) => s.removeFeedback)
  const feedbackCache = useTelemetryStore((s) => s.feedbackCache)

  // Re-read on cache change
  const currentRating = feedbackCache.get(messageId) as FeedbackRating | undefined

  const handleClick = React.useCallback(
    async (rating: FeedbackRating) => {
      if (currentRating === rating) {
        // Toggle off
        await removeFeedback(sessionId, messageId)
      } else {
        // Set or switch
        await setFeedback(sessionId, messageId, rating)
      }
    },
    [currentRating, sessionId, messageId, setFeedback, removeFeedback],
  )

  const isRated = currentRating !== undefined

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 transition-opacity duration-200',
        isRated ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
    >
      <button
        onClick={() => handleClick('positive')}
        className={cn(
          'p-0.5 rounded transition-colors',
          currentRating === 'positive'
            ? 'text-green-500'
            : 'text-muted-foreground/50 hover:text-green-500/70',
        )}
        title="Good response"
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => handleClick('negative')}
        className={cn(
          'p-0.5 rounded transition-colors',
          currentRating === 'negative'
            ? 'text-red-500'
            : 'text-muted-foreground/50 hover:text-red-500/70',
        )}
        title="Poor response"
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
