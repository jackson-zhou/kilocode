import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { applyPatch, formatPatch, parsePatch, reversePatch, type StructuredPatch } from "diff"
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
export type StoredCheckpoint = {
  before: Array<Omit<Saved, "data"> & { data?: string }>
  after: Array<Omit<Saved, "data"> & { data?: string }>
  accepted: string[]
}
type Store = {
  get: (session: string) => string[]
  set: (session: string, keys: string[]) => Promise<void>
  history?: (session: string) => StoredCheckpoint[]
  save?: (session: string, checkpoints: StoredCheckpoint[]) => Promise<void>
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

function decode(items: StoredCheckpoint[]): Checkpoint[] {
  return items.map((item) => ({
    ...item,
    before: item.before.map((saved) => ({
      ...saved,
      data: saved.data ? Buffer.from(saved.data, "base64") : undefined,
    })),
    after: item.after.map((saved) => ({ ...saved, data: saved.data ? Buffer.from(saved.data, "base64") : undefined })),
  }))
}

function encode(items: Checkpoint[]): StoredCheckpoint[] {
  return items.map((item) => ({
    ...item,
    before: item.before.map((saved) => ({ ...saved, data: saved.data?.toString("base64") })),
    after: item.after.map((saved) => ({ ...saved, data: saved.data?.toString("base64") })),
  }))
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
    this.raw.set(session, diffs)
    return this.state(session)
  }

  state(session: string) {
    return {
      files: review(this.raw.get(session) ?? [], this.keys(session)),
      canRedo: this.checkpoints(session).length > 0,
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

  private checkpoints(session: string) {
    const hit = this.history.get(session)
    if (hit) return hit
    const history = decode(this.store?.history?.(session) ?? [])
    this.history.set(session, history)
    return history
  }

  private async persist(session: string) {
    await this.store?.save?.(session, encode(this.checkpoints(session)))
  }

  private async undo(session: string, targets: Array<{ file: ReviewFile; patch: string; ids: string[] }>) {
    const dir = this.directory(session)
    const files = [...new Set(targets.map((target) => target.file.file))]
    const before = await this.capture(dir, files)
    const result = await this.git.applyReversePatch(dir, targets.map((target) => target.patch).join("\n"))
    if (!result.ok) await this.fallback(dir, targets)
    const after = await this.capture(dir, files)
    const accepted = targets.flatMap((target) => target.ids)
    const history = this.checkpoints(session)
    history.push({ before, after, accepted })
    this.history.set(session, history.slice(-20))
    await this.persist(session)
  }

  private async redo(session: string) {
    const history = this.checkpoints(session)
    const checkpoint = history.at(-1)
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
    history.pop()
    await this.persist(session)
    return this.state(session)
  }

  private async fallback(
    dir: string,
    targets: Array<{ file: ReviewFile; patch: string; ids: string[] }>,
  ): Promise<void> {
    for (const target of targets) {
      const parsed = parsePatch(target.patch)[0]
      if (!parsed) throw new Error(`Unable to restore ${target.file.file}: invalid session patch`)
      const file = this.resolve(dir, target.file.file)
      const current = await fs.readFile(file, "utf8").catch(() => "")
      const restored = applyPatch(current, reversePatch(parsed), { fuzzFactor: 3 })
      if (restored !== false) {
        if (parsed.oldFileName === "/dev/null") await fs.rm(file, { force: true })
        else {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, restored)
        }
        continue
      }
      await this.restoreHunks(file, current, parsed)
    }
  }

  private async restoreHunks(target: string, current: string, parsed: StructuredPatch) {
    if (parsed.oldFileName === "/dev/null") {
      await fs.rm(target, { force: true })
      return
    }
    const eol = current.includes("\r\n") ? "\r\n" : "\n"
    const trailing = current.endsWith("\n")
    const lines = current.replace(/\r\n/g, "\n").split("\n")
    if (trailing) lines.pop()
    for (const hunk of [...parsed.hunks].reverse()) {
      const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1))
      const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1))
      const expected = Math.max(0, hunk.newStart - 1)
      const start = this.closest(lines, after, expected)
      lines.splice(start, after.length, ...before)
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, lines.join(eol) + (trailing ? eol : ""))
  }

  private closest(lines: string[], expected: string[], offset: number) {
    const min = Math.max(0, offset - 100)
    const max = Math.min(lines.length, offset + 100)
    const candidates = Array.from({ length: max - min + 1 }, (_, index) => min + index)
    return candidates.reduce(
      (best, start) => {
        const matches = expected.reduce((sum, line, index) => sum + (lines[start + index] === line ? 1 : 0), 0)
        const score = matches * 1000 - Math.abs(start - offset)
        return score > best.score ? { start, score } : best
      },
      { start: Math.min(offset, lines.length), score: Number.NEGATIVE_INFINITY },
    ).start
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
