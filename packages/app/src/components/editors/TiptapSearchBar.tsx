/**
 * TiptapSearchBar – Ctrl+F search & replace overlay for Tiptap editors.
 *
 * Uses ProseMirror's TextSelection + decorations to highlight matches,
 * styled with the project's shadcn/ui design tokens.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from "react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Extension } from "@tiptap/core";
import {
  Search,
  Replace,
  ChevronUp,
  ChevronDown,
  X,
  CaseSensitive,
  Regex,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  ProseMirror plugin – decorates search matches                      */
/* ------------------------------------------------------------------ */

export const searchPluginKey = new PluginKey("tiptapSearch");

interface SearchState {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  /** Flat list of {from, to} positions for every match */
  matches: { from: number; to: number }[];
  /** Index into `matches` for the currently focused match */
  activeIndex: number;
}

const EMPTY_STATE: SearchState = {
  query: "",
  caseSensitive: false,
  useRegex: false,
  matches: [],
  activeIndex: -1,
};

function findMatches(
  _doc: string,
  state: { query: string; caseSensitive: boolean; useRegex: boolean },
  pmDoc: import("@tiptap/pm/model").Node,
): { from: number; to: number }[] {
  if (!state.query) return [];

  const results: { from: number; to: number }[] = [];

  // Build the regex
  let regex: RegExp;
  try {
    const flags = state.caseSensitive ? "g" : "gi";
    const pattern = state.useRegex
      ? state.query
      : state.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(pattern, flags);
  } catch {
    return []; // Invalid regex – return no matches
  }

  // Walk text nodes
  pmDoc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(node.text)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      results.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
  });

  return results;
}

