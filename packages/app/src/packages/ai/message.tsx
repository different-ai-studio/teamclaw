import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { readFile } from "@tauri-apps/plugin-fs"
import { Download, X } from "lucide-react"

import { cn, isTauri } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1]
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

async function downloadImage(dataUrl: string, filename: string) {
  if (isTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog")
      const { writeFile } = await import("@tauri-apps/plugin-fs")
      const { downloadDir } = await import("@tauri-apps/api/path")

      const ext = filename.split(".").pop()?.toLowerCase() || "png"
      const filterName = ext.toUpperCase() + " Image"
      const downloads = await downloadDir()
      const dest = await save({
        title: "保存图片",
        defaultPath: `${downloads}/${filename}`,
        filters: [{ name: filterName, extensions: [ext] }],
      })
      if (!dest) return

      const bytes = dataUrlToUint8Array(dataUrl)
      await writeFile(dest, bytes)
    } catch (err) {
      console.error("[Image] Failed to save image:", err)
    }
  } else {
    const a = document.createElement("a")
    a.href = dataUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
}

type MessageFrom = "user" | "assistant"

interface MessageContextValue {
  from: MessageFrom
  basePath?: string  // Base path for resolving relative image paths
}

const MessageContext = React.createContext<MessageContextValue | null>(null)

function useMessageContext() {
  const context = React.useContext(MessageContext)
  if (!context) {
    throw new Error("Message components must be used within <Message />")
  }
  return context
}

export function Message({
  from,
  basePath,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & { from: MessageFrom; basePath?: string }) {
  return (
    <MessageContext.Provider value={{ from, basePath }}>
      <div
        className={cn("flex", from === "user" ? "justify-end" : "justify-start", className)}
        {...props}
      >
        {children}
      </div>
    </MessageContext.Provider>
  )
}

export function MessageContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { from } = useMessageContext()
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-2xl px-4 py-3 text-sm overflow-hidden break-words [overflow-wrap:anywhere] min-w-0",
        from === "user" ? "bg-[#6f8c8a] text-white" : "bg-transparent",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// Helper to resolve local image path
export function resolveImagePath(src: string, basePath?: string): string {
  // If it's already a data URL or http(s) URL, return as-is
  if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
    return src
  }
  
  // If it's an absolute path starting with /
  if (src.startsWith('/')) {
    return src
  }
  
  // If we have a basePath and this is a relative path
  if (basePath) {
    return `${basePath}/${src}`.replace(/\/+/g, '/')
  }
  
  // Return original src if we can't resolve it
  return src
}

// Get MIME type from file extension
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  return mimeTypes[ext] || 'image/png'
}

