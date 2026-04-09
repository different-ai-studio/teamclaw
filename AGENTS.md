# Development Guidelines

## Verification Before Completion

After making any code changes, you MUST run verification before claiming work is done:

1. **Lint** — `pnpm lint`
2. **Unit tests** — `pnpm test`

Never say "done", "fixed", or "complete" without running both checks and confirming they pass. If either fails, fix the issues first.

## Project Structure

- `packages/app/` — Frontend (React + Vite + Vitest)
- `src-tauri/` — Rust backend (Tauri)
- Tests live alongside source in `__tests__/` directories or as `*.test.ts(x)` files

## Test Environment Notes

- `build.config.json` controls `appShortName` (currently `ac360`); tests should import `appShortName` from `@/lib/build-config` instead of hardcoding localStorage key prefixes.
- Tauri APIs (`@tauri-apps/api/core`, `@tauri-apps/api/event`) must be mocked in tests.
- Zustand store mocks must use `vi.hoisted()` for function references used in `useEffect` dependencies to prevent infinite re-render loops.
- The 4 pre-existing `CSS.escape` unhandled rejections in FileTree keyboard tests are known and acceptable.
