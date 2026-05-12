import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { resolveMarkdownImages } from "@/components/editors/image-paste-handler";
import { MermaidDiagram } from "./MermaidDiagram";

interface MarkdownPreviewProps {
  content: string;
  filePath: string;
  isDark?: boolean;
  className?: string;
}

const remarkPlugins = [remarkGfm];

function MarkdownCodeBlock({
  language,
  children,
}: {
  language: string;
  children: React.ReactNode;
}) {
  const [highlightedHtml, setHighlightedHtml] = React.useState<string | null>(null);
  const code = String(children).replace(/\n$/, "");

  React.useEffect(() => {
    let cancelled = false;

    if (!language || language === "text") {
      setHighlightedHtml(null);
      return () => {
        cancelled = true;
      };
    }

    import("@/components/diff/shiki-renderer").then(
      async ({ getHighlighter, mapLanguage }) => {
        if (cancelled) return;

        try {
          const highlighter = await getHighlighter();
          const isDarkTheme = document.documentElement.classList.contains("dark");
          const theme = isDarkTheme ? "github-dark" : "github-light";
          const lang = mapLanguage(language);
          const html = highlighter.codeToHtml(code, { lang, theme });

          if (!cancelled) {
            setHighlightedHtml(html);
          }
        } catch {
          if (!cancelled) {
            setHighlightedHtml(null);
          }
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <div className="not-prose my-2 w-full overflow-hidden rounded-lg bg-foreground/[0.02] [overflow-wrap:normal]">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-mono text-muted-foreground">{language}</span>
      </div>
      {highlightedHtml ? (
        <div
          className="overflow-x-auto px-3 pb-3 text-sm [overflow-wrap:normal] [&_code]:!bg-transparent [&_code]:!p-0 [&_code]:[overflow-wrap:normal] [&_code]:whitespace-pre [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:[overflow-wrap:normal] [&_pre]:whitespace-pre"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="overflow-x-auto whitespace-pre px-3 pb-3 [overflow-wrap:normal]">
          <code className="font-mono text-sm text-foreground [overflow-wrap:normal]">
            {code}
          </code>
        </pre>
      )}
    </div>
  );
}

const markdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-2 mt-4 text-xl font-semibold text-foreground">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-3 text-lg font-semibold text-foreground">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mb-1.5 mt-3 text-base font-semibold text-foreground">{children}</h3>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-2 min-w-0 leading-relaxed text-foreground">{children}</p>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-muted">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border px-4 py-2.5 text-left font-medium">{children}</th>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="border-b border-border last:border-b-0">{children}</tr>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-4 py-2.5">{children}</td>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 border-l-4 border-[#5a7a64] pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: ({
    className,
    children,
    ...codeProps
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => {
    const codeText = String(children);
    const isInline = !className && !codeText.includes("\n");
    if (isInline) {
      return (
        <code
          className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[0.9em] leading-snug text-foreground break-words [overflow-wrap:anywhere]"
          {...codeProps}
        >
          {children}
        </code>
      );
    }

    const language = className?.replace("language-", "") || "text";
    if (language === "mermaid") {
      return (
        <MermaidDiagram
          source={codeText}
          fallback={<MarkdownCodeBlock language="mermaid">{codeText}</MarkdownCodeBlock>}
        />
      );
    }

    return <MarkdownCodeBlock language={language}>{codeText}</MarkdownCodeBlock>;
  },
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#5a7a64] hover:underline">
      {children}
    </a>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="min-w-0 leading-relaxed">{children}</li>
  ),
} as const;

export function MarkdownPreview({
  content,
  filePath,
  isDark = false,
  className,
}: MarkdownPreviewProps) {
  const [resolvedContent, setResolvedContent] = React.useState(content);

  React.useEffect(() => {
    let cancelled = false;

    async function resolveContent() {
      const resolved = await resolveMarkdownImages(content, filePath);
      if (!cancelled) {
        setResolvedContent(resolved);
      }
    }

    void resolveContent();

    return () => {
      cancelled = true;
    };
  }, [content, filePath]);

  return (
    <div
      data-testid="markdown-preview"
      className={cn(
        "h-full overflow-auto",
        isDark ? "bg-[#1e1e1e]" : "bg-white",
        className,
      )}
    >
      <div className="prose prose-sm max-w-none p-4 text-foreground">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          components={markdownComponents}
        >
          {resolvedContent}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export default MarkdownPreview;
