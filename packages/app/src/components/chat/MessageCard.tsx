import { cn } from '@/lib/utils'
import { Message } from '@/stores/session'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MessageCardProps {
  message: Message
}

export function MessageCard({ message }: MessageCardProps) {
  const isUser = message.role === 'user'

  return (
    <div
      className={cn(
        'flex',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-3 overflow-hidden break-words [overflow-wrap:anywhere] min-w-0',
          isUser
            ? 'bg-accent-green text-white'
            : 'bg-transparent'
        )}
      >
        {isUser ? (
          <p className="text-[13.5px] leading-[1.5] whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="chat-md max-w-none break-words text-foreground [overflow-wrap:anywhere]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Headings
                h1: ({ children }) => (
                  <h1 className="mt-[1.15em] mb-[0.3em] text-[1.5em] font-bold tracking-[-0.015em] text-foreground first:mt-0">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="mt-[1.1em] mb-[0.25em] text-[1.25em] font-semibold tracking-[-0.01em] text-foreground first:mt-0">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="mt-[1em] mb-[0.2em] text-[1.1em] font-semibold text-foreground first:mt-0">{children}</h3>
                ),
                // Paragraphs
                p: ({ children }) => (
                  <p className="my-[0.4em] leading-[1.5] text-foreground">{children}</p>
                ),
                // Strong/Bold
                strong: ({ children }) => (
                  <strong className="font-semibold text-foreground">{children}</strong>
                ),
                // Custom table styling
                table: ({ children }) => (
                  <div className="my-3 overflow-x-auto">
                    <table className="w-full border-collapse text-[0.92em]">
                      {children}
                    </table>
                  </div>
                ),
                thead: ({ children }) => (
                  <thead>{children}</thead>
                ),
                th: ({ children }) => (
                  <th className="border border-foreground/[0.09] px-2.5 py-1.5 text-left font-semibold text-foreground dark:border-white/[0.12]">
                    {children}
                  </th>
                ),
                tr: ({ children }) => (
                  <tr className="hover:bg-foreground/[0.03] dark:hover:bg-white/[0.04]">{children}</tr>
                ),
                td: ({ children }) => (
                  <td className="border border-foreground/[0.09] px-2.5 py-1.5 text-foreground dark:border-white/[0.12]">{children}</td>
                ),
                // Blockquote
                blockquote: ({ children }) => (
                  <blockquote className="my-2.5 border-l-[3px] border-current pl-3.5 text-muted-foreground not-italic">
                    {children}
                  </blockquote>
                ),
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-[2px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:bg-foreground/[0.06]"
                  >
                    {children}
                  </a>
                ),
                code: ({ className, children }) => {
                  const isInline = !className
                  if (isInline) {
                    return <code className="chat-md-inline-code rounded-[3px] px-[0.3em] py-[0.08em] font-mono text-[0.86em]">{children}</code>
                  }
                  return (
                    <pre className="chat-md-code my-2.5 overflow-x-auto rounded-md p-3.5">
                      <code className="font-mono text-[13.5px] leading-[1.5]">{children}</code>
                    </pre>
                  )
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}
