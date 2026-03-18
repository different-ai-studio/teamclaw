/**
 * PM Diff Engine — Character-level diff with ProseMirror position mapping.
 *
 * Computes diffs between old and new document content at the text level,
 * then maps text offsets to ProseMirror document positions.
 */

import { diffChars } from "diff";
import type { Node as PMNode } from "@tiptap/pm/model";

/** A range in ProseMirror document coordinates where agent made changes */
export interface AgentChangeRange {
  from: number;
  to: number;
}

/** Result of computing agent changes */
export interface AgentChangeResult {
  /** PM position ranges of added/modified text in the NEW document */
  ranges: AgentChangeRange[];
  /** Percentage of text that was changed (0-100) */
  changePercent: number;
}

/**
 * Walk a ProseMirror document and build a mapping from text offsets
 * (as produced by doc.textContent) to PM positions.
 *
 * The textContent of a PM doc strips all node structure but
 * block nodes contribute a boundary. We walk the tree and record
 * the PM position for each character in the textContent string.
 *
 * Returns an array where index = text offset, value = PM position.
 */
export function buildTextOffsetToPMPosition(doc: PMNode): number[] {
  const mapping: number[] = [];
  let textOffset = 0;

  // Walk all text nodes in document order
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        mapping[textOffset] = pos + i;
        textOffset++;
      }
      return false; // don't descend into text nodes
    }
    // Block nodes add a separator in textContent (except the doc node itself)
    // But textBetween adds block separators between blocks, not at start
    // We need to match exactly what doc.textContent produces.
    // ProseMirror's textContent adds "\n" between blocks via textBetween(0, size)
    // which uses the default block separator.
    return true; // descend into element nodes
  });

  return mapping;
}

/**
 * Build a text-offset-to-PM-position mapping that exactly matches
 * what `doc.textContent` produces.
 *
 * ProseMirror's `doc.textContent` concatenates all text nodes,
 * with block leaf nodes inserting their textContent (including "\n" separators
 * from child blocks). We need to account for this exactly.
 *
 * Strategy: use doc.textBetween(0, doc.content.size) with default separator
 * to get the exact text, then build the mapping by walking the doc tree
 * in the same order textBetween does.
 */
export function buildTextToPMMap(doc: PMNode): number[] {
  const map: number[] = [];

  // We'll walk the document and track positions exactly as textBetween does
  const textContent = doc.textBetween(0, doc.content.size, "\n", "");
  let textIdx = 0;

  function walk(node: PMNode, offset: number) {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        if (textIdx < textContent.length) {
          map[textIdx] = offset + i;
          textIdx++;
        }
      }
    } else if (node.isLeaf) {
      // Leaf nodes that aren't text (like images, hard breaks)
      // textBetween uses leafText or empty string
      const leafText = node.type.spec.leafText
        ? node.type.spec.leafText(node)
        : "";
      for (let i = 0; i < leafText.length; i++) {
        if (textIdx < textContent.length) {
          map[textIdx] = offset;
          textIdx++;
        }
      }
    } else {
      // Element node — descend into children
      let isFirstBlock = true;
      node.forEach((child, childPos) => {
        // Block separator: textBetween inserts "\n" between block children
        if (child.isBlock && !isFirstBlock) {
          if (textIdx < textContent.length && textContent[textIdx] === "\n") {
            // This "\n" is a separator — map it to the position between blocks
            map[textIdx] = offset + 1 + childPos;
            textIdx++;
          }
        }
        if (child.isBlock) {
          isFirstBlock = false;
        }
        walk(child, offset + 1 + childPos);
      });
    }
  }

  // Walk from the doc's children directly (doc node itself is pos 0)
  let isFirstBlock = true;
  doc.forEach((child, childPos) => {
    if (child.isBlock && !isFirstBlock) {
      if (textIdx < textContent.length && textContent[textIdx] === "\n") {
        map[textIdx] = childPos;
        textIdx++;
      }
    }
    if (child.isBlock) {
      isFirstBlock = false;
    }
    walk(child, childPos);
  });

  return map;
}

/**
 * Compute the agent changes between old and new documents.
 *
 * @param oldDoc - The current ProseMirror document (before agent edit)
 * @param newMarkdown - The new markdown content (from agent's file write)
 * @param schema - The ProseMirror schema (for parsing new markdown)
 * @param parseMarkdown - Function to parse markdown into a PM doc
 * @returns Changed ranges in the NEW document's PM positions, and change percentage
 */
export function computeAgentChanges(
  oldDoc: PMNode,
  newDoc: PMNode,
): AgentChangeResult {
  // Get text content from both docs
  const oldText = oldDoc.textBetween(0, oldDoc.content.size, "\n", "");
  const newText = newDoc.textBetween(0, newDoc.content.size, "\n", "");

  // If identical, no changes
  if (oldText === newText) {
    return { ranges: [], changePercent: 0 };
  }

  // Compute character-level diff
  const changes = diffChars(oldText, newText);

  // Build PM position mapping for the NEW document
  const newMap = buildTextToPMMap(newDoc);

  // Walk the diff and collect ranges of added/changed text in the new doc
  const ranges: AgentChangeRange[] = [];
  let newOffset = 0;
  let addedChars = 0;
  let removedChars = 0;

  for (const change of changes) {
    if (change.removed) {
      // Deleted text — only exists in old, skip for new offset
      removedChars += change.value.length;
      continue;
    }

    if (change.added) {
      // Added text — exists only in new
      const startOffset = newOffset;
      const endOffset = newOffset + change.value.length;
      addedChars += change.value.length;

      // Map text offsets to PM positions
      const from = newMap[startOffset];
      const to = newMap[Math.min(endOffset - 1, newMap.length - 1)];

      if (from !== undefined && to !== undefined) {
        ranges.push({ from, to: to + 1 }); // +1 because `to` is inclusive
      }

      newOffset += change.value.length;
    } else {
      // Unchanged text — advance new offset
      newOffset += change.value.length;
    }
  }

  // Calculate change percentage: use max of added/removed relative to max doc size
  const changedChars = Math.max(addedChars, removedChars);
  const totalChars = Math.max(oldText.length, newText.length, 1);
  const changePercent = Math.min((changedChars / totalChars) * 100, 100);

  return { ranges, changePercent };
}