// Component to load and display local image files with click-to-enlarge
export function LocalImage({ src, alt, className, onError: onErrorCallback, onLoad: onLoadCallback }: { src: string; alt?: string; className?: string; onError?: () => void; onLoad?: () => void }) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [isOpen, setIsOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    
    async function loadImage() {
      // If it's already a data URL or remote URL, use directly
      if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
        setDataUrl(src)
        setLoading(false)
        return
      }
      
      try {
        // Read file as binary and convert to base64
        const data = await readFile(src)
        if (cancelled) return
        
        // Convert Uint8Array to base64
        const base64 = btoa(
          Array.from(data).map(byte => String.fromCharCode(byte)).join('')
        )
        const mimeType = getMimeType(src)
        setDataUrl(`data:${mimeType};base64,${base64}`)
        setLoading(false)
        onLoadCallback?.()
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load image:', src, err)
        setError(true)
        setLoading(false)
        onErrorCallback?.()
      }
    }
    
    loadImage()
    return () => { cancelled = true }
  }, [src, onErrorCallback])

  if (error) return null
  if (loading) {
    return (
      <div className={cn("flex items-center justify-center bg-muted/30 rounded-lg", className)}>
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }
  if (!dataUrl) return null

  return (
    <>
      <img 
        src={dataUrl} 
        alt={alt || 'Image'} 
        className={cn(className, "cursor-pointer hover:opacity-90 transition-opacity")}
        onClick={() => setIsOpen(true)}
        title="点击查看大图"
      />
      
      {/* Image preview dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent 
          className="!max-w-[95vw] max-h-[95vh] w-auto h-auto p-0 overflow-hidden bg-transparent border-0 shadow-none rounded-none gap-0"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{alt || '图片预览'}</DialogTitle>
          <div className="absolute right-2 top-2 z-50 flex items-center gap-1.5">
            <button
              onClick={() => {
                const filename = alt || src.split("/").pop() || "image.png"
                downloadImage(dataUrl, filename)
              }}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
              title="下载图片"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <img 
            src={dataUrl} 
            alt={alt || 'Image'} 
            className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg"
          />
          {alt && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1.5 text-center text-xs text-white/90 rounded-b-lg">
              {alt}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// Extract inline image references from text (e.g., "filename.png" mentioned in text)
function extractInlineImageReferences(text: string): string[] {
  // Match filenames that look like images: word characters, dots, ending with image extension
  // Be careful not to match too broadly
  const imagePattern = /\b([\w.-]+\.(?:png|jpg|jpeg|gif|webp|svg))\b/gi
  const matches: string[] = []
  let match
  while ((match = imagePattern.exec(text)) !== null) {
    matches.push(match[1])
  }
  return [...new Set(matches)]  // Deduplicate
}

// Parse message content and extract images and attachments
type MessagePart = { type: 'text' | 'image' | 'attachment'; content: string; name?: string; size?: string }

function parseMessageContent(content: string, isUserMessage: boolean = false): MessagePart[] {
  const parts: MessagePart[] = []
  
  if (isUserMessage) {
    // Combined pattern for images and attachments
    // [Image: filename]\ndata:image/... OR [Attachment: filename] (size) OR [File: filename]\n```...```
    const combinedPattern = /\[Image: ([^\]]+)\]\n(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)|\[Attachment: ([^\]]+)\] \(([^)]+)\)|\[File: ([^\]]+)\]\n```[\s\S]*?```/g
    
    let lastIndex = 0
    let match
    
    while ((match = combinedPattern.exec(content)) !== null) {
      // Add text before this match
      if (match.index > lastIndex) {
        const textBefore = content.slice(lastIndex, match.index).trim()
        if (textBefore) {
          parts.push({ type: 'text', content: textBefore })
        }
      }
      
      if (match[1] && match[2]) {
        // Image match
        parts.push({ type: 'image', content: match[2], name: match[1] })
      } else if (match[3] && match[4]) {
        // Attachment match (binary file)
        parts.push({ type: 'attachment', content: '', name: match[3], size: match[4] })
      } else if (match[5]) {
        // File match (text file with content) - show as attachment thumbnail
        parts.push({ type: 'attachment', content: '', name: match[5], size: '' })
      }
      
      lastIndex = match.index + match[0].length
    }
    
    // Add remaining text
    if (lastIndex < content.length) {
      const remaining = content.slice(lastIndex).trim()
      if (remaining) {
        parts.push({ type: 'text', content: remaining })
      }
    }
  } else {
    // For assistant messages: strip out any base64 data URLs that got echoed
    // This prevents showing raw base64 strings in the response
    let cleanedContent = content
    
    // Remove [Image: filename]\ndata:image/... patterns
    cleanedContent = cleanedContent.replace(/\[Image: [^\]]+\]\n?data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '')
    
    // Remove standalone data:image/... URLs (including those in markdown/text)
    cleanedContent = cleanedContent.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
    
    // Clean up any leftover empty lines or formatting artifacts
    cleanedContent = cleanedContent.replace(/\n{3,}/g, '\n\n').trim()
    
    if (cleanedContent) {
      parts.push({ type: 'text', content: cleanedContent })
    }
  }
  
  // If no parts found, return the whole content as text
  if (parts.length === 0) {
    parts.push({ type: 'text', content })
  }
  
  return parts
}

// Get file icon based on file extension
function getFileIconName(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const iconMap: Record<string, string> = {
    // Spreadsheets
    xlsx: '📊', xls: '📊', csv: '📊',
    // Documents
    pdf: '📄', doc: '📄', docx: '📄',
    // Archives
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    // Code
    js: '📜', ts: '📜', py: '📜', java: '📜', cpp: '📜', c: '📜',
    // Config
    json: '⚙️', yaml: '⚙️', yml: '⚙️', xml: '⚙️',
    // Text
    txt: '📝', md: '📝', log: '📝',
  }
  return iconMap[ext] || '📎'
}

// Clickable image component with preview dialog (for already loaded images like base64)
export function ClickableImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const [isOpen, setIsOpen] = React.useState(false)

  return (
    <>
      <img 
        src={src} 
        alt={alt || 'Image'} 
        className={cn(className, "cursor-pointer hover:opacity-90 transition-opacity")}
        onClick={() => setIsOpen(true)}
        title="点击查看大图"
      />
      
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent 
          className="!max-w-[95vw] max-h-[95vh] w-auto h-auto p-0 overflow-hidden bg-transparent border-0 shadow-none rounded-none gap-0"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{alt || '图片预览'}</DialogTitle>
          <div className="absolute right-2 top-2 z-50 flex items-center gap-1.5">
            <button
              onClick={() => {
                const filename = alt || src.split("/").pop() || "image.png"
                downloadImage(src, filename)
              }}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
              title="下载图片"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <img 
            src={src} 
            alt={alt || 'Image'} 
            className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg"
          />
          {alt && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-3 py-1.5 text-center text-xs text-white/90 rounded-b-lg">
              {alt}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function MessageResponse({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { from, basePath } = useMessageContext()
  const isUserMessage = from === "user"
  
  // Parse content to detect/clean images and attachments
  const content = typeof children === "string" ? children : ""
  const parsedParts = parseMessageContent(content, isUserMessage)
  const hasMediaParts = parsedParts.some(p => p.type === 'image' || p.type === 'attachment')
  const inlineImages = React.useMemo(() => {
    const allText = parsedParts.filter(p => p.type === 'text').map(p => p.content).join(' ')
    return extractInlineImageReferences(allText)
  }, [parsedParts])

  if (from === "user") {
    // For user messages with images or attachments, render them properly
    if (hasMediaParts) {
      return (
        <div className={cn("space-y-2", className)} {...props}>
          {parsedParts.map((part, index) => {
            if (part.type === 'image') {
              return (
                <div key={index} className="rounded-lg overflow-hidden">
                  <ClickableImage 
                    src={part.content} 
                    alt={part.name || 'Attached image'} 
                    className="max-w-full max-h-64 object-contain rounded-lg"
                  />
                </div>
              )
            } else if (part.type === 'attachment') {
              return (
                <div 
                  key={index} 
                  className="inline-flex items-center gap-2 rounded-lg bg-white/20 px-3 py-2 text-sm"
                >
                  <span className="text-lg">{getFileIconName(part.name || '')}</span>
                  <div className="flex flex-col">
                    <span className="font-medium">{part.name}</span>
                    {part.size && <span className="text-xs opacity-80">{part.size}</span>}
                  </div>
                </div>
              )
            } else {
              return (
                <div key={index} className="whitespace-pre-wrap break-words">
                  {part.content}
                </div>
              )
            }
          })}
        </div>
      )
    }
    
    return (
      <div className={cn("whitespace-pre-wrap break-words", className)} {...props}>
        {children}
      </div>
    )
  }

  // For assistant messages, render images and text separately
  return (
    <div className={cn("space-y-2", className)} {...props}>
      {parsedParts.map((part, index) => (
        part.type === 'image' ? (
          <div key={index} className="rounded-lg overflow-hidden">
            <ClickableImage 
              src={part.content} 
              alt={part.name || 'Image'} 
              className="max-w-full max-h-80 object-contain rounded-lg border"
            />
          </div>
        ) : (
          <div key={index} className="prose prose-sm max-w-none text-foreground space-y-3 break-words [overflow-wrap:anywhere]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h1 className="text-xl font-semibold text-foreground mt-4 mb-2">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-lg font-semibold text-foreground mt-3 mb-2">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-base font-semibold text-foreground mt-3 mb-1.5">{children}</h3>
                ),
                p: ({ children }) => <p className="leading-relaxed text-foreground my-2">{children}</p>,
                table: ({ children }) => (
                  <div className="overflow-x-auto rounded-lg border border-border my-3">
                    <table className="min-w-full border-collapse text-sm">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
                th: ({ children }) => (
                  <th className="border-b border-border px-4 py-2.5 text-left font-medium">
                    {children}
                  </th>
                ),
                tr: ({ children }) => (
                  <tr className="border-b border-border last:border-b-0">{children}</tr>
                ),
                td: ({ children }) => <td className="px-4 py-2.5">{children}</td>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-4 border-[#5a7a64] pl-4 my-3 italic text-muted-foreground">
                    {children}
                  </blockquote>
                ),
                code: ({ className, children, ...codeProps }) => {
                  const isInline = !className
                  return isInline ? (
                    <code
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-[#4a6a54]"
                      {...codeProps}
                    >
                      {children}
                    </code>
                  ) : (
                    <code
                      className={cn(
                        "block rounded-lg bg-muted p-3 text-xs text-foreground my-2",
                        className
                      )}
                      {...codeProps}
                    >
                      {children}
                    </code>
                  )
                },
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#5a7a64] hover:underline"
                  >
                    {children}
                  </a>
                ),
                ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                // Handle images in markdown with local path resolution
                img: ({ src, alt }) => {
                  const resolvedSrc = resolveImagePath(src || '', basePath)
                  // If it's a local path, use LocalImage component (with click-to-enlarge)
                  if (resolvedSrc.startsWith('/')) {
                    return (
                      <LocalImage 
                        src={resolvedSrc} 
                        alt={alt || 'Image'} 
                        className="max-w-full max-h-80 object-contain rounded-lg border my-2"
                      />
                    )
                  }
                  // Otherwise use ClickableImage for remote URLs
                  return (
                    <ClickableImage 
                      src={resolvedSrc} 
                      alt={alt || 'Image'} 
                      className="max-w-full max-h-80 object-contain rounded-lg border my-2"
                    />
                  )
                },
              }}
            >
              {part.content}
            </ReactMarkdown>
          </div>
        )
      ))}
      
      {/* Render inline image references found in text */}
      {inlineImages.length > 0 && basePath && (
        <div className="flex flex-wrap gap-2 mt-3">
          {inlineImages.map((imageName, index) => (
            <InlineImageCard
              key={index}
              imageName={imageName}
              basePath={basePath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function InlineImageCard({ imageName, basePath }: { imageName: string; basePath: string }) {
  const [failed, setFailed] = React.useState(false)
  const [imageDataUrl, setImageDataUrl] = React.useState<string | null>(null)
  const imageSrc = resolveImagePath(imageName, basePath)

  if (failed) return null

  return (
    <div className="w-28 rounded-lg overflow-hidden border bg-muted/30 flex flex-col group relative">
      <div className="w-28 h-20 flex items-center justify-center overflow-hidden bg-muted/20 relative">
        <LocalImage
          src={imageSrc}
          alt={imageName}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
          onLoad={() => {
            async function loadForDownload() {
              try {
                if (imageSrc.startsWith('data:') || imageSrc.startsWith('http')) {
                  setImageDataUrl(imageSrc)
                  return
                }
                const data = await readFile(imageSrc)
                const base64 = btoa(
                  Array.from(data).map(byte => String.fromCharCode(byte)).join('')
                )
                const mimeType = getMimeType(imageSrc)
                setImageDataUrl(`data:${mimeType};base64,${base64}`)
              } catch { /* ignore */ }
            }
            loadForDownload()
          }}
        />
        {imageDataUrl && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              downloadImage(imageDataUrl, imageName)
            }}
            className="absolute bottom-1 right-1 rounded-full bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
            title="下载图片"
          >
            <Download className="h-3 w-3" />
          </button>
        )}
      </div>
      {!failed && (
        <div className="px-1.5 py-1 text-[10px] text-muted-foreground truncate">
          {imageName}
        </div>
      )}
    </div>
  )
}

export function MessageBranch({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {children}
    </div>
  )
}

export function MessageBranchContent({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      {children}
    </div>
  )
}

export function MessageBranchSelector({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex items-center justify-center gap-2 text-xs", className)} {...props}>
      {children}
    </div>
  )
}

export function MessageBranchPrevious(props: React.ComponentProps<"button">) {
  return (
    <button className="text-muted-foreground hover:text-foreground" {...props}>
      Prev
    </button>
  )
}

export function MessageBranchNext(props: React.ComponentProps<"button">) {
  return (
    <button className="text-muted-foreground hover:text-foreground" {...props}>
      Next
    </button>
  )
}

export function MessageBranchPage({
  children = "1 / 1",
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span className="text-muted-foreground" {...props}>
      {children}
    </span>
  )
}
