import { describe, it, expect } from 'vitest';
import { computeLineChanges } from '../git-gutter';

describe('computeLineChanges', () => {
  it('should return empty array when contents are identical', () => {
    const content = 'line 1\nline 2\nline 3';
    expect(computeLineChanges(content, content)).toEqual([]);
  });

  it('should detect added lines at the end', () => {
    const original = 'line 1\nline 2';
    const current = 'line 1\nline 2\nline 3\nline 4';
    const changes = computeLineChanges(original, current);
    expect(changes).toContainEqual({ line: 3, type: 'added' });
    expect(changes).toContainEqual({ line: 4, type: 'added' });
  });

  it('should detect added lines in the middle', () => {
    const original = 'line 1\nline 3';
    const current = 'line 1\nline 2\nline 3';
    const changes = computeLineChanges(original, current);
    expect(changes.some(c => c.type === 'added' && c.line === 2)).toBe(true);
  });

  it('should detect deleted lines', () => {
    const original = 'line 1\nline 2\nline 3\nline 4';
    const current = 'line 1\nline 4';
    const changes = computeLineChanges(original, current);
    expect(changes.some(c => c.type === 'deleted')).toBe(true);
  });

  it('should detect modified lines', () => {
    const original = 'line 1\noriginal line\nline 3';
    const current = 'line 1\nmodified line\nline 3';
    const changes = computeLineChanges(original, current);
    expect(changes.some(c => c.type === 'modified' && c.line === 2)).toBe(true);
  });

  it('should handle empty original content', () => {
    const original = '';
    const current = 'line 1\nline 2';
    const changes = computeLineChanges(original, current);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every(c => c.type === 'added' || c.type === 'modified')).toBe(true);
  });

  it('should handle empty current content', () => {
    const original = 'line 1\nline 2';
    const current = '';
    const changes = computeLineChanges(original, current);
    // Should detect deletions
    expect(changes.length).toBeGreaterThan(0);
  });

  it('should handle completely different content', () => {
    const original = 'alpha\nbeta\ngamma';
    const current = 'one\ntwo\nthree';
    const changes = computeLineChanges(original, current);
    // Should have 3 modified lines
    expect(changes.length).toBe(3);
  });

  it('should handle single line files', () => {
    const original = 'hello';
    const current = 'world';
    const changes = computeLineChanges(original, current);
    expect(changes).toContainEqual({ line: 1, type: 'modified' });
  });

  it('should return 1-based line numbers', () => {
    const original = 'line 1\noriginal';
    const current = 'line 1\nmodified';
    const changes = computeLineChanges(original, current);
    expect(changes.every(c => c.line >= 1)).toBe(true);
  });
});