export const SearchHighlightExtension = Extension.create({
  name: "searchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchPluginKey,
        state: {
          init() {
            return EMPTY_STATE;
          },
          apply(tr, prev) {
            const meta = tr.getMeta(searchPluginKey) as Partial<SearchState> | undefined;
            if (meta) {
              return { ...prev, ...meta };
            }
            // If the document changed, recompute matches
            if (tr.docChanged && prev.query) {
              const matches = findMatches(
                tr.doc.textContent,
                prev,
                tr.doc,
              );
              const activeIndex =
                prev.activeIndex >= matches.length
                  ? matches.length - 1
                  : prev.activeIndex;
              return { ...prev, matches, activeIndex };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            const pluginState = searchPluginKey.getState(state) as SearchState;
            if (!pluginState || pluginState.matches.length === 0)
              return DecorationSet.empty;

            const decorations = pluginState.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class:
                  i === pluginState.activeIndex
                    ? "tiptap-search-active"
                    : "tiptap-search-match",
              }),
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/* ------------------------------------------------------------------ */
/*  React search bar component                                         */
/* ------------------------------------------------------------------ */

/** Safely check if the editor view is mounted (Tiptap throws from the getter if not). */
function isViewReady(editor: import("@tiptap/core").Editor | null): boolean {
  if (!editor) return false;
  try {
    // Access the getter — if it throws, the view isn't ready
    return !!editor.view?.dom;
  } catch {
    return false;
  }
}

interface TiptapSearchBarProps {
  editor: import("@tiptap/core").Editor | null;
}

export function TiptapSearchBar({ editor }: TiptapSearchBarProps) {
  const [open, setOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Dispatch search state to ProseMirror plugin
  const dispatchSearch = useCallback(
    (
      q: string,
      cs: boolean,
      re: boolean,
      idx?: number,
    ) => {
      if (!isViewReady(editor)) return;
      const matches = findMatches(
        editor!.state.doc.textContent,
        { query: q, caseSensitive: cs, useRegex: re },
        editor!.state.doc,
      );
      const ai = idx !== undefined ? idx : matches.length > 0 ? 0 : -1;
      setMatchCount(matches.length);
      setActiveIndex(ai);

      editor!.view.dispatch(
        editor!.state.tr.setMeta(searchPluginKey, {
          query: q,
          caseSensitive: cs,
          useRegex: re,
          matches,
          activeIndex: ai,
        } satisfies SearchState),
      );

      // Scroll to active match
      if (matches.length > 0 && ai >= 0 && ai < matches.length) {
        const match = matches[ai];
        editor!.commands.setTextSelection(match.from);
        editor!.commands.scrollIntoView();
      }
    },
    [editor],
  );

  // Clear search decorations
  const clearSearch = useCallback(() => {
    if (!isViewReady(editor)) return;
    editor!.view.dispatch(
      editor!.state.tr.setMeta(searchPluginKey, EMPTY_STATE),
    );
    setMatchCount(0);
    setActiveIndex(-1);
  }, [editor]);

  // Open search bar
  const openSearch = useCallback(() => {
    setOpen(true);
    // If there's a text selection, use it as the query
    if (isViewReady(editor)) {
      const { from, to } = editor!.state.selection;
      if (from !== to) {
        const text = editor!.state.doc.textBetween(from, to, " ");
        if (text && text.length < 200) {
          setQuery(text);
          // Defer dispatch so component is mounted
          setTimeout(() => dispatchSearch(text, caseSensitive, useRegex), 0);
        }
      }
    }
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [editor, caseSensitive, useRegex, dispatchSearch]);

  // Close search bar
  const closeSearch = useCallback(() => {
    setOpen(false);
    setShowReplace(false);
    clearSearch();
    editor?.commands.focus();
  }, [clearSearch, editor]);

  // Navigate matches
  const goNext = useCallback(() => {
    if (matchCount === 0) return;
    const next = (activeIndex + 1) % matchCount;
    dispatchSearch(query, caseSensitive, useRegex, next);
  }, [activeIndex, matchCount, query, caseSensitive, useRegex, dispatchSearch]);

  const goPrev = useCallback(() => {
    if (matchCount === 0) return;
    const prev = (activeIndex - 1 + matchCount) % matchCount;
    dispatchSearch(query, caseSensitive, useRegex, prev);
  }, [activeIndex, matchCount, query, caseSensitive, useRegex, dispatchSearch]);

  // Replace current match
  const replaceCurrent = useCallback(() => {
    if (!editor || activeIndex < 0) return;
    const pluginState = searchPluginKey.getState(editor.state) as SearchState | undefined;
    if (!pluginState || activeIndex >= pluginState.matches.length) return;

    const match = pluginState.matches[activeIndex];
    editor
      .chain()
      .focus()
      .insertContentAt({ from: match.from, to: match.to }, replaceText)
      .run();

    // Re-run search after replace
    setTimeout(() => {
      dispatchSearch(query, caseSensitive, useRegex, activeIndex);
    }, 0);
  }, [editor, activeIndex, replaceText, query, caseSensitive, useRegex, dispatchSearch]);

  // Replace all
  const replaceAll = useCallback(() => {
    if (!isViewReady(editor)) return;
    const pluginState = searchPluginKey.getState(editor!.state) as SearchState | undefined;
    if (!pluginState || pluginState.matches.length === 0) return;

    // Replace from end to start to preserve positions
    const { tr } = editor!.state;
    const sortedMatches = [...pluginState.matches].reverse();
    for (const match of sortedMatches) {
      tr.replaceWith(match.from, match.to, replaceText ? editor!.state.schema.text(replaceText) : editor!.state.schema.text(""));
    }
    editor!.view.dispatch(tr);

    // Re-run search (should find 0 matches now)
    setTimeout(() => {
      dispatchSearch(query, caseSensitive, useRegex);
    }, 0);
  }, [editor, replaceText, query, caseSensitive, useRegex, dispatchSearch]);

  // Listen for Ctrl/Cmd + F on the editor
  useEffect(() => {
    if (!isViewReady(editor)) return;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      }
      if (mod && e.key === "h") {
        e.preventDefault();
        e.stopPropagation();
        setShowReplace(true);
        openSearch();
      }
    };

    const dom = editor!.view.dom;
    dom.addEventListener("keydown", handleKeyDown);
    return () => dom.removeEventListener("keydown", handleKeyDown);
  }, [editor, openSearch]);

  // Search input key handling
  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  const handleReplaceKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      closeSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      replaceCurrent();
    }
  };

  // Update search when query/options change
  useEffect(() => {
    if (open && query) {
      dispatchSearch(query, caseSensitive, useRegex);
    } else if (open && !query) {
      clearSearch();
    }
  }, [query, caseSensitive, useRegex, open, dispatchSearch, clearSearch]);

  if (!open) return null;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 border-b bg-muted/50 text-xs shrink-0">
      {/* Find row */}
      <div className="flex items-center gap-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Find"
          className="h-7 min-w-[180px] flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]"
        />
        {/* Option toggles */}
        <button
          title="Match case"
          onClick={() => setCaseSensitive(!caseSensitive)}
          className={cn(
            "h-7 w-7 flex items-center justify-center rounded-md border transition-colors",
            caseSensitive
              ? "border-primary bg-primary/10 text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
        </button>
        <button
          title="Use regex"
          onClick={() => setUseRegex(!useRegex)}
          className={cn(
            "h-7 w-7 flex items-center justify-center rounded-md border transition-colors",
            useRegex
              ? "border-primary bg-primary/10 text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <Regex className="h-3.5 w-3.5" />
        </button>
        {/* Match count */}
        <span className="text-muted-foreground min-w-[60px] text-center tabular-nums">
          {query
            ? matchCount > 0
              ? `${activeIndex + 1} / ${matchCount}`
              : "No results"
            : ""}
        </span>
        {/* Navigation */}
        <button
          title="Previous (Shift+Enter)"
          onClick={goPrev}
          disabled={matchCount === 0}
          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          title="Next (Enter)"
          onClick={goNext}
          disabled={matchCount === 0}
          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {/* Toggle replace */}
        <button
          title="Toggle replace"
          onClick={() => setShowReplace(!showReplace)}
          className={cn(
            "h-7 w-7 flex items-center justify-center rounded-md transition-colors",
            showReplace
              ? "text-foreground bg-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <Replace className="h-3.5 w-3.5" />
        </button>
        {/* Close */}
        <button
          title="Close (Escape)"
          onClick={closeSearch}
          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div className="flex items-center gap-1.5">
          <Replace className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="Replace"
            className="h-7 min-w-[180px] flex-1 rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[2px]"
          />
          <button
            title="Replace (Enter)"
            onClick={replaceCurrent}
            disabled={matchCount === 0}
            className="h-7 px-2.5 rounded-md border border-input bg-background text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
          >
            Replace
          </button>
          <button
            title="Replace all"
            onClick={replaceAll}
            disabled={matchCount === 0}
            className="h-7 px-2.5 rounded-md border border-input bg-background text-foreground hover:bg-muted disabled:opacity-30 disabled:pointer-events-none"
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}
