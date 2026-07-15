import type { Idea } from "../ideas/idea-types";

/**
 * Builds the "Idea: …" prefix that iOS injects in front of the first user
 * message when a session is started from an Idea. Mirrors the iOS impl in
 * `apps/ios/.../NewSessionSheet.swift`:
 *
 *   - title + distinct description → `"Idea: <title>\n\n<description>"`
 *   - description only             → `"Idea: <description>"`
 *   - title only                   → `"Idea: <title>"`
 *   - both empty                   → null (no preface)
 */
export function buildIdeaPreface(idea: Idea | undefined | null): string | null {
  if (!idea) return null;
  const title = idea.title.trim();
  const description = idea.description.trim();
  if (title && description && title !== description) {
    return `Idea: ${title}\n\n${description}`;
  }
  if (description) return `Idea: ${description}`;
  if (title) return `Idea: ${title}`;
  return null;
}

/**
 * Prepends the idea preface to the user-authored first message. If the
 * idea is empty in both title and description, returns the original
 * user text unchanged.
 */
export function buildFirstMessageWithIdea(
  userText: string,
  idea: Idea | undefined | null,
): string {
  const preface = buildIdeaPreface(idea);
  if (!preface) return userText;
  return `${preface}\n\n${userText}`;
}
