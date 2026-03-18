/**
 * TableBubbleMenu — Floating toolbar that appears when the cursor is inside a table.
 *
 * Provides quick access to common table operations:
 * - Add/remove rows and columns
 * - Delete the entire table
 * - Merge/split cells
 * - Toggle header row
 */

import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Plus,
  Minus,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Merge,
  ToggleRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface TableBubbleMenuProps {
  editor: Editor;
}

function ToolbarButton({
  onClick,
  disabled,
  tooltip,
  children,
  destructive,
}: {
  onClick: () => void;
  disabled?: boolean;
  tooltip: string;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "h-7 w-7",
            destructive && "hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export function TableBubbleMenu({ editor }: TableBubbleMenuProps) {
  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: e }) => e.isActive("table")}
      options={{
        placement: "top",
        offset: 8,
      }}
    >
      <div className="flex items-center gap-0.5 rounded-lg border bg-background px-1 py-0.5 shadow-md">
        {/* Column operations */}
        <ToolbarButton
          onClick={() => editor.chain().focus().addColumnBefore().run()}
          disabled={!editor.can().addColumnBefore()}
          tooltip="Insert column before"
        >
          <div className="flex items-center">
            <ArrowLeft className="h-3 w-3" />
            <Plus className="h-2.5 w-2.5 -ml-0.5" />
          </div>
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().addColumnAfter().run()}
          disabled={!editor.can().addColumnAfter()}
          tooltip="Insert column after"
        >
          <div className="flex items-center">
            <Plus className="h-2.5 w-2.5 -mr-0.5" />
            <ArrowRight className="h-3 w-3" />
          </div>
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().deleteColumn().run()}
          disabled={!editor.can().deleteColumn()}
          tooltip="Delete column"
          destructive
        >
          <div className="flex items-center">
            <Minus className="h-3 w-3" />
          </div>
        </ToolbarButton>

        <Separator orientation="vertical" className="h-5 mx-0.5" />

        {/* Row operations */}
        <ToolbarButton
          onClick={() => editor.chain().focus().addRowBefore().run()}
          disabled={!editor.can().addRowBefore()}
          tooltip="Insert row above"
        >
          <div className="flex items-center flex-col">
            <ArrowUp className="h-3 w-3" />
            <Plus className="h-2 w-2 -mt-1" />
          </div>
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().addRowAfter().run()}
          disabled={!editor.can().addRowAfter()}
          tooltip="Insert row below"
        >
          <div className="flex items-center flex-col">
            <Plus className="h-2 w-2 -mb-1" />
            <ArrowDown className="h-3 w-3" />
          </div>
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().deleteRow().run()}
          disabled={!editor.can().deleteRow()}
          tooltip="Delete row"
          destructive
        >
          <Minus className="h-3 w-3" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-5 mx-0.5" />

        {/* Merge/Split */}
        <ToolbarButton
          onClick={() => editor.chain().focus().mergeOrSplit().run()}
          disabled={!editor.can().mergeOrSplit()}
          tooltip="Merge or split cells"
        >
          <Merge className="h-3.5 w-3.5" />
        </ToolbarButton>

        {/* Toggle header */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeaderRow().run()}
          disabled={!editor.can().toggleHeaderRow()}
          tooltip="Toggle header row"
        >
          <ToggleRight className="h-3.5 w-3.5" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-5 mx-0.5" />

        {/* Delete table */}
        <ToolbarButton
          onClick={() => editor.chain().focus().deleteTable().run()}
          disabled={!editor.can().deleteTable()}
          tooltip="Delete table"
          destructive
        >
          <Trash2 className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
    </BubbleMenu>
  );
}
