import { describe, expect, it } from "bun:test"
import {
  INLINE_FILE_LIMIT,
  accepts,
  overview,
  requestChanges,
  requestFile,
} from "../../webview-ui/src/components/chat/changed-files-overview"
import type { SessionDiffFile, WebviewMessage } from "../../webview-ui/src/types/messages"

const files = (count: number): SessionDiffFile[] =>
  Array.from({ length: count }, (_, index) => ({
    file: `src/file-${index}.ts`,
    additions: index + 1,
    deletions: index % 2,
    status: "modified",
  }))

describe("changed files overview", () => {
  it("aggregates session diff metadata", () => {
    const result = overview([
      { file: "added.ts", additions: 4, deletions: 0, status: "added" },
      { file: "changed.ts", additions: 2, deletions: 3, status: "modified" },
      { file: "deleted.ts", additions: 0, deletions: 5, status: "deleted" },
    ])

    expect(result).toMatchObject({ files: 3, additions: 6, deletions: 8, hidden: 0 })
  })

  it.each([0, 1, 20, 21, 200])("bounds the inline list for %i files", (count) => {
    const result = overview(files(count))

    expect(result.visible).toHaveLength(Math.min(count, INLINE_FILE_LIMIT))
    expect(result.hidden).toBe(Math.max(0, count - INLINE_FILE_LIMIT))
    expect(result.visible.map((file) => file.file)).toEqual(
      files(count)
        .slice(0, INLINE_FILE_LIMIT)
        .map((file) => file.file),
    )
  })

  it("accepts live updates and rejects stale session or request responses", () => {
    const pending = { sessionID: "s2", requestID: "r2" }

    expect(accepts("s2", pending, { sessionID: "s2" })).toBe(true)
    expect(accepts("s2", pending, { sessionID: "s1" })).toBe(false)
    expect(accepts("s2", pending, { sessionID: "s2", requestID: "r1" })).toBe(false)
    expect(accepts("s2", pending, { sessionID: "s2", requestID: "r2" })).toBe(true)
  })

  it("requests a file with session and request identity", () => {
    const posted: WebviewMessage[] = []

    requestFile((message) => posted.push(message), "s1", "src/a.ts", "r1")

    expect(posted).toEqual([{ type: "requestSessionDiffFile", sessionID: "s1", file: "src/a.ts", requestID: "r1" }])
  })

  it("opens the session rendered by the changed-files panel", () => {
    const posted: WebviewMessage[] = []

    requestChanges((message) => posted.push(message), "session-b")

    expect(posted).toEqual([{ type: "openChanges", source: "session", sessionID: "session-b" }])
  })
})
