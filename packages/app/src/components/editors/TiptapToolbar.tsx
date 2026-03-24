/**
 * TiptapToolbar - Simple Editor style toolbar for Tiptap editor
 * 
 * Features:
 * - Undo/Redo
 * - Heading dropdown
 * - Lists (bullet, ordered, task)
 * - Formatting (Bold, Italic, Underline, Strikethrough)
 * - Code (inline, block)
 * - Link
 * - Text alignment (Left, Center, Right, Justify)
 * - Blockquote
 * - Table insert
 */

import type { Editor } from '@tiptap/react';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Code2,
  Link,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Table,
  FileCode,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface TiptapToolbarProps {
  editor: Editor | null;
  isDark?: boolean;
  onImageUpload?: () => void;
  rawMode?: boolean;
  onToggleRaw?: () => void;
}

export function TiptapToolbar({
  editor,
  isDark = false,
  onImageUpload,
  rawMode = false,
  onToggleRaw,
}: TiptapToolbarProps) {
  const sourceToggleButton = onToggleRaw && (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onToggleRaw}
      className={cn('h-8 w-8 shrink-0', rawMode && 'bg-accent')}
      title={rawMode ? 'Visual mode' : 'Source mode'}
    >
      <FileCode className="h-4 w-4" />
    </Button>
  );

  const outerClass = cn(
    'flex items-center gap-1 p-2 border-b',
    isDark ? 'bg-[#1e1e1e] border-border' : 'bg-white border-border',
  );

  // In raw mode, show minimal toolbar with just the source toggle
  if (rawMode) {
    return (
      <div className={outerClass}>
        <div className="flex-1" />
        {sourceToggleButton && (
          <>
            <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />
            {sourceToggleButton}
          </>
        )}
      </div>
    );
  }

  if (!editor) {
    return null;
  }

  return (
    <div className={outerClass}>
      {/* Scrollable toolbar buttons */}
      <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1">
      {/* Undo/Redo */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        className="h-8 w-8 shrink-0"
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        className="h-8 w-8 shrink-0"
      >
        <Redo2 className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Heading Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 px-2">
            {editor.isActive('heading', { level: 1 }) && (
              <>
                <Heading1 className="h-4 w-4 mr-1" />
                <span className="text-xs">H1</span>
              </>
            )}
            {editor.isActive('heading', { level: 2 }) && (
              <>
                <Heading2 className="h-4 w-4 mr-1" />
                <span className="text-xs">H2</span>
              </>
            )}
            {editor.isActive('heading', { level: 3 }) && (
              <>
                <Heading3 className="h-4 w-4 mr-1" />
                <span className="text-xs">H3</span>
              </>
            )}
            {!editor.isActive('heading') && (
              <>
                <Heading2 className="h-4 w-4 mr-1" />
                <span className="text-xs">Normal</span>
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
          >
            <Heading1 className="h-4 w-4 mr-2" />
            Heading 1
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            <Heading2 className="h-4 w-4 mr-2" />
            Heading 2
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 3 }).run()
            }
          >
            <Heading3 className="h-4 w-4 mr-2" />
            Heading 3
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => editor.chain().focus().setParagraph().run()}
          >
            Paragraph
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Lists */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('bulletList') && 'bg-accent',
        )}
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('orderedList') && 'bg-accent',
        )}
      >
        <ListOrdered className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('taskList') && 'bg-accent',
        )}
      >
        <CheckSquare className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Formatting */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('bold') && 'bg-accent',
        )}
      >
        <Bold className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('italic') && 'bg-accent',
        )}
      >
        <Italic className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('strike') && 'bg-accent',
        )}
      >
        <Strikethrough className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('underline') && 'bg-accent',
        )}
      >
        <Underline className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Code */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('code') && 'bg-accent',
        )}
      >
        <Code className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('codeBlock') && 'bg-accent',
        )}
      >
        <Code2 className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Link */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          const url = window.prompt('Enter URL:');
          if (url) {
            editor.chain().focus().setLink({ href: url }).run();
          }
        }}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('link') && 'bg-accent',
        )}
      >
        <Link className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Text Alignment */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive({ textAlign: 'left' }) && 'bg-accent',
        )}
      >
        <AlignLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive({ textAlign: 'center' }) && 'bg-accent',
        )}
      >
        <AlignCenter className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive({ textAlign: 'right' }) && 'bg-accent',
        )}
      >
        <AlignRight className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive({ textAlign: 'justify' }) && 'bg-accent',
        )}
      >
        <AlignJustify className="h-4 w-4" />
      </Button>

      <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />

      {/* Blockquote */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('blockquote') && 'bg-accent',
        )}
      >
        <Quote className="h-4 w-4" />
      </Button>

      {/* Table insert */}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
        className={cn(
          'h-8 w-8 shrink-0',
          editor.isActive('table') && 'bg-accent',
        )}
      >
        <Table className="h-4 w-4" />
      </Button>

      {/* Image Upload */}
      {onImageUpload && (
        <>
          <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onImageUpload}
            className="h-8 w-8 shrink-0"
          >
            <Image className="h-4 w-4" />
          </Button>
        </>
      )}

      </div>
      {/* Source mode toggle - always visible at right edge */}
      {sourceToggleButton && (
        <>
          <Separator orientation="vertical" className="h-6 mx-1 shrink-0" />
          {sourceToggleButton}
        </>
      )}
    </div>
  );
}
