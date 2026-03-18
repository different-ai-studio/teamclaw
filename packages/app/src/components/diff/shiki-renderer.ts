/**
 * ShikiRenderer - Syntax highlighting using Shiki.
 * 
 * Provides lazy-loaded, cached Shiki highlighter for diff rendering.
 */

import type { BundledLanguage, BundledTheme, HighlighterGeneric } from 'shiki';

let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;

/**
 * Get or create a shared Shiki highlighter instance.
 * Lazy loads on first use.
 */
async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [
          'typescript', 'javascript', 'python', 'json', 'yaml', 'css',
          'html', 'xml', 'sql', 'shell', 'markdown', 'rust', 'go',
          'java', 'c', 'cpp',
        ],
      }),
    );
  }
  return highlighterPromise;
}

/**
 * Map common language identifiers to Shiki language identifiers.
 */
function mapLanguage(lang: string): BundledLanguage {
  const map: Record<string, BundledLanguage> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    rs: 'rust',
    md: 'markdown',
    dockerfile: 'shell',
  };
  return (map[lang] || lang) as BundledLanguage;
}

export interface HighlightedToken {
  content: string;
  color: string;
}

/**
 * Highlight a single line of code using Shiki.
 * Returns an array of tokens with color information.
 */
export async function highlightLine(
  code: string,
  language: string,
  isDark: boolean,
): Promise<HighlightedToken[]> {
  try {
    const highlighter = await getHighlighter();
    const theme = isDark ? 'github-dark' : 'github-light';
    const lang = mapLanguage(language);

    const result = highlighter.codeToTokens(code, {
      lang,
      theme,
    });

    if (result.tokens.length > 0) {
      return result.tokens[0].map((token) => ({
        content: token.content,
        color: token.color || (isDark ? '#e1e4e8' : '#24292e'),
      }));
    }

    return [{ content: code, color: isDark ? '#e1e4e8' : '#24292e' }];
  } catch {
    // Fallback: return plain text
    return [{ content: code, color: isDark ? '#e1e4e8' : '#24292e' }];
  }
}

/**
 * Highlight multiple lines of code using Shiki.
 * More efficient than calling highlightLine for each line.
 */
export async function highlightLines(
  lines: string[],
  language: string,
  isDark: boolean,
): Promise<HighlightedToken[][]> {
  try {
    const highlighter = await getHighlighter();
    const theme = isDark ? 'github-dark' : 'github-light';
    const lang = mapLanguage(language);
    const code = lines.join('\n');

    const result = highlighter.codeToTokens(code, {
      lang,
      theme,
    });

    return result.tokens.map((lineTokens) =>
      lineTokens.map((token) => ({
        content: token.content,
        color: token.color || (isDark ? '#e1e4e8' : '#24292e'),
      })),
    );
  } catch {
    return lines.map((line) => [
      { content: line, color: isDark ? '#e1e4e8' : '#24292e' },
    ]);
  }
}
