/** Legal client-driven provision_status transitions. createApp owns
 *  pending→repo_created/error; this governs the seed lifecycle + retry.
 *  Clients may never move a row back TO `pending` or `repo_created` (no list
 *  includes them), and may never move FROM `pending` (empty list). The desktop
 *  writes only the terminal `ready`/`error`; `seeding` is kept reachable for a
 *  future real "in progress" signal. */
const ALLOWED: Record<string, string[]> = {
  pending: [],
  repo_created: ["seeding", "ready", "error"],
  seeding: ["ready", "error"],
  error: ["seeding", "ready", "error"],
  ready: ["seeding", "ready", "error"],
};

export function isLegalStatusTransition(from: string, to: string): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}
