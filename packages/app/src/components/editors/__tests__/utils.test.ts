import { describe, it, expect } from 'vitest';
import { getEditorType, getLanguageFromFilename, supportsPreview, isSkillFile } from '../utils';

describe('getEditorType', () => {
  it('returns "markdown" for .md files', () => {
    expect(getEditorType('README.md')).toBe('markdown');
    expect(getEditorType('docs/guide.md')).toBe('markdown');
  });

  it('returns "markdown" for .markdown files', () => {
    expect(getEditorType('file.markdown')).toBe('markdown');
  });

  it('returns "code" for .html files (HTML uses code editor + preview)', () => {
    expect(getEditorType('index.html')).toBe('code');
    expect(getEditorType('page.html')).toBe('code');
  });

  it('returns "code" for .htm files', () => {
    expect(getEditorType('page.htm')).toBe('code');
  });

  it('returns "code" for typescript files', () => {
    expect(getEditorType('app.ts')).toBe('code');
    expect(getEditorType('App.tsx')).toBe('code');
  });

  it('returns "code" for javascript files', () => {
    expect(getEditorType('index.js')).toBe('code');
    expect(getEditorType('App.jsx')).toBe('code');
  });

  it('returns "code" for other programming languages', () => {
    expect(getEditorType('main.py')).toBe('code');
    expect(getEditorType('main.rs')).toBe('code');
    expect(getEditorType('main.go')).toBe('code');
    expect(getEditorType('Main.java')).toBe('code');
    expect(getEditorType('main.c')).toBe('code');
    expect(getEditorType('main.cpp')).toBe('code');
  });

  it('returns "code" for config files', () => {
    expect(getEditorType('tsconfig.json')).toBe('code');
    expect(getEditorType('config.yaml')).toBe('code');
    expect(getEditorType('config.yml')).toBe('code');
    expect(getEditorType('style.css')).toBe('code');
  });

  it('returns "code" for unknown extensions', () => {
    expect(getEditorType('Makefile')).toBe('code');
    expect(getEditorType('file.xyz')).toBe('code');
    expect(getEditorType('.gitignore')).toBe('code');
  });

  it('handles case-insensitive extensions', () => {
    expect(getEditorType('FILE.MD')).toBe('markdown');
    expect(getEditorType('PAGE.HTML')).toBe('code');
    expect(getEditorType('APP.TS')).toBe('code');
  });

  it('returns "code" for skill SKILL.md files when filePath is provided', () => {
    expect(getEditorType('SKILL.md', '/home/user/.opencode/skills/my-skill/SKILL.md')).toBe('code');
    expect(getEditorType('SKILL.md', '/home/user/.config/opencode/skills/test/SKILL.md')).toBe('code');
    expect(getEditorType('SKILL.md', '/home/user/.claude/skills/debug/SKILL.md')).toBe('code');
    expect(getEditorType('SKILL.md', '/home/user/.agents/skills/build/SKILL.md')).toBe('code');
  });

  it('returns "markdown" for non-skill .md files', () => {
    expect(getEditorType('README.md', '/project/README.md')).toBe('markdown');
    expect(getEditorType('guide.md', '/project/docs/guide.md')).toBe('markdown');
  });

  it('returns "markdown" when no filePath is provided for .md', () => {
    expect(getEditorType('SKILL.md')).toBe('markdown');
  });
});

describe('isSkillFile', () => {
  it('matches skill files in skills directories', () => {
    expect(isSkillFile('/home/user/.opencode/skills/my-skill/SKILL.md')).toBe(true);
    expect(isSkillFile('/home/user/.config/opencode/skills/test/SKILL.md')).toBe(true);
    expect(isSkillFile('/project/.claude/skills/debug/SKILL.md')).toBe(true);
  });

  it('does not match regular markdown files', () => {
    expect(isSkillFile('/project/README.md')).toBe(false);
    expect(isSkillFile('/project/docs/guide.md')).toBe(false);
    expect(isSkillFile('/project/skills.md')).toBe(false);
  });

  it('does not match SKILL.md outside skills directories', () => {
    expect(isSkillFile('/project/SKILL.md')).toBe(false);
    expect(isSkillFile('/project/docs/SKILL.md')).toBe(false);
  });
});

describe('getLanguageFromFilename', () => {
  it('detects TypeScript', () => {
    expect(getLanguageFromFilename('app.ts')).toBe('typescript');
    expect(getLanguageFromFilename('App.tsx')).toBe('typescript');
  });

  it('detects JavaScript', () => {
    expect(getLanguageFromFilename('index.js')).toBe('javascript');
    expect(getLanguageFromFilename('App.jsx')).toBe('javascript');
  });

  it('detects Python', () => {
    expect(getLanguageFromFilename('main.py')).toBe('python');
  });

  it('detects JSON', () => {
    expect(getLanguageFromFilename('package.json')).toBe('json');
  });

  it('detects YAML', () => {
    expect(getLanguageFromFilename('config.yaml')).toBe('yaml');
    expect(getLanguageFromFilename('config.yml')).toBe('yaml');
  });

  it('detects CSS variants', () => {
    expect(getLanguageFromFilename('style.css')).toBe('css');
    expect(getLanguageFromFilename('style.scss')).toBe('scss');
    expect(getLanguageFromFilename('style.less')).toBe('less');
  });

  it('detects shell scripts', () => {
    expect(getLanguageFromFilename('deploy.sh')).toBe('shell');
    expect(getLanguageFromFilename('init.bash')).toBe('shell');
    expect(getLanguageFromFilename('config.zsh')).toBe('shell');
  });

  it('returns plaintext for unknown extensions', () => {
    expect(getLanguageFromFilename('Makefile')).toBe('plaintext');
    expect(getLanguageFromFilename('file.xyz')).toBe('plaintext');
  });
});

describe('supportsPreview', () => {
  it('returns "html" for HTML files', () => {
    expect(supportsPreview('index.html')).toBe('html');
    expect(supportsPreview('page.htm')).toBe('html');
  });

  it('returns "markdown" for markdown files', () => {
    expect(supportsPreview('README.md')).toBe('markdown');
    expect(supportsPreview('guide.markdown')).toBe('markdown');
  });

  it('returns null for non-previewable files', () => {
    expect(supportsPreview('app.ts')).toBeNull();
    expect(supportsPreview('style.css')).toBeNull();
    expect(supportsPreview('config.json')).toBeNull();
  });
});
