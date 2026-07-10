import type { SnapshotFileDiff } from "@kilocode/sdk/v2/client"

const LIMIT = 8

type Loader = () => Promise<SnapshotFileDiff[] | undefined>

/**
 * Keeps full session patches bounded while rejecting stale HTTP responses.
 * SSE updates use a separate revision so a request started before a live
 * update can never overwrite the newer event payload.
 */
export class SessionDiffState {
  private readonly cache = new Map<string, SnapshotFileDiff[]>()
  private readonly generations = new Map<string, number>()
  private readonly revisions = new Map<string, number>()

  constructor(private readonly limit = LIMIT) {}

  get size() {
    return this.cache.size
  }

  get(sessionID: string) {
    const diffs = this.cache.get(sessionID)
    if (!diffs) return
    this.cache.delete(sessionID)
    this.cache.set(sessionID, diffs)
    return diffs
  }

  set(sessionID: string, diffs: SnapshotFileDiff[]) {
    this.cache.delete(sessionID)
    this.cache.set(sessionID, diffs)
    while (this.cache.size > this.limit) {
      const first = this.cache.keys().next().value
      if (!first) return
      this.cache.delete(first)
    }
  }

  live(sessionID: string, diffs: SnapshotFileDiff[]) {
    this.revisions.set(sessionID, (this.revisions.get(sessionID) ?? 0) + 1)
    this.set(sessionID, diffs)
  }

  async fetch(sessionID: string, load: Loader) {
    const generation = (this.generations.get(sessionID) ?? 0) + 1
    const revision = this.revisions.get(sessionID) ?? 0
    this.generations.set(sessionID, generation)
    const diffs = await load()
    if (this.generations.get(sessionID) !== generation || (this.revisions.get(sessionID) ?? 0) !== revision) {
      return this.get(sessionID)
    }
    if (!diffs) return
    this.set(sessionID, diffs)
    return diffs
  }

  delete(sessionID: string) {
    this.cache.delete(sessionID)
    this.generations.delete(sessionID)
    this.revisions.delete(sessionID)
  }

  clear() {
    this.cache.clear()
    this.generations.clear()
    this.revisions.clear()
  }
}

interface SessionDiffFile {
  file: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export function summaries(diffs: SnapshotFileDiff[]): SessionDiffFile[] {
  return diffs.flatMap((diff) => {
    if (!diff.file) return []
    return [
      {
        file: diff.file,
        additions: diff.additions,
        deletions: diff.deletions,
        status: diff.status ?? "modified",
      },
    ]
  })
}

export function detail(diffs: SnapshotFileDiff[], file: string) {
  const diff = diffs.find((item) => item.file === file)
  if (!diff?.file) return
  return {
    file: diff.file,
    patch: diff.patch,
    additions: diff.additions,
    deletions: diff.deletions,
    initialDiffStyle: "split" as const,
  }
}
