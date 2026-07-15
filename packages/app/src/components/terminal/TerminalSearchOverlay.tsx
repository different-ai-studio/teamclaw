import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export interface SearchController {
  findNext: (text: string, caseSensitive: boolean) => void;
  findPrevious: (text: string, caseSensitive: boolean) => void;
  clear: () => void;
}

interface Props {
  controller: SearchController;
  onClose: () => void;
}

export function TerminalSearchOverlay({ controller, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (query.length === 0) controller.clear();
    else controller.findNext(query, caseSensitive);
  }, [query, caseSensitive, controller]);

  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-background/95 px-1.5 py-1 shadow-sm backdrop-blur">
      <input
        ref={inputRef}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) controller.findPrevious(query, caseSensitive);
            else controller.findNext(query, caseSensitive);
          }
        }}
        placeholder={t("search.find")}
        className="w-44 bg-transparent px-1 text-[12px] outline-none placeholder:text-faint"
      />
      <button
        type="button"
        onClick={() => controller.findPrevious(query, caseSensitive)}
        title={t("search.previousShiftEnter")}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => controller.findNext(query, caseSensitive)}
        title={t("search.nextEnter")}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setCaseSensitive(v => !v)}
        title={t('terminal.search.caseSensitive', 'Case sensitive')}
        className={cn(
          "rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground",
          caseSensitive && "bg-selected text-foreground",
        )}
      >
        <CaseSensitive className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close (Esc)"
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
