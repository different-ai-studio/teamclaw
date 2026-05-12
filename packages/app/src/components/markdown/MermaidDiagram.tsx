import * as React from "react";
import { Maximize2 } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface MermaidDiagramProps {
  source: string;
  className?: string;
  fallback?: React.ReactNode;
}

export function MermaidDiagram({
  source,
  className,
  fallback,
}: MermaidDiagramProps) {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [hasError, setHasError] = React.useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const diagramId = React.useId().replace(/:/g, "");
  const diagramSource = React.useMemo(() => source.trim(), [source]);

  React.useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setHasError(false);

    async function renderDiagram() {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "default",
        });

        const rendered = await mermaid.render(
          `mermaid-${diagramId}`,
          diagramSource,
        );
        if (cancelled) return;

        setSvg(rendered.svg);

        requestAnimationFrame(() => {
          if (cancelled || !containerRef.current) return;
          rendered.bindFunctions?.(containerRef.current);
        });
      } catch (error) {
        if (cancelled) return;
        console.warn("[MermaidDiagram] Render failed, falling back to code block", error);
        setHasError(true);
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [diagramId, diagramSource]);

  if (hasError) {
    return fallback ?? (
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-sm">
        <code>{diagramSource}</code>
      </pre>
    );
  }

  return (
    <>
      <div
        data-testid="mermaid-block"
        className={cn(
          "relative my-2 overflow-x-auto rounded-lg border border-border bg-background px-3 py-3",
          className,
        )}
      >
        {svg ? (
          <>
            <button
              type="button"
              aria-label="放大流程图"
              title="放大流程图"
              onClick={() => setIsPreviewOpen(true)}
              className="absolute right-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/80 bg-background/90 text-muted-foreground opacity-80 shadow-sm backdrop-blur transition hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <div
              ref={containerRef}
              className="[&_svg]:h-auto [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>Rendering Mermaid diagram...</span>
          </div>
        )}
      </div>
      {isPreviewOpen && svg ? (
        <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
          <DialogContent className="max-h-[82vh] w-[92vw] !max-w-[92vw] overflow-hidden p-0">
            <DialogTitle className="sr-only">放大流程图</DialogTitle>
            <div className="max-h-[82vh] overflow-auto bg-background p-4">
              <div
                className="w-max min-w-full [&_svg]:block [&_svg]:h-auto [&_svg]:min-w-[960px] [&_svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default MermaidDiagram;
