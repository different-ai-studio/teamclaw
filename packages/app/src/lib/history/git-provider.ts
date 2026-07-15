import { gitManager } from '@/lib/git/manager'
import type { HistoryProvider, HistoryPage } from './types'

const PAGE_SIZE = 50

/** History backed by `git log --follow` on a local repo path. */
export class GitHistoryProvider implements HistoryProvider {
  constructor(
    private readonly repoPath: string,
    private readonly relativePath: string,
    /** Kept for parity with OSS provider; unused by git. */
    private readonly _filePath: string,
  ) {}

  async list(cursor: string | null): Promise<HistoryPage> {
    const skip = cursor ? Number(cursor) : 0
    const entries = await gitManager.logFile(
      this.repoPath,
      this.relativePath,
      PAGE_SIZE,
      skip,
    )
    return {
      entries: entries.map((e) => ({
        ref: e.sha,
        parentRef: e.parentSha,
        label: e.sha.slice(0, 7),
        author: e.author,
        timestamp: e.isoTime,
        message: e.subject,
      })),
      nextCursor: entries.length === PAGE_SIZE ? String(skip + entries.length) : null,
    }
  }

  getContent(ref: string): Promise<string | null> {
    return gitManager.showFile(this.repoPath, this.relativePath, ref)
  }
}
