/**
 * HunkNavigator - Mini-map showing spatial overview of changes.
 * Each block represents a hunk, height proportional to changed line count.
 */

import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { DiffHunk } from './diff-ast';

interface HunkNavigatorProps {
  hunks: DiffHunk[];
  /** Total lines in file (for proportional positioning) */
  totalLines: number;
  /** Currently active/visible hunk index */
  activeHunkIndex?: number;
  /** Callback when a hunk block is clicked */
  onHunkClick?: (hunkIndex: number) => void;
}

export function HunkNavigator({
  hunks,
  totalLines: _totalLines,
  activeHunkIndex,
  onHunkClick,
}: HunkNavigatorProps) {
  if (hunks.length === 0) return null;

  const maxChanges = Math.max(...hunks.map((h) => h.addedCount + h.removedCount), 1);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-0.5 w-3 min-h-[60px] relative bg-muted/30 rounded-sm overflow-hidden">
        {hunks.map((hunk) => {
          const changedLines = hunk.addedCount + hunk.removedCount;
          // Height proportional to number of changes (min 4px, max 24px)
          const height = Math.max(4, Math.min(24, (changedLines / maxChanges) * 24));

          const isActive = activeHunkIndex === hunk.index;

          return (
            <Tooltip key={hunk.index}>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    'w-full rounded-[1px] transition-all hover:opacity-100',
                    isActive ? 'opacity-100' : 'opacity-70',
                    hunk.addedCount > 0 && hunk.removedCount > 0
                      ? 'bg-yellow-500'
                      : hunk.addedCount > 0
                        ? 'bg-green-500'
                        : 'bg-red-500',
                  )}
                  style={{ height: `${height}px` }}
                  onClick={() => onHunkClick?.(hunk.index)}
                />
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                <span>
                  Hunk #{hunk.index}{' '}
                  {hunk.addedCount > 0 && <span className="text-green-400">+{hunk.addedCount}</span>}{' '}
                  {hunk.removedCount > 0 && <span className="text-red-400">−{hunk.removedCount}</span>}
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
