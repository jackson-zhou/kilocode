import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { formatPatch, parsePatch, type StructuredPatch } from "diff"
import type { SnapshotFileDiff } from "@kilocode/sdk/v2/client"
import type { GitOps } from "./agent-manager/GitOps"

export interface ReviewHunk {
  id: string
  label: string
  additions: number
  deletions: number
}

export interface ReviewFile {
  file: string
  patch: string
  undoable: boolean
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  id: string
  hunks: ReviewHunk[]
}

export type ReviewAction =
  | { type: "keep-all" }
  | { type: "undo-all" }
  | { type: "keep-file"; file: string }
  | { type: "undo-file"; file: string }
  | { type: "keep-hunk"; file: string; hunk: string }
  | { type: "undo-hunk"; file: string; hunk: string }
  | { type: "redo" }

type Saved = { file: string; exists: boolean; data?: Buffer; hash: string }
type Checkpoint = { before: Saved[]; after: Saved[]; accepted: string[] }
type Store = {
  get: (session: string) => string[]
  set: (session: string, keys: string[]) => Promise<void>
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

function patch(input: StructuredPatch, hunks = input.hunks) {
  return formatPatch({ ...input, hunks })
}

function stats(lines: string[]) {
  return {
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: lines.filter((line) => line.startsWith("-")).length,
  }
}

export function review(raw: SnapshotFileDiff[], accepted: Set<string>): ReviewFile[] {
  return raw.flatMap((item): ReviewFile[] => {
    if (!item.file) return []
    const source = item.patch ?? ""
    const id = `file:${digest(`${item.file}\0${source}`)}`
    if (accepted.has(id)) return []
    if (!source) {
      return [
        {
          file: item.file,
          patch: "",
          undoable: false,
          additions: item.additions,
          deletions: item.deletions,
          status: item.status,
          id,
          hunks: [],
        },
      ]
    }
    const parsed = parsePatch(source)[0]
    if (!parsed) return []
    const hunks = parsed.hunks.flatMap((hunk) => {
      const text = patch(parsed, [hunk])
      const id = `hunk:${digest(`${item.file}\0${text}`)}`
      if (accepted.has(id)) return []
      const count = stats(hunk.lines)
      return [{ id, label: `Lines ${hunk.oldStart}-${hunk.newStart}`, ...count }]
    })
    if (hunks.length === 0) return []
    const ids = new Set(hunks.map((hunk) => hunk.id))
    const pending = parsed.hunks.filter((hunk) => ids.has(`hunk:${digest(`${item.file}\0${patch(parsed, [hunk])}`)}`))
    return [
      {
        file: item.file,
        patch: patch(parsed, pending),
        undoable: true,
        additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0),
        deletions: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0),
        status: item.status,
        id,
        hunks,
      },
    ]
  })
}

export class ChangedFilesReview {
  private readonly raw = new Map<string, SnapshotFileDiff[]>()
  private readonly accepted = new Map<string, Set<string>>()
  private readonly history = new Map<string, Checkpoint[]>()

  constructor(
    private readonly git: GitOps,
    private readonly directory: (session: string) => string,
    private readonly store?: Store,
  ) {}

  update(session: string, diffs: SnapshotFileDiff[]) {
    const prior = this.raw.get(session)
    if (prior && digest(JSON.stringify(prior)) !== digest(JSON.stringify(diffs))) this.history.delete(session)
    this.raw.set(session, diffs)
    return this.state(session)
  }

  state(session: string) {
    return {
      files: review(this.raw.get(session) ?? [], this.keys(session)),
      canRedo: (this.history.get(session)?.length ?? 0) > 0,
    }
  }

  async act(session: string, action: ReviewAction) {
    if (action.type === "redo") return this.redo(session)
    const files = this.state(session).files
    const targets = (() => {
      if (action.type === "keep-all" || action.type === "undo-all") {
        return files.map((file) => ({ file, patch: file.patch, ids: [file.id, ...file.hunks.map((hunk) => hunk.id)] }))
      }
      const file = files.find((item) => item.file === action.file)
      if (!file) return []
      if (action.type === "keep-file" || action.type === "undo-file") {
        return [{ file, patch: file.patch, ids: [file.id, ...file.hunks.map((hunk) => hunk.id)] }]
      }
      const hunk = file.hunks.find((item) => item.id === action.hunk)
      if (!hunk) return []
      const parsed = parsePatch(file.patch)[0]
      if (!parsed) return []
      const selected = parsed.hunks.find((item) => {
        const id = `hunk:${digest(`${file.file}\0${patch(parsed, [item])}`)}`
        return id === hunk.id
      })
      return selected ? [{ file, patch: patch(parsed, [selected]), ids: [hunk.id] }] : []
    })()
    if (targets.length === 0) throw new Error("The selected Agent change is no longer pending")

    const undo = action.type.startsWith("undo")
    if (undo && targets.some((target) => !target.file.undoable)) {
      throw new Error("Undo is unavailable because one or more files do not contain a restorable text patch")
    }
    if (undo) await this.undo(session, targets)
    const keys = this.keys(session)
    for (const target of targets) {
      for (const id of target.ids) keys.add(id)
    }
    await this.store?.set(session, [...keys])
    return this.state(session)
  }

  private keys(session: string) {
    const hit = this.accepted.get(session)
    if (hit) return hit
    const keys = new Set(this.store?.get(session) ?? [])
    this.accepted.set(session, keys)
    return keys
  }

  private async undo(session: string, targets: Array<{ file: ReviewFile; patch: string; ids: string[] }>) {
    const dir = this.directory(session)
    const files = [...new Set(targets.map((target) => target.file.file))]
    const before = await this.capture(dir, files)
    const result = await this.git.applyReversePatch(dir, targets.map((target) => target.patch).join("\n"))
    if (!result.ok) throw new Error(result.message)
    const after = await this.capture(dir, files)
    const accepted = targets.flatMap((target) => target.ids)
    const history = this.history.get(session) ?? []
    history.push({ before, after, accepted })
    this.history.set(session, history.slice(-20))
  }

  private async redo(session: string) {
    const history = this.history.get(session)
    const checkpoint = history?.at(-1)
    if (!checkpoint) throw new Error("No Agent change is available to redo")
    const dir = this.directory(session)
    const current = await this.capture(
      dir,
      checkpoint.after.map((item) => item.file),
    )
    if (current.some((item, index) => item.hash !== checkpoint.after[index]?.hash)) {
      throw new Error("Files changed after Undo. Review those edits before using Redo.")
    }
    await Promise.all(checkpoint.before.map((item) => this.restore(dir, item)))
    const keys = this.keys(session)
    for (const id of checkpoint.accepted) keys.delete(id)
    await this.store?.set(session, [...keys])
    history!.pop()
    return this.state(session)
  }

  private async capture(dir: string, files: string[]) {
    return Promise.all(
      files.map(async (file): Promise<Saved> => {
        const target = this.resolve(dir, file)
        const data = await fs.readFile(target).catch(() => undefined)
        return { file, exists: data !== undefined, data, hash: data === undefined ? "missing" : digest(data) }
      }),
    )
  }

  private async restore(dir: string, item: Saved) {
    const target = this.resolve(dir, item.file)
    if (!item.exists) {
      await fs.rm(target, { force: true })
      return
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, item.data!)
  }

  private resolve(dir: string, file: string) {
    const root = path.resolve(dir)
    const target = path.resolve(root, file)
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("File path is outside the workspace")
    return target
  }
}
