/**
 * DiffHeader - File-level information for diff view.
 * Displays file path, change statistics, file status, and Agent actions.
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { Copy, ChevronDown, ChevronUp, Send, MessageSquare, Wand2, FileCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, copyToClipboard } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { FileStatus } from './diff-ast';
import type { AgentOperation } from './agent-operations';

interface DiffHeaderProps {
  filePath: string;
  oldFilePath?: string;
  status: FileStatus;
  addedCount: number;
  removedCount: number;
  allExpanded?: boolean;
  onToggleExpandAll?: () => void;
  onSendToAgent?: () => void;
  /** Callback for specific Agent operations */
  onAgentOperation?: (operation: AgentOperation) => void;
}

const STATUS_LABELS: Record<FileStatus, { label: string; color: string }> = {
  modified: { label: 'Modified', color: 'text-yellow-500' },
  renamed: { label: 'Renamed', color: 'text-blue-500' },
  new: { label: 'New', color: 'text-green-500' },
  deleted: { label: 'Deleted', color: 'text-red-500' },
};

export function DiffHeader({
  filePath,
  oldFilePath,
  status,
  addedCount,
  removedCount,
  allExpanded = true,
  onToggleExpandAll,
  onSendToAgent,
  onAgentOperation,
}: DiffHeaderProps) {
  const { t } = useTranslation();
  const statusInfo = STATUS_LABELS[status];
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleCopyPath = useCallback(() => {
    copyToClipboard(filePath, t('diff.pathCopied', 'Path copied'));
  }, [filePath, t]);

  // Close menu on outside click
  useEffect(() => {
    if (!showAgentMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAgentMenu]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b text-sm sticky top-0 z-10">
      {/* File path */}
      <button
        onClick={handleCopyPath}
        className="flex items-center gap-1 text-foreground hover:text-primary transition-colors font-mono text-xs truncate"
        title={t('diff.clickToCopy', 'Click to copy path')}
      >
        {oldFilePath && status === 'renamed' ? (
          <span>
            <span className="line-through opacity-60">{oldFilePath}</span>
            <span className="mx-1">→</span>
            <span>{filePath}</span>
          </span>
        ) : (
          <span>{filePath}</span>
        )}
        <Copy className="h-3 w-3 opacity-50 shrink-0" />
      </button>

      {/* Change stats */}
      <div className="flex items-center gap-1 ml-auto shrink-0">
        {addedCount > 0 && (
          <span className="text-green-500 font-mono text-xs">+{addedCount}</span>
        )}
        {removedCount > 0 && (
          <span className="text-red-500 font-mono text-xs">−{removedCount}</span>
        )}
      </div>

      {/* File status badge */}
      <span className={cn('text-xs font-medium shrink-0', statusInfo.color)}>
        {statusInfo.label}
      </span>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {onToggleExpandAll && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onToggleExpandAll}
            title={allExpanded
              ? t('diff.collapseAll', 'Collapse all')
              : t('diff.expandAll', 'Expand all')
            }
          >
            {allExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>
        )}

        {/* Agent operations dropdown */}
        {(onSendToAgent || onAgentOperation) && (
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5"
              onClick={() => {
                if (onAgentOperation) {
                  setShowAgentMenu(!showAgentMenu);
                } else if (onSendToAgent) {
                  onSendToAgent();
                }
              }}
              title={t('diff.agentActions', 'Agent Actions')}
            >
              <Send className="h-3.5 w-3.5" />
              {onAgentOperation && (
                <ChevronDown className="h-3 w-3" />
              )}
            </Button>

            {showAgentMenu && onAgentOperation && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-popover border rounded-md shadow-md py-1 min-w-[160px]">
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
                  onClick={() => { onAgentOperation('review'); setShowAgentMenu(false); }}
                >
                  <Send className="h-3.5 w-3.5" />
                  {t('diff.reviewCode', 'Review Code')}
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
                  onClick={() => { onAgentOperation('explain'); setShowAgentMenu(false); }}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('diff.explainChange', 'Explain Change')}
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
                  onClick={() => { onAgentOperation('refactor'); setShowAgentMenu(false); }}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {t('diff.suggestRefactor', 'Suggest Refactor')}
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent text-left"
                  onClick={() => { onAgentOperation('generatePatch'); setShowAgentMenu(false); }}
                >
                  <FileCode className="h-3.5 w-3.5" />
                  {t('diff.generatePatch', 'Generate Patch')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
