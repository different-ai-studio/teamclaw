import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { FileText, ChevronRight, Info } from 'lucide-react';
import type { SearchResult } from '@/stores/knowledge';
import { useWorkspaceStore } from '@/stores/workspace';
import { useUIStore } from '@/stores/ui';

interface Props {
  chunks: SearchResult[];
}

export const RetrievedChunksCard: React.FC<Props> = ({ chunks }) => {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const selectFile = useWorkspaceStore((s) => s.selectFile);
  const closeSettings = useUIStore((s) => s.closeSettings);
  
  const handleChunkClick = React.useCallback((chunk: SearchResult) => {
    if (!workspacePath) return;
    // Convert relative path to absolute path
    // chunk.source is relative to knowledge/ directory (e.g., "examples/file.md")
    // so we need to prepend "knowledge/" and workspace path
    const absolutePath = `${workspacePath}/knowledge/${chunk.source}`;
    
    // Pass the start line for code files, or heading for Markdown files
    selectFile(absolutePath, chunk.startLine, chunk.heading);
    closeSettings();
  }, [selectFile, closeSettings, workspacePath]);
  
  if (!chunks || chunks.length === 0) {
    return null;
  }
  
  return (
    <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Info className="h-4 w-4" />
          <span>{t('knowledge.retrieved', { count: chunks.length })}</span>
        </div>
        
        <div className="space-y-1.5">
          {chunks.map((chunk, index) => (
            <Card
              key={index}
              className="cursor-pointer hover:bg-accent transition-colors py-2"
              onClick={() => handleChunkClick(chunk)}
            >
              <CardContent className="px-3">
                <div className="flex items-center gap-2 mb-1 min-w-0">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-medium truncate flex-1 min-w-0">{chunk.source}</span>
                  <span className="text-xs text-muted-foreground ml-auto shrink-0">
                    {chunk.score.toFixed(2)}
                  </span>
                </div>
                
                {chunk.heading && (
                  <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1 min-w-0">
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <span className="truncate flex-1 min-w-0">{chunk.heading}</span>
                  </div>
                )}
                
                <p className="text-xs line-clamp-2 break-words text-muted-foreground">
                  {chunk.content}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
