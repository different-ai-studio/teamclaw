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
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none text-text-primary space-y-4 break-words [overflow-wrap:anywhere]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Headings
                h1: ({ children }) => (
                  <h1 className="text-xl font-bold mt-6 mb-3 text-text-primary first:mt-0">{children}</h1>
                ),
                h2: ({ children }) => (
                  <h2 className="text-lg font-bold mt-6 mb-3 text-text-primary first:mt-0">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-base font-semibold mt-5 mb-2 text-text-primary first:mt-0">{children}</h3>
                ),
                // Paragraphs
                p: ({ children }) => (
                  <p className="mb-4 text-text-primary leading-relaxed">{children}</p>
                ),
                // Strong/Bold
                strong: ({ children }) => (
                  <strong className="font-semibold text-text-primary">{children}</strong>
                ),
                // Custom table styling
                table: ({ children }) => (
                  <div className="overflow-x-auto my-5 rounded-lg border border-border">
                    <table className="min-w-full border-collapse text-sm">
                      {children}
                    </table>
                  </div>
                ),
                thead: ({ children }) => (
                  <thead className="bg-bg-tertiary">{children}</thead>
                ),
                th: ({ children }) => (
                  <th className="border-b border-border px-4 py-3 text-left font-semibold text-text-primary">
                    {children}
                  </th>
                ),
                tr: ({ children }) => (
                  <tr className="border-b border-border last:border-b-0">{children}</tr>
                ),
                td: ({ children }) => (
                  <td className="px-4 py-3 text-text-primary">{children}</td>
                ),
                // Blockquote
                blockquote: ({ children }) => (
                  <blockquote className="border-l-4 border-accent-green pl-4 my-4 text-text-secondary italic">
                    {children}
                  </blockquote>
                ),
                // Code blocks
                pre: ({ children }) => (
                  <pre className="my-4 bg-bg-tertiary rounded-lg overflow-x-auto">
                    {children}
                  </pre>
                ),
                code: ({ className, children, ...props }) => {
                  const isInline = !className
                  return isInline ? (
                    <code
                      className="bg-bg-tertiary px-1.5 py-0.5 rounded text-accent-green-dark text-sm font-mono"
                      {...props}
                    >
                      {children}
                    </code>
                  ) : (
                    <code
                      className={cn('block p-4 font-mono text-sm leading-relaxed', className)}
                      {...props}
                    >
                      {children}
                    </code>
                  )
                },
                // Lists
                ul: ({ children }) => (
                  <ul className="list-disc pl-5 mb-4 space-y-2">{children}</ul>
                ),
                ol: ({ children }) => (
                  <ol className="list-decimal pl-5 mb-4 space-y-2">{children}</ol>
                ),
                li: ({ children }) => (
                  <li className="text-text-primary leading-relaxed">{children}</li>
                ),
                // Links
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-green hover:underline"
                  >
                    {children}
                  </a>
                ),
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
