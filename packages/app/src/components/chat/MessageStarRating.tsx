import * as React from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTelemetryStore } from '@/stores/telemetry'
import type { StarRating } from '@/lib/telemetry/types'

interface MessageStarRatingProps {
  sessionId: string
  messageId: string
}

export function MessageStarRating({ sessionId, messageId }: MessageStarRatingProps) {
  const setStarRating = useTelemetryStore((s) => s.setStarRating)
  const removeStarRating = useTelemetryStore((s) => s.removeStarRating)
  const starRatingCache = useTelemetryStore((s) => s.starRatingCache)
  const [hoveredStar, setHoveredStar] = React.useState<number | null>(null)

  const currentRating = starRatingCache.get(messageId) as StarRating | undefined
  const isRated = currentRating !== undefined

  const handleClick = React.useCallback(
    async (star: StarRating) => {
      if (currentRating === star) {
        // Click same star to clear
        await removeStarRating(sessionId, messageId)
      } else {
        await setStarRating(sessionId, messageId, star)
      }
    },
    [currentRating, sessionId, messageId, setStarRating, removeStarRating],
  )

  const displayRating = hoveredStar ?? currentRating ?? 0

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 mt-1 transition-opacity duration-300',
        isRated ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
    >
      <span className="text-xs text-muted-foreground/60 select-none">
        How was this result?
      </span>
      <div
        className="inline-flex items-center gap-0"
        onMouseLeave={() => setHoveredStar(null)}
      >
        {([1, 2, 3, 4, 5] as StarRating[]).map((star) => {
          const isFilled = star <= displayRating
          return (
            <button
              key={star}
              onClick={() => handleClick(star)}
              onMouseEnter={() => setHoveredStar(star)}
              className={cn(
                'p-0.5 rounded transition-colors',
                isFilled
                  ? 'text-amber-400'
                  : 'text-muted-foreground/30 hover:text-amber-400/60',
              )}
              title={`${star} star${star > 1 ? 's' : ''}`}
            >
              <Star
                className="h-3.5 w-3.5"
                fill={isFilled ? 'currentColor' : 'none'}
                strokeWidth={isFilled ? 0 : 1.5}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
