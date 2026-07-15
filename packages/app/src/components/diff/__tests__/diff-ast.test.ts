import { describe, it, expect } from 'vitest';
import { parseDiff, parseSingleFileDiff } from '../diff-ast';

const SAMPLE_DIFF = `diff --git a/src/App.tsx b/src/App.tsx
index abc1234..def5678 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,5 +1,7 @@
 import React from 'react';
-import { OldComponent } from './old';
+import { NewComponent } from './new';
+import { AnotherComponent } from './another';
 
 function App() {
   return (
@@ -10,3 +12,4 @@ function App() {
     <div>
       <h1>Hello</h1>
+      <NewComponent />
     </div>`;

const NEW_FILE_DIFF = `diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'world';
+}`;

const DELETED_FILE_DIFF = `diff --git a/src/old-file.ts b/src/old-file.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function goodbye() {
-  return 'world';
-}`;

const RENAMED_FILE_DIFF = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 export function hello() {
-  return 'old';
+  return 'new';
 }`;

describe('parseDiff', () => {
  it('parses a standard modified file diff', () => {
    const result = parseDiff(SAMPLE_DIFF);
    expect(result).toHaveLength(1);

    const file = result[0];
    expect(file.filePath).toBe('src/App.tsx');
    expect(file.status).toBe('modified');
    expect(file.hunks).toHaveLength(2);
  });

  it('correctly counts additions and deletions', () => {
    const result = parseDiff(SAMPLE_DIFF);
    const file = result[0];
    expect(file.addedCount).toBe(3); // 2 in first hunk + 1 in second
    expect(file.removedCount).toBe(1); // 1 in first hunk
  });

  it('parses hunk headers correctly', () => {
    const result = parseDiff(SAMPLE_DIFF);
    const file = result[0];

    const hunk1 = file.hunks[0];
    expect(hunk1.oldStart).toBe(1);
    expect(hunk1.oldCount).toBe(5);
    expect(hunk1.newStart).toBe(1);
    expect(hunk1.newCount).toBe(7);
    expect(hunk1.index).toBe(1);

    const hunk2 = file.hunks[1];
    expect(hunk2.oldStart).toBe(10);
    expect(hunk2.oldCount).toBe(3);
    expect(hunk2.newStart).toBe(12);
    expect(hunk2.newCount).toBe(4);
    expect(hunk2.index).toBe(2);
  });

  it('parses line types correctly', () => {
    const result = parseDiff(SAMPLE_DIFF);
    const hunk1 = result[0].hunks[0];

    // First line: context
    expect(hunk1.lines[0].type).toBe('context');
    expect(hunk1.lines[0].content).toBe("import React from 'react';");

    // Second line: removed
    expect(hunk1.lines[1].type).toBe('removed');
    expect(hunk1.lines[1].content).toBe("import { OldComponent } from './old';");

    // Third line: added
    expect(hunk1.lines[2].type).toBe('added');
    expect(hunk1.lines[2].content).toBe("import { NewComponent } from './new';");
  });

  it('maps line numbers correctly', () => {
    const result = parseDiff(SAMPLE_DIFF);
    const hunk1 = result[0].hunks[0];

    // Context line
    expect(hunk1.lines[0].oldLineNumber).toBe(1);
    expect(hunk1.lines[0].newLineNumber).toBe(1);

    // Removed line
    expect(hunk1.lines[1].oldLineNumber).toBe(2);
    expect(hunk1.lines[1].newLineNumber).toBeNull();

    // Added line
    expect(hunk1.lines[2].oldLineNumber).toBeNull();
    expect(hunk1.lines[2].newLineNumber).toBe(2);
  });

  it('parses new file diff', () => {
    const result = parseDiff(NEW_FILE_DIFF);
    expect(result).toHaveLength(1);

    const file = result[0];
    expect(file.filePath).toBe('src/new-file.ts');
    expect(file.status).toBe('new');
    expect(file.addedCount).toBe(3);
    expect(file.removedCount).toBe(0);
  });

  it('parses deleted file diff', () => {
    const result = parseDiff(DELETED_FILE_DIFF);
    expect(result).toHaveLength(1);

    const file = result[0];
    expect(file.filePath).toBe('src/old-file.ts');
    expect(file.status).toBe('deleted');
    expect(file.addedCount).toBe(0);
    expect(file.removedCount).toBe(3);
  });

  it('parses renamed file diff', () => {
    const result = parseDiff(RENAMED_FILE_DIFF);
    expect(result).toHaveLength(1);

    const file = result[0];
    expect(file.filePath).toBe('src/new-name.ts');
    expect(file.status).toBe('renamed');
    expect(file.oldFilePath).toBe('src/old-name.ts');
  });

  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('returns empty array for non-diff input', () => {
    expect(parseDiff('Hello world\nNot a diff')).toEqual([]);
  });
});

describe('parseSingleFileDiff', () => {
  it('parses a full diff format', () => {
    const result = parseSingleFileDiff(SAMPLE_DIFF, 'src/App.tsx');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('src/App.tsx');
    expect(result!.hunks).toHaveLength(2);
  });

  it('parses raw hunk output (no diff header)', () => {
    const rawHunks = `@@ -1,3 +1,4 @@
 line1
 line2
+new line
 line3`;

    const result = parseSingleFileDiff(rawHunks, 'test.ts');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('test.ts');
    expect(result!.status).toBe('modified');
    expect(result!.hunks).toHaveLength(1);
    expect(result!.addedCount).toBe(1);
    expect(result!.removedCount).toBe(0);
  });

  it('returns null for empty diff', () => {
    expect(parseSingleFileDiff('', 'test.ts')).toBeNull();
  });

  it('returns null for non-diff content', () => {
    expect(parseSingleFileDiff('just some text', 'test.ts')).toBeNull();
  });
});
