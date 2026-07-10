import { Effect, Semaphore } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import type { MessageID, PartID, SessionID } from "@/session/schema"
import type { SessionSummary } from "@/session/summary"
import type { Snapshot } from "@/snapshot"
import type { Storage } from "@/storage/storage"
import {
  appendSessionDiffs,
  cumulativeSessionDiff,
  readSessionDiffBase,
} from "@/kilocode/session-portability/cumulative-diff"

type Revert = {
  messageID: MessageID
  partID?: PartID
  snapshot?: string
}

type Input = {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  revert: Revert
  storage: Storage.Interface
  summary: SessionSummary.Interface
  snapshot: Snapshot.Interface
  reverted: boolean
}

export type Diffs = {
  active: Snapshot.FileDiff[]
  undone: Snapshot.FileDiff[]
}

const key = (id: SessionID) => ["session_diff_revert", id]
type State = { semaphore: Semaphore.Semaphore; refs: number; watchers: number; revision: number }
type Token = { id: SessionID; state: State; revision: number }
const states = new Map<SessionID, State>()

function drop(id: SessionID, state: State) {
  if (state.refs === 0 && state.watchers === 0 && states.get(id) === state) states.delete(id)
}

function locked<A, E, R>(id: SessionID, use: (state: State) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const state = states.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), refs: 0, watchers: 0, revision: 0 }
      state.refs++
      states.set(id, state)
      return state
    }),
    (state) => state.semaphore.withPermits(1)(use(state)),
    (state) =>
      Effect.sync(() => {
        state.refs--
        drop(id, state)
      }),
  )
}

function prefix(messages: MessageV2.WithParts[], revert: Revert) {
  return messages.flatMap((msg) => {
    if (msg.info.id < revert.messageID) return [msg]
    if (msg.info.id > revert.messageID || !revert.partID) return []
    const index = msg.parts.findIndex((part) => part.id === revert.partID)
    if (index < 0) return []
    return [{ ...msg, parts: msg.parts.slice(0, index) }]
  })
}

function suffix(messages: MessageV2.WithParts[], revert: Revert) {
  return messages.flatMap((msg) => {
    if (msg.info.id < revert.messageID) return []
    if (msg.info.id > revert.messageID || !revert.partID) return [msg]
    const index = msg.parts.findIndex((part) => part.id === revert.partID)
    if (index < 0) return []
    return [{ ...msg, parts: msg.parts.slice(index) }]
  })
}

function first(messages: MessageV2.WithParts[]) {
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "step-start" && part.snapshot) return part.snapshot
    }
  }
  return undefined
}

function last(messages: MessageV2.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part.type === "step-finish" && part.snapshot) return part.snapshot
    }
  }
  return undefined
}

function latest(messages: MessageV2.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if ((part.type === "step-start" || part.type === "step-finish") && part.snapshot) {
        return { snapshot: part.snapshot, type: part.type }
      }
    }
  }
  return undefined
}

const calculate = Effect.fn("KiloRevertDiff.calculate")(function* (
  input: Pick<Input, "sessionID" | "messages" | "storage" | "summary">,
) {
  const base = yield* readSessionDiffBase(input.storage, input.sessionID)
  if (base.length === 0) return yield* input.summary.computeDiff({ messages: input.messages })

  const users = input.messages.filter((msg) => msg.info.role === "user")
  const locals = yield* Effect.forEach(
    users,
    (user) =>
      input.summary.computeDiff({
        messages: input.messages.filter(
          (msg) =>
            msg.info.id === user.info.id || (msg.info.role === "assistant" && msg.info.parentID === user.info.id),
        ),
      }),
    { concurrency: 3 },
  )
  return locals.reduce((diffs, next) => appendSessionDiffs({ existing: diffs, next }), base)
})

export function watch<A, E, R>(id: SessionID, use: (token: Token) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const state = states.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), refs: 0, watchers: 0, revision: 0 }
      state.watchers++
      states.set(id, state)
      return { id, state, revision: state.revision } satisfies Token
    }),
    use,
    (token) =>
      Effect.sync(() => {
        token.state.watchers--
        drop(token.id, token.state)
      }),
  )
}

export function guard<A, E, R>(input: { token: Token; effect: Effect.Effect<A, E, R> }) {
  return input.token.state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      if (states.get(input.token.id) !== input.token.state) return false
      if (input.token.state.revision !== input.token.revision) return false
      yield* input.effect
      return true
    }),
  )
}

export function change<A, E, R>(id: SessionID, effect: Effect.Effect<A, E, R>) {
  return locked(id, (state) =>
    Effect.gen(function* () {
      state.revision++
      return yield* effect
    }),
  )
}

export function save(storage: Storage.Interface, id: SessionID, diffs: Snapshot.FileDiff[]) {
  return storage.write(["session_diff", id], diffs).pipe(Effect.orDie)
}

export const prepare = Effect.fn("KiloRevertDiff.prepare")(function* (input: Input) {
  const kept = prefix(input.messages, input.revert)
  const after = suffix(input.messages, input.revert)
  const [active, calculated, stored, base] = yield* Effect.all(
    [
      calculate({ ...input, messages: kept }),
      calculate(input),
      input.storage.read<Snapshot.FileDiff[]>(["session_diff", input.sessionID]).pipe(
        Effect.map((diffs) => ({ found: true as const, diffs })),
        Effect.catch(() => Effect.succeed({ found: false as const, diffs: [] as Snapshot.FileDiff[] })),
      ),
      readSessionDiffBase(input.storage, input.sessionID),
    ],
    { concurrency: 4 },
  )
  const current = yield* cumulativeSessionDiff(input.storage, input.sessionID, active)
  const full = !stored.found
    ? calculated
    : base.length > 0
      ? appendSessionDiffs({ existing: stored.diffs, next: calculated })
      : calculated.length > 0
        ? calculated
        : stored.diffs
  if (!input.reverted) {
    yield* input.storage.write(key(input.sessionID), full).pipe(Effect.orDie)
  } else {
    yield* input.storage.read<Snapshot.FileDiff[]>(key(input.sessionID)).pipe(
      Effect.catch(() => input.storage.write(key(input.sessionID), full)),
      Effect.orDie,
    )
  }
  const start = first(input.messages)
  const point = latest(kept)
  const from =
    input.revert.partID && point?.type === "step-start" ? point.snapshot : (first(after) ?? point?.snapshot ?? start)
  const end = input.revert.snapshot ?? last(input.messages)
  const undone = from && end ? yield* input.snapshot.diffFull(from, end) : []
  return { active: current, undone } satisfies Diffs
})

export const restore = Effect.fn("KiloRevertDiff.restore")(function* (input: {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  storage: Storage.Interface
  summary: SessionSummary.Interface
}) {
  return yield* input.storage.read<Snapshot.FileDiff[]>(key(input.sessionID)).pipe(Effect.catch(() => calculate(input)))
})

export function clear(storage: Storage.Interface, id: SessionID) {
  return storage.remove(key(id)).pipe(Effect.ignore)
}

export function totals(diffs: ReadonlyArray<Snapshot.FileDiff>) {
  return {
    additions: diffs.reduce((sum, diff) => sum + diff.additions, 0),
    deletions: diffs.reduce((sum, diff) => sum + diff.deletions, 0),
    files: diffs.length,
    diffs: [],
  }
}
