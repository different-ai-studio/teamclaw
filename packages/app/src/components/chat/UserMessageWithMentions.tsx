import * as React from "react";
import { FileText, Folder, User, UserRound, Paperclip, ChevronDown, ChevronUp, Zap, Command as CommandIcon } from "lucide-react";
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

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|heif)$/i.test(path);
}

function parseSlashToken(body: string): { type: "role" | "skill" | "command"; name: string } {
  if (body.startsWith("role:")) return { type: "role", name: body.slice("role:".length) };
  if (body.startsWith("skill:")) return { type: "skill", name: body.slice("skill:".length) };
  if (body.startsWith("command:")) return { type: "command", name: body.slice("command:".length) };
  return { type: "skill", name: body };
}

export function UserMessageWithMentions({ content, basePath }: { content: string; basePath?: string }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [needsCollapse, setNeedsCollapse] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const displayContent = React.useMemo(
    () =>
      content
        .replace(/(?:\r?\n){0,2}First tool call:\s*role_load\(\{\s*name:\s*"[^"]+"\s*\}\)\.\s*/g, "")
        .trim(),
    [content],
  )

  // Measure content height after render to decide whether to collapse
  React.useEffect(() => {
    const el = contentRef.current;
    if (el) {
      // Add a small buffer (20px) so we don't collapse content that's barely over the limit
      setNeedsCollapse(el.scrollHeight > COLLAPSED_HEIGHT + 20);
    }
  }, [displayContent]);

  const parts = React.useMemo(() => {
    const result: Array<{
      type: "text" | "file" | "directory" | "image" | "mentioned" | "attachment" | "filemention" | "role" | "skill" | "command";
      content: string;
      people?: string[];
      dataUrl?: string;
      size?: string;
      fullPath?: string;
    }> = [];

    let lastIndex = 0;
    // Match @{filepath}, unified /{type:name}, legacy /<role> and /[command], [Role: ...], [File: ...], [Skill: ...], [Command: ...], [Attachment: ...], and other formats
    const combinedRegex =
      /@\{([^}]+)\}|\/\{([^}]+)\}|\/<([a-z0-9]+(?:-[a-z0-9]+)*)>|\/\[([^\]]+)\]|\[Mentioned: ([^\]]+)\]|\[Role: ([^\]]+)\]|\[File: ([^\]]+)\](?:\n```[\s\S]*?```)?|\[Skill: ([^\]]+)\]|\[Command: ([^\]]+)\]|\[Directory: ([^\]]+)\]\s*|\[Image: ([^\]]+)\](?:\n([^\n]*))?|\[Attachment: ([^\]]+)\]\s*\(([^)]*)\)/g;

    let match;
    while ((match = combinedRegex.exec(displayContent)) !== null) {
      if (match.index > lastIndex) {
        const text = displayContent.slice(lastIndex, match.index);
        if (text) {
          result.push({ type: "text", content: text });
        }
      }

      if (match[1]) {
        // @{filepath} format (for user input display)
        result.push({ type: "filemention", content: match[1] });
      } else if (match[2]) {
        const token = parseSlashToken(match[2]);
        result.push({ type: token.type, content: token.name });
      } else if (match[3]) {
        result.push({ type: "role", content: match[3] });
      } else if (match[4]) {
        // /[commandname] format (for user input display)
        result.push({ type: "command", content: match[4] });
      } else if (match[5]) {
        const people = match[5].split(',').map(p => p.trim());
        result.push({ type: "mentioned", content: match[5], people });
      } else if (match[6]) {
        result.push({ type: "role", content: match[6] });
      } else if (match[7]) {
        // [File: filepath] format (sent to LLM)
        result.push({ type: "file", content: match[7] });
      } else if (match[8]) {
        // [Skill: skillname] format (sent to LLM)
        result.push({ type: "skill", content: match[8] });
      } else if (match[9]) {
        // [Command: commandname] format (sent to LLM)
        result.push({ type: "command", content: match[9] });
      } else if (match[10]) {
        result.push({ type: "directory", content: match[10] });
      } else if (match[11]) {
        const dataUrl = match[12] && match[12].startsWith("data:") ? match[12] : undefined;
        result.push({ type: "image", content: match[11], dataUrl });
      } else if (match[13]) {
        // Parse the parenthesised info: may contain path:..., size:...
        const info = match[14] ?? "";
        const pathMatch = info.match(/path:\s*([^,)]+)/);
        const sizeMatch = info.match(/size:\s*([^,)]+)/);
        const fullPath = pathMatch ? pathMatch[1].trim() : undefined;
        const size = sizeMatch ? sizeMatch[1].trim() : (!pathMatch && info.trim() ? info.trim() : undefined);
        result.push({ type: "attachment", content: match[13], size, fullPath });
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < displayContent.length) {
      const text = displayContent.slice(lastIndex);
      if (text) {
        result.push({ type: "text", content: text });
      }
    }

    return result;
  }, [displayContent]);

  const isSimpleText = parts.length === 0 || (parts.length === 1 && parts[0].type === "text");

  // Build the inner content - render parts in order
  const innerContent = isSimpleText ? (
    <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{displayContent}</div>
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
          const attachmentPath = part.fullPath ?? part.content;
          if (attachmentPath && isImagePath(attachmentPath)) {
            return (
              <div key={index} className="inline-block my-2">
                <LocalImageCard
                  src={resolveImagePath(attachmentPath, basePath)}
                  alt={part.content}
                />
              </div>
            );
          }

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
              "inline-flex items-center gap-1.5 px-2.5 py-1 mx-0.5 rounded-md border text-xs font-medium",
              (part.type === "file" || part.type === "filemention") && "bg-[#edf2f7] border-[#d8e1ea] text-[#5a7086] dark:bg-[#202a34] dark:border-[#31404d] dark:text-[#aec3d6]",
              part.type === "directory" && "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
              part.type === "role" && "bg-[#eef3f5] border-[#d8e2e7] text-[#5b7080] dark:bg-[#222d33] dark:border-[#334149] dark:text-[#b8cad3]",
              part.type === "skill" && "bg-[#f3efe6] border-[#e5dccb] text-[#7a6a52] dark:bg-[#302b22] dark:border-[#443b2d] dark:text-[#d3c5ac]",
              part.type === "command" && "bg-[#f1ebf3] border-[#ddd2e2] text-[#75607c] dark:bg-[#2f2632] dark:border-[#433647] dark:text-[#ccbcd2]",
            )}
          >
            {(part.type === "file" || part.type === "filemention") && <FileText className="h-3 w-3" />}
            {part.type === "directory" && <Folder className="h-3 w-3" />}
            {part.type === "role" && <UserRound className="h-3 w-3" />}
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
            className="absolute bottom-0 left-0 right-0 h-16 pointer-events-none bg-gradient-to-t from-[#e8edf2] to-transparent dark:from-[#ffffff1a]"
          />
        )}
      </div>

      {/* Expand / collapse toggle */}
      {needsCollapse && (
        <button
          onClick={() => setIsExpanded((v) => !v)}
          className="flex items-center gap-1 mt-1.5 text-xs text-[#66727d] hover:text-[#1f2933] dark:text-[#c9d3db] dark:hover:text-[#f5f8fb] transition-colors cursor-pointer"
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
