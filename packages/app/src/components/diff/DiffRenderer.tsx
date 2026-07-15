/**
 * DiffRenderer - Unified diff view for all file types.
 *
 * Features:
 * - Custom Diff Renderer using structured AST
 * - File-level header (path, stats, status)
 * - Hunk navigator (mini-map)
 * - Hunk structure with summary, foldable context, changed lines
 * - Selection mechanism (line / hunk / file level)
 * - Agent-first interaction (send selection to Agent)
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { parseSingleFileDiff, type DiffFile } from './diff-ast';
import { DiffHeader } from './DiffHeader';
import { HunkNavigator } from './HunkNavigator';
import { HunkView } from './HunkView';
import { generateAgentPrompt, type AgentOperation } from './agent-operations';

interface DiffRendererProps {
  /** Raw git diff output for a single file (preferred if available) */
  diffText?: string;
  /** Original file content (used to compute diff if diffText not provided) */
  before?: string;
  /** Modified file content (used to compute diff if diffText not provided) */
  after?: string;
  /** File path */
  filePath: string;
  /** Whether dark mode is active */
  isDark?: boolean;
  /** Callback when selection is sent to Agent (receives formatted prompt) */
  onSendToAgent?: (selectedDiff: string) => void;
}

/**
 * Generate a unified diff from two strings.
 */
