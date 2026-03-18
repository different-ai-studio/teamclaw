import * as React from "react";
import { FileText, Folder, User, Paperclip, ChevronDown, ChevronUp, Zap, Command as CommandIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { ClickableImage, LocalImage, resolveImagePath } from "@/packages/ai/message";

/** Max pixel height before the message is collapsed */
const COLLAPSED_HEIGHT = 200;

function LocalImageCard({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <div className="rounded-lg overflow-hidden border border-white/20 bg-white/10">
      <LocalImage
        src={src}
        alt={alt}
        className="max-w-[200px] max-h-40 object-contain"
        onError={() => setFailed(true)}
      />
      <div className="px-2 py-1 text-[10px] text-white/70 truncate max-w-[200px]">
        {alt}
      </div>
    </div>
  );
}

export function UserMessageWithMentions({ content, basePath }: { content: string; basePath?: string }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [needsCollapse, setNeedsCollapse] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Measure content height after render to decide whether to collapse
  React.useEffect(() => {
    const el = contentRef.current;
    if (el) {
      // Add a small buffer (20px) so we don't collapse content that's barely over the limit
      setNeedsCollapse(el.scrollHeight > COLLAPSED_HEIGHT + 20);
    }
  }, [content]);

  const parts = React.useMemo(() => {
    const result: Array<{
      type: "text" | "file" | "directory" | "image" | "mentioned" | "attachment" | "filemention" | "skill" | "command";
      content: string;
      people?: string[];
      dataUrl?: string;
      size?: string;
      fullPath?: string;
    }> = [];

    let lastIndex = 0;
    // Match @{filepath}, /{skillname}, /[commandname], [File: filepath], [Skill: skillname], [Command: commandname], [Attachment: ...], and other formats
    const combinedRegex =
      /@\{([^}]+)\}|\/\{([^}]+)\}|\/\[([^\]]+)\]|\[Mentioned: ([^\]]+)\]|\[File: ([^\]]+)\](?:\n```[\s\S]*?```)?|\[Skill: ([^\]]+)\]|\[Command: ([^\]]+)\]|\[Directory: ([^\]]+)\]\s*|\[Image: ([^\]]+)\](?:\n([^\n]*))?|\[Attachment: ([^\]]+)\]\s*\(([^)]*)\)/g;

    let match;
    while ((match = combinedRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        const text = content.slice(lastIndex, match.index);
        if (text) {
          result.push({ type: "text", content: text });
        }
      }

      if (match[1]) {
        // @{filepath} format (for user input display)
        result.push({ type: "filemention", content: match[1] });
      } else if (match[2]) {
        // /{skillname} format (for user input display)
        result.push({ type: "skill", content: match[2] });
      } else if (match[3]) {
        // /[commandname] format (for user input display)
        result.push({ type: "command", content: match[3] });
      } else if (match[4]) {
        const people = match[4].split(',').map(p => p.trim());
        result.push({ type: "mentioned", content: match[4], people });
      } else if (match[5]) {
        // [File: filepath] format (sent to LLM)
        result.push({ type: "file", content: match[5] });
      } else if (match[6]) {
        // [Skill: skillname] format (sent to LLM)
        result.push({ type: "skill", content: match[6] });
      } else if (match[7]) {
        // [Command: commandname] format (sent to LLM)
        result.push({ type: "command", content: match[7] });
      } else if (match[8]) {
        result.push({ type: "directory", content: match[8] });
      } else if (match[9]) {
        const dataUrl = match[10] && match[10].startsWith("data:") ? match[10] : undefined;
        result.push({ type: "image", content: match[9], dataUrl });
      } else if (match[11]) {
        // Parse the parenthesised info: may contain path:..., size:...
        const info = match[12] ?? "";
        const pathMatch = info.match(/path:\s*([^,)]+)/);
        const sizeMatch = info.match(/size:\s*([^,)]+)/);
        const fullPath = pathMatch ? pathMatch[1].trim() : undefined;
        const size = sizeMatch ? sizeMatch[1].trim() : (!pathMatch && info.trim() ? info.trim() : undefined);
        result.push({ type: "attachment", content: match[11], size, fullPath });
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      const text = content.slice(lastIndex);
      if (text) {
        result.push({ type: "text", content: text });
      }
    }

    return result;
  }, [content]);

  const isSimpleText = parts.length === 0 || (parts.length === 1 && parts[0].type === "text");

  // Build the inner content - render parts in order
  const innerContent = isSimpleText ? (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{content}</div>
  ) : (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <span key={index}>{part.content}</span>;
        }
        
        if (part.type === "mentioned" && part.people) {
          return (
            <React.Fragment key={index}>
              {part.people.map((person, personIndex) => {
                const personMatch = person.match(/^(.+?)(?:\s*\(([^)]+)\))?$/);
                const name = personMatch ? personMatch[1] : person;
                const email = personMatch ? personMatch[2] : undefined;
                
                return (
                  <span
                    key={personIndex}
                    className="inline-flex items-center gap-1 px-2 py-1 mx-0.5 rounded-md text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                  >
                    <User className="h-3 w-3" />
                    <span className="truncate max-w-[200px]" title={email}>
                      {name}
                    </span>
                  </span>
                );
              })}
            </React.Fragment>
          );
        }
        
        if (part.type === "image") {
          if (part.dataUrl) {
            return (
              <div key={index} className="my-2 rounded-lg overflow-hidden inline-block">
                <ClickableImage
                  src={part.dataUrl}
                  alt={part.content}
                  className="max-w-full max-h-64 object-contain rounded-lg"
                />
              </div>
            );
          } else {
            return (
              <div key={index} className="inline-block my-2">
                <LocalImageCard
                  src={resolveImagePath(part.content, basePath)}
                  alt={part.content}
                />
              </div>
            );
          }
        }

        if (part.type === "attachment") {
          const parentDir = part.fullPath
            ? part.fullPath.replace(/\\/g, "/").split("/").slice(-2, -1)[0]
            : undefined;
          return (
            <span
              key={index}
              title={part.fullPath ?? part.content}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 mx-0.5 rounded-md text-xs bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 min-w-0 max-w-[280px]"
            >
              <Paperclip className="h-3 w-3 flex-shrink-0" />
              <span className="flex flex-col min-w-0">
                <span className="truncate font-medium leading-tight">{part.content}</span>
                {parentDir && (
                  <span className="truncate text-[10px] opacity-60 leading-tight">{parentDir}</span>
                )}
              </span>
              {part.size && (
                <span className="text-orange-500 dark:text-orange-400 flex-shrink-0 ml-0.5">{part.size}</span>
              )}
            </span>
          );
        }
        
        return (
          <span
            key={index}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-1 mx-0.5 rounded-md text-xs",
              (part.type === "file" || part.type === "filemention") && "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
              part.type === "directory" && "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
              part.type === "skill" && "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
              part.type === "command" && "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
            )}
          >
            {(part.type === "file" || part.type === "filemention") && <FileText className="h-3 w-3" />}
            {part.type === "directory" && <Folder className="h-3 w-3" />}
            {part.type === "skill" && <Zap className="h-3 w-3" />}
            {part.type === "command" && <CommandIcon className="h-3 w-3" />}
            <span className="truncate max-w-[400px]" title={part.content}>{part.content}</span>
          </span>
        );
      })}
    </div>
  );

  const isCollapsed = needsCollapse && !isExpanded;

  return (
    <div>
      {/* Content container with optional max-height clipping */}
      <div
        ref={contentRef}
        className="relative"
        style={
          isCollapsed
            ? { maxHeight: COLLAPSED_HEIGHT, overflow: "hidden" }
            : undefined
        }
      >
        {innerContent}

        {/* Gradient fade overlay when collapsed — matches the bubble bg color */}
        {isCollapsed && (
          <div
            className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none"
            style={{
              background:
                "linear-gradient(to top, #6f8c8a 0%, rgba(111,140,138,0) 100%)",
            }}
          />
        )}
      </div>

      {/* Expand / collapse toggle */}
      {needsCollapse && (
        <button
          onClick={() => setIsExpanded((v) => !v)}
          className="flex items-center gap-1 mt-1.5 text-xs text-white/70 hover:text-white/95 transition-colors cursor-pointer"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              <span>{t("chat.showLess", "Show less")}</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              <span>{t("chat.showMore", "Show more")}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
