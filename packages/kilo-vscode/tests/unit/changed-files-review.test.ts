import { afterAll, describe, expect, it } from "bun:test"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { ChangedFilesReview, review, type StoredCheckpoint } from "../../src/changed-files-review"
import { GitOps } from "../../src/agent-manager/GitOps"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-review-"))

async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr)
  return stdout
}

afterAll(() => fs.rm(root, { recursive: true, force: true }))

describe("changed files review", () => {
  it("keeps individual hunks pending by fingerprint", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "@@ -4 +4 @@",
      "-four",
      "+FOUR",
      "",
    ].join("\n")
    const first = review([{ file: "a.txt", patch, additions: 2, deletions: 2, status: "modified" }], new Set())
    expect(first[0]?.hunks).toHaveLength(2)

    const accepted = new Set([first[0]!.hunks[0]!.id])
    const next = review([{ file: "a.txt", patch, additions: 2, deletions: 2, status: "modified" }], accepted)
    expect(next[0]?.hunks).toHaveLength(1)
    expect(next[0]?.additions).toBe(1)
  })

  it("undoes and safely redoes an Agent file change", async () => {
    await git(["init"])
    await git(["config", "user.email", "review@test.invalid"])
    await git(["config", "user.name", "Review Test"])
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\n")
    await git(["add", "a.txt"])
    await git(["commit", "-m", "base"])
    await fs.writeFile(path.join(root, "a.txt"), "ONE\ntwo\n")
    const patch = await git(["diff", "--", "a.txt"])

    const controller = new ChangedFilesReview(new GitOps({ log: () => {} }), () => root)
    controller.update("session", [{ file: "a.txt", patch, additions: 1, deletions: 1, status: "modified" }])
    await controller.act("session", { type: "undo-file", file: "a.txt" })
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one\ntwo\n")
    expect(controller.state("session").canRedo).toBe(true)

    await controller.act("session", { type: "redo" })
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("ONE\ntwo\n")
    expect(controller.state("session").files).toHaveLength(1)
  })

  it("undoes one hunk without discarding another Agent change", async () => {
    await fs.writeFile(path.join(root, "b.txt"), "one\n2\n3\n4\n5\n6\n7\neight\n")
    await git(["add", "b.txt"])
    await git(["commit", "-m", "second base"])
    await fs.writeFile(path.join(root, "b.txt"), "ONE\n2\n3\n4\n5\n6\n7\nEIGHT\n")
    const patch = await git(["diff", "--unified=1", "--", "b.txt"])
    const controller = new ChangedFilesReview(new GitOps({ log: () => {} }), () => root)
    const state = controller.update("hunks", [{ file: "b.txt", patch, additions: 2, deletions: 2, status: "modified" }])
    expect(state.files[0]?.hunks).toHaveLength(2)

    await controller.act("hunks", {
      type: "undo-hunk",
      file: "b.txt",
      hunk: state.files[0]!.hunks[0]!.id,
    })
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("one\n2\n3\n4\n5\n6\n7\nEIGHT\n")
  })

  it("restores the session baseline when the user edits the Agent line", async () => {
    await fs.writeFile(path.join(root, "overlap.txt"), "one\ntwo\nthree\n")
    await git(["add", "overlap.txt"])
    await git(["commit", "-m", "overlap base"])
    await fs.writeFile(path.join(root, "overlap.txt"), "one\nTWO\nthree\n")
    const patch = await git(["diff", "--", "overlap.txt"])
    await fs.writeFile(path.join(root, "overlap.txt"), "one\nUSER\nthree\nuser tail\n")

    const controller = new ChangedFilesReview(new GitOps({ log: () => {} }), () => root)
    controller.update("overlap", [{ file: "overlap.txt", patch, additions: 1, deletions: 1, status: "modified" }])
    await controller.act("overlap", { type: "undo-file", file: "overlap.txt" })

    expect(await fs.readFile(path.join(root, "overlap.txt"), "utf8")).toBe("one\ntwo\nthree\nuser tail\n")
    await controller.act("overlap", { type: "redo" })
    expect(await fs.readFile(path.join(root, "overlap.txt"), "utf8")).toBe("one\nUSER\nthree\nuser tail\n")
  })

  it("persists redo checkpoints across controller recreation", async () => {
    await fs.writeFile(path.join(root, "persist.txt"), "base\n")
    await git(["add", "persist.txt"])
    await git(["commit", "-m", "persist base"])
    await fs.writeFile(path.join(root, "persist.txt"), "agent\n")
    const patch = await git(["diff", "--", "persist.txt"])
    const accepted: Record<string, string[]> = {}
    const history: Record<string, StoredCheckpoint[]> = {}
    const store = {
      get: (session: string) => accepted[session] ?? [],
      set: async (session: string, keys: string[]) => {
        accepted[session] = keys
      },
      history: (session: string) => history[session] ?? [],
      save: async (session: string, checkpoints: StoredCheckpoint[]) => {
        history[session] = checkpoints
      },
    }
    const first = new ChangedFilesReview(new GitOps({ log: () => {} }), () => root, store)
    first.update("persist", [{ file: "persist.txt", patch, additions: 1, deletions: 1, status: "modified" }])
    await first.act("persist", { type: "undo-file", file: "persist.txt" })

    const restored = new ChangedFilesReview(new GitOps({ log: () => {} }), () => root, store)
    restored.update("persist", [{ file: "persist.txt", patch, additions: 1, deletions: 1, status: "modified" }])
    expect(restored.state("persist").canRedo).toBe(true)
    await restored.act("persist", { type: "redo" })
    expect(await fs.readFile(path.join(root, "persist.txt"), "utf8")).toBe("agent\n")
  })
})
