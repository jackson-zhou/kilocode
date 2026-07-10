import { describe, expect, it } from "bun:test"
import type { SnapshotFileDiff } from "@kilocode/sdk/v2/client"
import { SessionDiffState, detail, summaries } from "../../src/kilo-provider/session-diff"

function file(patch: string): SnapshotFileDiff[] {
  return [{ file: "src/a.ts", patch, additions: 1, deletions: 1, status: "modified" }]
}

describe("session diff sidebar projection", () => {
  const diffs = [
    {
      file: "src/a.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    },
    { file: undefined, patch: "", additions: 0, deletions: 0, status: "added" as const },
  ]

  it("sends metadata only and filters malformed paths", () => {
    expect(summaries(diffs)).toEqual([{ file: "src/a.ts", additions: 1, deletions: 1, status: "modified" }])
  })

  it("selects an exact file and prepares the existing virtual diff viewer", () => {
    expect(detail(diffs, "src/a.ts")).toEqual({
      file: "src/a.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      additions: 1,
      deletions: 1,
      initialDiffStyle: "split",
    })
    expect(detail(diffs, "src/missing.ts")).toBeUndefined()
  })

  it("keeps only the most recently used full patch payloads", () => {
    const state = new SessionDiffState(2)
    state.set("s1", file("one"))
    state.set("s2", file("two"))

    expect(state.get("s1")).toEqual(file("one"))
    state.set("s3", file("three"))

    expect(state.size).toBe(2)
    expect(state.get("s2")).toBeUndefined()
    expect(state.get("s1")).toEqual(file("one"))
    expect(state.get("s3")).toEqual(file("three"))
  })

  it("does not let an older same-revision request overwrite a newer response", async () => {
    const state = new SessionDiffState()
    const older = Promise.withResolvers<SnapshotFileDiff[] | undefined>()
    const newer = Promise.withResolvers<SnapshotFileDiff[] | undefined>()
    const first = state.fetch("s1", () => older.promise)
    const second = state.fetch("s1", () => newer.promise)

    newer.resolve(file("new"))
    expect(await second).toEqual(file("new"))
    older.resolve(file("old"))

    expect(await first).toEqual(file("new"))
    expect(state.get("s1")).toEqual(file("new"))
  })

  it("preserves a live update over an older HTTP response", async () => {
    const state = new SessionDiffState()
    const pending = Promise.withResolvers<SnapshotFileDiff[] | undefined>()
    const request = state.fetch("s1", () => pending.promise)

    state.live("s1", file("live"))
    pending.resolve(file("old"))

    expect(await request).toEqual(file("live"))
    expect(state.get("s1")).toEqual(file("live"))
  })
})
