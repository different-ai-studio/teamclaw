/**
 * HunkView - Renders a single diff hunk with summary, foldable context, and changed lines.
 *
 * Supports lazy rendering via IntersectionObserver for virtual scrolling
 * of large diffs. Hunks outside the viewport are rendered as lightweight
 * placeholder elements to maintain scroll position.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DiffHunk, DiffLine } from './diff-ast';

interface HunkViewProps {
  hunk: DiffHunk;
  /** Whether the hunk is expanded (showing all lines) */
  expanded?: boolean;
  /** Whether this hunk is selected */
  isSelected?: boolean;
  /** Selected line indices within this hunk */
  selectedLines?: Set<number>;
  /** Callback when a line is clicked */
  onLineClick?: (lineIndex: number, shiftKey: boolean) => void;
  /** Callback when hunk selection toggle is clicked */
  onHunkSelect?: (hunkIndex: number) => void;
  /** HTML ID for scroll targeting */
  id?: string;
  /** Enable virtual scrolling (lazy rendering when off-screen) */
  virtualScroll?: boolean;
}

/** Estimated line height in pixels for placeholder sizing */
const ESTIMATED_LINE_HEIGHT = 20;
/** How many pixels beyond the viewport to pre-render */
const VIRTUAL_SCROLL_MARGIN = 300;

const DiffLineComponent = memo(function DiffLineComponent({
  line,
  lineIndex,
  isSelected,
  onClick,
}: {
  line: DiffLine;
  lineIndex: number;
  isSelected: boolean;
  onClick?: (lineIndex: number, shiftKey: boolean) => void;
}) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onClick?.(lineIndex, e.shiftKey);
    },
    [lineIndex, onClick],
  );

  return (
    <div
      className={cn(
        'flex font-mono text-xs leading-5 hover:bg-muted/40 cursor-pointer',
        line.type === 'added' && 'bg-green-500/10',
        line.type === 'removed' && 'bg-red-500/10',
        line.type === 'context' && 'bg-transparent',
        isSelected && 'ring-1 ring-primary/50 bg-primary/10',
      )}
      onClick={handleClick}
    >
      {/* Old line number */}
      <span className="w-12 text-right pr-2 select-none text-muted-foreground/50 shrink-0">
        {line.oldLineNumber ?? ''}
      </span>
      {/* New line number */}
      <span className="w-12 text-right pr-2 select-none text-muted-foreground/50 shrink-0">
        {line.newLineNumber ?? ''}
      </span>
      {/* Change indicator */}
      <span
        className={cn(
          'w-4 text-center select-none shrink-0',
          line.type === 'added' && 'text-green-500',
          line.type === 'removed' && 'text-red-500',
        )}
      >
        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
      </span>
      {/* Content */}
      <span className="flex-1 whitespace-pre-wrap break-all pl-1">
        {line.content}
      </span>
    </div>
  );
});

export const HunkView = memo(function HunkView({
  hunk,
  expanded = true,
  isSelected = false,
  selectedLines = new Set(),
  onLineClick,
  onHunkSelect,
  id,
  virtualScroll = false,
}: HunkViewProps) {
  const [isExpanded, setIsExpanded] = useState(expanded);
  const [isVisible, setIsVisible] = useState(!virtualScroll);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef<number>(0);

  // IntersectionObserver for virtual scrolling
  useEffect(() => {
    if (!virtualScroll || !containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Track actual height when visible
        if (entry.isIntersecting && containerRef.current) {
          lastHeightRef.current = containerRef.current.offsetHeight;
        }
        setIsVisible(entry.isIntersecting);
      },
      { rootMargin: `${VIRTUAL_SCROLL_MARGIN}px 0px` },
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [virtualScroll]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleHunkSelect = useCallback(() => {
    onHunkSelect?.(hunk.index);
  }, [hunk.index, onHunkSelect]);

  // Split lines into context and change groups for smarter rendering
  const changeLines = hunk.lines.filter((l) => l.type !== 'context');
  const hasChanges = changeLines.length > 0;

  // Placeholder height when virtualized and off-screen
  const placeholderHeight = lastHeightRef.current || (hunk.lines.length * ESTIMATED_LINE_HEIGHT + 28);

  return (
    <div
      ref={containerRef}
      id={id}
      className={cn(
        'border-b border-border/50',
        isSelected && 'ring-1 ring-primary/30',
      )}
      style={virtualScroll && !isVisible ? { minHeight: `${placeholderHeight}px` } : undefined}
    >
      {/* When virtualized and off-screen, render just the summary for minimal DOM */}
      {virtualScroll && !isVisible ? (
        <div className="flex items-center gap-2 px-2 py-1 bg-blue-500/5 text-xs text-muted-foreground/50">
          Hunk {hunk.index} · {hunk.lines.length} lines
        </div>
      ) : (
        <>
          {/* Hunk summary */}
          <div
            className="flex items-center gap-2 px-2 py-1 bg-blue-500/5 border-b border-border/30 cursor-pointer hover:bg-blue-500/10 transition-colors"
            onClick={handleToggle}
          >
            <button className="shrink-0">
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>

            <span className="text-xs font-medium text-muted-foreground">
              Hunk {hunk.index}
            </span>
            <span className="text-xs text-muted-foreground/70">·</span>
            {hunk.addedCount > 0 && (
              <span className="text-xs text-green-500">+{hunk.addedCount}</span>
            )}
            {hunk.removedCount > 0 && (
              <span className="text-xs text-red-500">−{hunk.removedCount}</span>
            )}
            {hunk.context && (
              <span className="text-xs text-muted-foreground/60 font-mono truncate ml-2">
                {hunk.context}
              </span>
            )}

            {/* Hunk select button */}
            {onHunkSelect && (
              <button
                className="ml-auto text-xs text-muted-foreground hover:text-primary shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  handleHunkSelect();
                }}
              >
                Select
              </button>
            )}
          </div>

          {/* Lines */}
          {isExpanded && (
            <div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLineComponent
                  key={lineIndex}
                  line={line}
                  lineIndex={lineIndex}
                  isSelected={selectedLines.has(lineIndex)}
                  onClick={onLineClick}
                />
              ))}
            </div>
          )}

          {/* Collapsed summary */}
          {!isExpanded && hasChanges && (
            <div className="px-4 py-1 text-xs text-muted-foreground/60 italic">
              {hunk.lines.length} lines ({hunk.addedCount} added, {hunk.removedCount} removed)
            </div>
          )}
        </>
      )}
    </div>
  );
});
