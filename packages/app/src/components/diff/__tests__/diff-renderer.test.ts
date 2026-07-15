/**
 * Unit tests for DiffRenderer utility functions.
 * Tests the generateUnifiedDiff function and diff rendering logic.
 */
import { describe, it, expect } from 'vitest';
import { parseSingleFileDiff } from '../diff-ast';

/**
 * Simplified generateUnifiedDiff for testing (mirrors the DiffRenderer internal function).
 */
function generateUnifiedDiff(before: string, after: string, filePath: string): string {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const lines: string[] = [];
  lines.push(`diff --git a/${filePath} b/${filePath}`);
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);

  let hunkStart = -1;
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  const hunkLines: string[] = [];

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      const oldCount = hunkLines.filter(l => l.startsWith('-') || l.startsWith(' ')).length;
      const newCount = hunkLines.filter(l => l.startsWith('+') || l.startsWith(' ')).length;
      lines.push(`@@ -${hunkOldStart + 1},${oldCount} +${hunkNewStart + 1},${newCount} @@`);
      lines.push(...hunkLines);
      hunkLines.length = 0;
      hunkStart = -1;
    }
  };

  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      if (hunkStart >= 0) {
        hunkLines.push(` ${oldLines[oi]}`);
        const contextCount = hunkLines.slice().reverse().findIndex(l => !l.startsWith(' '));
        if (contextCount >= 3) {
          hunkLines.splice(hunkLines.length - (contextCount - 3));
          flushHunk();
        }
      }
      oi++;
      ni++;
    } else {
      if (hunkStart < 0) {
        hunkStart = oi;
        hunkOldStart = Math.max(0, oi - 3);
        hunkNewStart = Math.max(0, ni - 3);
        for (let c = Math.max(0, oi - 3); c < oi; c++) {
          if (c < oldLines.length) {
            hunkLines.push(` ${oldLines[c]}`);
          }
        }
      }

      if (oi < oldLines.length && (ni >= newLines.length || oldLines[oi] !== newLines[ni])) {
        const nextInNew = newLines.indexOf(oldLines[oi], ni);
        const nextInOld = ni < newLines.length ? oldLines.indexOf(newLines[ni], oi) : -1;

        if (nextInNew >= 0 && (nextInOld < 0 || nextInNew - ni <= nextInOld - oi)) {
          while (ni < nextInNew) {
            hunkLines.push(`+${newLines[ni]}`);
            ni++;
          }
        } else if (nextInOld >= 0) {
          while (oi < nextInOld) {
            hunkLines.push(`-${oldLines[oi]}`);
            oi++;
          }
        } else {
          if (oi < oldLines.length) {
            hunkLines.push(`-${oldLines[oi]}`);
            oi++;
          }
          if (ni < newLines.length) {
            hunkLines.push(`+${newLines[ni]}`);
            ni++;
          }
        }
      } else {
        if (ni < newLines.length) {
          hunkLines.push(`+${newLines[ni]}`);
          ni++;
        }
        if (oi < oldLines.length && oldLines[oi] !== newLines[ni - 1]) {
          hunkLines.push(`-${oldLines[oi]}`);
          oi++;
        }
      }
    }
  }

  flushHunk();
  return lines.join('\n');
}

describe('generateUnifiedDiff', () => {
  it('should produce valid diff header', () => {
    const diff = generateUnifiedDiff('hello', 'world', 'test.txt');
    expect(diff).toContain('diff --git a/test.txt b/test.txt');
    expect(diff).toContain('--- a/test.txt');
    expect(diff).toContain('+++ b/test.txt');
  });

  it('should detect single line change', () => {
    const diff = generateUnifiedDiff('hello', 'world', 'test.txt');
    expect(diff).toContain('-hello');
    expect(diff).toContain('+world');
  });

  it('should detect added lines', () => {
    const diff = generateUnifiedDiff('line 1\nline 2', 'line 1\nnew line\nline 2', 'test.txt');
    expect(diff).toContain('+new line');
  });

  it('should detect removed lines', () => {
    const diff = generateUnifiedDiff('line 1\nremoved\nline 3', 'line 1\nline 3', 'test.txt');
    expect(diff).toContain('-removed');
  });

  it('should handle identical content', () => {
    const diff = generateUnifiedDiff('same\ncontent', 'same\ncontent', 'test.txt');
    // Should only have headers, no hunks
    expect(diff).not.toContain('@@');
  });

  it('should produce parseable diff output', () => {
    const before = 'line 1\nline 2\nline 3';
    const after = 'line 1\nmodified\nline 3\nnew line';
    const diff = generateUnifiedDiff(before, after, 'test.txt');
    const parsed = parseSingleFileDiff(diff, 'test.txt');
    expect(parsed).not.toBeNull();
    expect(parsed!.hunks.length).toBeGreaterThan(0);
  });
});

describe('DiffRenderer integration with parseSingleFileDiff', () => {
  it('should parse modified file diff correctly', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' export {};',
    ].join('\n');

    const parsed = parseSingleFileDiff(diff, 'src/app.ts');
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('modified');
    expect(parsed!.hunks).toHaveLength(1);
    expect(parsed!.addedCount).toBe(2); // 2 added lines
    expect(parsed!.removedCount).toBe(1); // 1 removed line
  });

  it('should count additions and removals across multiple hunks', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-old line 2',
      '+new line 2',
      ' line 3',
      '@@ -10,3 +10,4 @@',
      ' line 10',
      ' line 11',
      '+added line',
      ' line 12',
    ].join('\n');

    const parsed = parseSingleFileDiff(diff, 'file.ts');
    expect(parsed).not.toBeNull();
    expect(parsed!.hunks).toHaveLength(2);
    expect(parsed!.addedCount).toBe(2); // 1 replacement + 1 new
    expect(parsed!.removedCount).toBe(1);
  });

  it('should handle new file diff', () => {
    const diff = [
      'diff --git a/new-file.ts b/new-file.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new-file.ts',
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n');

    const parsed = parseSingleFileDiff(diff, 'new-file.ts');
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('new');
    expect(parsed!.addedCount).toBe(3);
    expect(parsed!.removedCount).toBe(0);
  });

  it('should handle deleted file diff', () => {
    const diff = [
      'diff --git a/deleted.ts b/deleted.ts',
      'deleted file mode 100644',
      '--- a/deleted.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
    ].join('\n');

    const parsed = parseSingleFileDiff(diff, 'deleted.ts');
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('deleted');
    expect(parsed!.addedCount).toBe(0);
    expect(parsed!.removedCount).toBe(2);
  });
});