function generateUnifiedDiff(before: string, after: string, filePath: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  // Simple line-by-line diff generation
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);

  // Find differences using a simple approach
  let hunkStart = -1;
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  const hunkLines: string[] = [];

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      const oldCount = hunkLines.filter(l => l.startsWith('-') || l.startsWith(' ')).length;
      const newCount = hunkLines.filter(l => l.startsWith('+') || l.startsWith(' ')).length;
      lines.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`);
      lines.push(...hunkLines);
      hunkLines.length = 0;
      hunkStart = -1;
    }
  };

  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      // Context line
      if (hunkStart >= 0) {
        hunkLines.push(` ${oldLines[oi]}`);
        // If we have 3+ context lines after changes, flush the hunk
        const contextCount = hunkLines.slice().reverse().findIndex(l => !l.startsWith(' '));
        if (contextCount >= 3) {
          // Remove extra context, flush
          hunkLines.splice(hunkLines.length - (contextCount - 3));
          flushHunk();
        }
      }
      oi++;
      ni++;
    } else {
      // Start or continue hunk
      if (hunkStart < 0) {
        hunkStart = oi;
        hunkOldStart = Math.max(0, oi - 3);
        hunkNewStart = Math.max(0, ni - 3);
        // Add preceding context
        for (let c = Math.max(0, oi - 3); c < oi; c++) {
          if (c < oldLines.length) {
            hunkLines.push(` ${oldLines[c]}`);
          }
        }
      }

      // Find next matching line
      if (oi < oldLines.length && (ni >= newLines.length || oldLines[oi] !== newLines[ni])) {
        // Check if old line exists later in new
        const nextInNew = newLines.indexOf(oldLines[oi], ni);
        const nextInOld = ni < newLines.length ? oldLines.indexOf(newLines[ni], oi) : -1;

        if (nextInNew >= 0 && (nextInOld < 0 || nextInNew - ni <= nextInOld - oi)) {
          // Lines were added before this
          while (ni < nextInNew) {
            hunkLines.push(`+${newLines[ni]}`);
            ni++;
          }
        } else if (nextInOld >= 0) {
          // Lines were removed before this
          while (oi < nextInOld) {
            hunkLines.push(`-${oldLines[oi]}`);
            oi++;
          }
        } else {
          // Both changed
          if (oi < oldLines.length) {
            hunkLines.push(`-${oldLines[oi]}`);
            oi++;
          }
          if (ni < newLines.length) {
            hunkLines.push(`+${newLines[ni]}`);
            ni++;
          }
        }
      } else {
        if (ni < newLines.length) {
          hunkLines.push(`+${newLines[ni]}`);
          ni++;
        }
        if (oi < oldLines.length && oldLines[oi] !== newLines[ni - 1]) {
          hunkLines.push(`-${oldLines[oi]}`);
          oi++;
        }
      }
    }
  }

  flushHunk();
  return lines.join('\n');
}

export function DiffRenderer({
  diffText,
  before,
  after,
  filePath,
  isDark = false,
  onSendToAgent,
}: DiffRendererProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [allExpanded, setAllExpanded] = useState(true);
  const [activeHunkIndex, setActiveHunkIndex] = useState<number | undefined>();
  const [selectedHunks, setSelectedHunks] = useState<Set<number>>(new Set());
  const [selectedLines, setSelectedLines] = useState<Map<number, Set<number>>>(new Map());

  // Compute or parse diff
  const effectiveDiffText = useMemo(() => {
    if (diffText) return diffText;
    if (before !== undefined && after !== undefined) {
      return generateUnifiedDiff(before, after, filePath);
    }
    return '';
  }, [diffText, before, after, filePath]);

  // Parse diff
  const diffFile = useMemo<DiffFile | null>(() => {
    if (!effectiveDiffText) return null;
    return parseSingleFileDiff(effectiveDiffText, filePath);
  }, [effectiveDiffText, filePath]);

  // Calculate total lines for navigator
  const totalLines = useMemo(() => {
    if (!diffFile) return 0;
    const lastHunk = diffFile.hunks[diffFile.hunks.length - 1];
    if (!lastHunk) return 0;
    return lastHunk.newStart + lastHunk.newCount;
  }, [diffFile]);

  // Handle hunk click in navigator
  const handleNavigatorHunkClick = useCallback((hunkIndex: number) => {
    setActiveHunkIndex(hunkIndex);
    const el = document.getElementById(`hunk-${hunkIndex}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Toggle expand all
  const handleToggleExpandAll = useCallback(() => {
    setAllExpanded((prev) => !prev);
  }, []);

  // Handle hunk selection
  const handleHunkSelect = useCallback((hunkIndex: number) => {
    setSelectedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(hunkIndex)) {
        next.delete(hunkIndex);
      } else {
        next.add(hunkIndex);
      }
      return next;
    });
  }, []);

  // Handle line selection within a hunk
  const handleLineClick = useCallback((hunkIndex: number, lineIndex: number, _shiftKey: boolean) => {
    setSelectedLines((prev) => {
      const next = new Map(prev);
      const hunkLines = next.get(hunkIndex) || new Set<number>();
      const updatedLines = new Set(hunkLines);

      if (updatedLines.has(lineIndex)) {
        updatedLines.delete(lineIndex);
      } else {
        updatedLines.add(lineIndex);
      }

      if (updatedLines.size === 0) {
        next.delete(hunkIndex);
      } else {
        next.set(hunkIndex, updatedLines);
      }

      return next;
    });
  }, []);

  // Build selected diff text for Agent
  const getSelectedDiffText = useCallback((): string => {
    if (!diffFile) return '';

    const parts: string[] = [];

    // If hunks are selected, include them
    for (const hunk of diffFile.hunks) {
      if (selectedHunks.has(hunk.index)) {
        parts.push(hunk.header);
        for (const line of hunk.lines) {
          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
          parts.push(`${prefix}${line.content}`);
        }
      } else {
        // Check for individual line selections
        const hunkSelectedLines = selectedLines.get(hunk.index);
        if (hunkSelectedLines && hunkSelectedLines.size > 0) {
          parts.push(hunk.header);
          for (let i = 0; i < hunk.lines.length; i++) {
            if (hunkSelectedLines.has(i)) {
              const line = hunk.lines[i];
              const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
              parts.push(`${prefix}${line.content}`);
            }
          }
        }
      }
    }

    return parts.join('\n');
  }, [diffFile, selectedHunks, selectedLines]);

  // Get the diff text to send (selected or full)
  const getDiffTextForAgent = useCallback((): string => {
    const hasSelection = selectedHunks.size > 0 || selectedLines.size > 0;
    if (hasSelection) {
      return getSelectedDiffText();
    }
    return effectiveDiffText;
  }, [selectedHunks, selectedLines, getSelectedDiffText, effectiveDiffText]);

  // Handle send to Agent (review by default)
  const handleSendToAgent = useCallback(() => {
    if (!onSendToAgent) return;
    const diffForAgent = getDiffTextForAgent();
    if (diffForAgent) {
      onSendToAgent(generateAgentPrompt('review', { diffText: diffForAgent, filePath }));
    }
  }, [onSendToAgent, getDiffTextForAgent, filePath]);

  // Handle specific Agent operation
  const handleAgentOperation = useCallback((operation: AgentOperation) => {
    if (!onSendToAgent) return;
    const diffForAgent = getDiffTextForAgent();
    if (diffForAgent) {
      onSendToAgent(generateAgentPrompt(operation, { diffText: diffForAgent, filePath }));
    }
  }, [onSendToAgent, getDiffTextForAgent, filePath]);

  if (!diffFile || diffFile.hunks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No changes to display
      </div>
    );
  }

  return (
    <div className={cn('h-full flex flex-col', isDark ? 'bg-[#1e1e1e]' : 'bg-background')}>
      {/* Header */}
      <DiffHeader
        filePath={diffFile.filePath}
        oldFilePath={diffFile.oldFilePath}
        status={diffFile.status}
        addedCount={diffFile.addedCount}
        removedCount={diffFile.removedCount}
        allExpanded={allExpanded}
        onToggleExpandAll={handleToggleExpandAll}
        onSendToAgent={onSendToAgent ? handleSendToAgent : undefined}
        onAgentOperation={onSendToAgent ? handleAgentOperation : undefined}
      />

      {/* Content area with navigator */}
      <div className="flex-1 flex overflow-hidden">
        {/* Mini-map navigator */}
        <div className="shrink-0 p-1 border-r border-border/30">
          <HunkNavigator
            hunks={diffFile.hunks}
            totalLines={totalLines}
            activeHunkIndex={activeHunkIndex}
            onHunkClick={handleNavigatorHunkClick}
          />
        </div>

        {/* Diff content */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-auto"
        >
          {diffFile.hunks.map((hunk) => (
            <HunkView
              key={hunk.index}
              id={`hunk-${hunk.index}`}
              hunk={hunk}
              expanded={allExpanded}
              isSelected={selectedHunks.has(hunk.index)}
              selectedLines={selectedLines.get(hunk.index) || new Set()}
              onLineClick={(lineIndex, shiftKey) => handleLineClick(hunk.index, lineIndex, shiftKey)}
              onHunkSelect={handleHunkSelect}
              virtualScroll={diffFile.hunks.length > 20}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default DiffRenderer;
