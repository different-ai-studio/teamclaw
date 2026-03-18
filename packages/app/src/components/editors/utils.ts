/**
 * Editor type routing utilities.
 * Determines which editor to use based on file extension.
 */

export type EditorType = 'markdown' | 'code';

/**
 * Determine which editor type to use for a given filename.
 * HTML files are routed to the code editor (with optional preview via supportsPreview).
 */
export function getEditorType(filename: string): EditorType {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return 'code';
}

/**
 * Get the programming language identifier from a filename for syntax highlighting.
 */
export function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    sql: 'sql',
    graphql: 'graphql',
    toml: 'toml',
    ini: 'ini',
    dockerfile: 'dockerfile',
  };
  return languageMap[ext || ''] || 'plaintext';
}

/**
 * Check if file supports preview (HTML or Markdown).
 */
export function supportsPreview(filename: string): 'html' | 'markdown' | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}
