import { describe, expect, it } from "bun:test"
import {
  INLINE_FILE_LIMIT,
  overview,
  request,
  shortcut,
} from "../../webview-ui/src/components/chat/changed-files-overview"
import type { SessionDiffFile, WebviewMessage } from "../../webview-ui/src/types/messages"

const files = (count: number): SessionDiffFile[] =>
  Array.from({ length: count }, (_, index) => ({
    file: `src/file-${index}.ts`,
    id: `file-${index}`,
    patch: "",
    undoable: false,
    additions: index + 1,
    deletions: index % 2,
    hunks: [],
  }))

describe("changed files overview", () => {
  it("aggregates session diff metadata", () => {
    expect(overview(files(3))).toMatchObject({ files: 3, additions: 6, deletions: 1, hidden: 0 })
  })

  it("bounds the inline list", () => {
    const result = overview(files(INLINE_FILE_LIMIT + 1))

    expect(result.visible).toHaveLength(INLINE_FILE_LIMIT)
    expect(result.hidden).toBe(1)
  })

  it("requests the rendered session", () => {
    const posted: WebviewMessage[] = []

    request((message) => posted.push(message), "session-a", "request-a")

    expect(posted).toEqual([{ type: "requestSessionDiff", sessionID: "session-a", requestID: "request-a" }])
  })

  it("maps command shortcuts only without competing modifiers", () => {
    expect(shortcut({ key: "n", metaKey: true, altKey: false, ctrlKey: false, shiftKey: false })).toBe("undo")
    expect(shortcut({ key: "Y", metaKey: true, altKey: false, ctrlKey: false, shiftKey: false })).toBe("keep")
    expect(shortcut({ key: "n", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false })).toBeUndefined()
  })
})
