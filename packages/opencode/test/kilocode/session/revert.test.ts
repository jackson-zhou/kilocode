import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Effect, Exit, Layer, Queue } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Bus } from "@/bus"
import * as KiloRevertDiff from "@/kilocode/session/revert-diff"
import { baseKey } from "@/kilocode/session-portability/cumulative-diff"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../../lib/effect"

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionRunState.defaultLayer,
  Snapshot.defaultLayer,
  Storage.defaultLayer,
  Bus.defaultLayer,
  SyncEvent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const files = (diffs: ReadonlyArray<Snapshot.FileDiff>) =>
  diffs.map((diff) => diff.file ?? "").toSorted((a, b) => a.localeCompare(b))

const user = Effect.fn("test.user")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  return yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "default",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const sessions = yield* Session.Service
  return yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
})

const turn = Effect.fn("test.turn")(function* (sessionID: SessionID, dir: string, file: string, text: string) {
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const prompt = yield* user(sessionID)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: prompt.id,
    sessionID,
    type: "text",
    text: `${file}:${text}`,
  })
  const reply = yield* assistant(sessionID, prompt.id, dir)
  const before = yield* snapshot.track()
  if (!before) throw new Error("expected snapshot before turn")
  yield* write(path.join(dir, file), text)
  const after = yield* snapshot.track()
  if (!after) throw new Error("expected snapshot after turn")
  const patch = yield* snapshot.patch(before)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reply.id,
    sessionID,
    type: "step-start",
    snapshot: before,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reply.id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: after,
    cost: 0,
    tokens,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reply.id,
    sessionID,
    type: "patch",
    hash: patch.hash,
    files: patch.files,
  })
  return prompt
})

const foreign = Effect.fn("test.foreign")(function* (sessionID: SessionID, dir: string) {
  const sessions = yield* Session.Service
  const prompt = yield* user(sessionID)
  const reply = yield* assistant(sessionID, prompt.id, dir)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reply.id,
    sessionID,
    type: "step-start",
    snapshot: "0".repeat(40),
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: reply.id,
    sessionID,
    type: "step-finish",
    reason: "stop",
    snapshot: "1".repeat(40),
    cost: 0,
    tokens,
  })
})

describe("session revert", () => {
  it.live(
    "clears provider errors when the revert becomes permanent",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const session = yield* sessions.create({})
          const providerID = ProviderV2.ID.make("test")
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 1,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "error",
            error: MessageV2.fromError(new Error("Provider returned error"), { providerID }),
          })
          const kept = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "keep",
          })
          const boundary = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "remove",
          })

          yield* sessions.setRevert({
            sessionID: session.id,
            revert: { messageID: assistant.id, partID: boundary.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* revert.cleanup(yield* sessions.get(session.id))

          const messages = yield* sessions.messages({ sessionID: session.id })
          const result = messages.find((message) => message.info.id === assistant.id)
          expect(result?.parts.map((part) => part.id)).toEqual([kept.id])
          expect(result?.info).not.toHaveProperty("error")
        }),
      { git: true },
    ),
  )

  it.live(
    "keeps session_diff active while summary diffs describe the undone range",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const bus = yield* Bus.Service
          const session = yield* sessions.create({})
          yield* write(path.join(dir, "a.txt"), "a0\n")
          yield* write(path.join(dir, "b.txt"), "b0\n")

          yield* turn(session.id, dir, "a.txt", "a1\n")
          const second = yield* turn(session.id, dir, "b.txt", "b1\n")
          yield* summary.summarize({ sessionID: session.id, messageID: second.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt", "b.txt"])

          const events = yield* Queue.unbounded<ReadonlyArray<Snapshot.FileDiff>>()
          const off = yield* bus.subscribeCallback(Session.Event.Diff, (event) =>
            Queue.offerUnsafe(events, event.properties.diff),
          )
          yield* Effect.addFinalizer(() => Effect.sync(off))

          const info = yield* revert.revert({ sessionID: session.id, messageID: second.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt"])
          expect(files(info.summary?.diffs ?? [])).toEqual(["b.txt"])
          expect(
            files(yield* awaitWithTimeout(Queue.take(events), "revert did not publish an active session diff")),
          ).toEqual(["a.txt"])

          const restored = yield* revert.unrevert({ sessionID: session.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt", "b.txt"])
          expect(restored.summary).toEqual({ additions: 2, deletions: 2, files: 2, diffs: [] })
          expect(
            files(yield* awaitWithTimeout(Queue.take(events), "unrevert did not publish the full session diff")),
          ).toEqual(["a.txt", "b.txt"])
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b1\n")
        }),
      { git: true },
    ),
  )

  it.live(
    "retains imported and local diffs when imported snapshot hashes are unavailable",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const storage = yield* Storage.Service
          const session = yield* sessions.create({})
          const base: Snapshot.FileDiff[] = [
            { file: "imported.txt", additions: 1, deletions: 0, status: "added", patch: "" },
          ]
          yield* storage.write(baseKey(session.id), base)
          yield* storage.write(["session_diff", session.id], base)
          yield* foreign(session.id, dir)
          yield* write(path.join(dir, "first.txt"), "old\n")
          yield* write(path.join(dir, "second.txt"), "old\n")

          const first = yield* turn(session.id, dir, "first.txt", "new\n")
          yield* summary.summarize({ sessionID: session.id, messageID: first.id })
          const second = yield* turn(session.id, dir, "second.txt", "new\n")
          yield* summary.summarize({ sessionID: session.id, messageID: second.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["first.txt", "imported.txt", "second.txt"])

          const info = yield* revert.revert({ sessionID: session.id, messageID: second.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["first.txt", "imported.txt"])
          expect(files(info.summary?.diffs ?? [])).toEqual(["second.txt"])

          yield* revert.unrevert({ sessionID: session.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["first.txt", "imported.txt", "second.txt"])
        }),
      { git: true },
    ),
  )

  it.live(
    "rejects a stale summary and restores its unsaved full diff",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const storage = yield* Storage.Service
          const session = yield* sessions.create({})
          yield* write(path.join(dir, "a.txt"), "a0\n")
          yield* write(path.join(dir, "b.txt"), "b0\n")

          const first = yield* turn(session.id, dir, "a.txt", "a1\n")
          yield* summary.summarize({ sessionID: session.id, messageID: first.id })
          const second = yield* turn(session.id, dir, "b.txt", "b1\n")
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt"])
          const committed = yield* KiloRevertDiff.watch(session.id, (token) =>
            Effect.gen(function* () {
              const messages = yield* sessions.messages({ sessionID: session.id })
              const stale = yield* summary.computeDiff({ messages })
              yield* revert.revert({ sessionID: session.id, messageID: second.id })
              return yield* KiloRevertDiff.guard({
                token,
                effect: storage.write(["session_diff", session.id], stale),
              })
            }),
          )

          expect(committed).toBe(false)
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt"])
          yield* revert.unrevert({ sessionID: session.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt", "b.txt"])
        }),
      { git: true },
    ),
  )

  it.live(
    "resets summary totals when a revert becomes permanent",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const session = yield* sessions.create({})
          yield* write(path.join(dir, "a.txt"), "a0\n")
          yield* write(path.join(dir, "b.txt"), "b0\n")

          yield* turn(session.id, dir, "a.txt", "a1\n")
          const second = yield* turn(session.id, dir, "b.txt", "b1\n")
          yield* summary.summarize({ sessionID: session.id, messageID: second.id })
          const reverted = yield* revert.revert({ sessionID: session.id, messageID: second.id })
          expect(files(reverted.summary?.diffs ?? [])).toEqual(["b.txt"])

          yield* revert.cleanup(reverted)
          const info = yield* sessions.get(session.id)
          expect(info.revert).toBeUndefined()
          expect(info.summary).toEqual({ additions: 1, deletions: 1, files: 1, diffs: [] })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt"])
        }),
      { git: true },
    ),
  )

  it.live(
    "retains the full diff backup when unrevert persistence fails",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const snapshot = yield* Snapshot.Service
          const storage = yield* Storage.Service
          const bus = yield* Bus.Service
          const state = yield* SessionRunState.Service
          const sync = yield* SyncEvent.Service
          const session = yield* sessions.create({})
          yield* write(path.join(dir, "a.txt"), "a0\n")
          yield* write(path.join(dir, "b.txt"), "b0\n")

          yield* turn(session.id, dir, "a.txt", "a1\n")
          const second = yield* turn(session.id, dir, "b.txt", "b1\n")
          yield* summary.summarize({ sessionID: session.id, messageID: second.id })
          yield* revert.revert({ sessionID: session.id, messageID: second.id })

          const failed: Storage.Interface = {
            ...storage,
            write: (key, content) =>
              key[0] === "session_diff" && key[1] === session.id
                ? Effect.die(new Error("injected session_diff write failure"))
                : storage.write(key, content),
          }
          const deps = Layer.mergeAll(
            Layer.succeed(Session.Service, sessions),
            Layer.succeed(Snapshot.Service, snapshot),
            Layer.succeed(Storage.Service, failed),
            Layer.succeed(Bus.Service, bus),
            Layer.succeed(SessionSummary.Service, summary),
            Layer.succeed(SessionRunState.Service, state),
            Layer.succeed(SyncEvent.Service, sync),
          )
          const context = yield* Layer.build(Layer.fresh(SessionRevert.layer).pipe(Layer.provide(deps)))
          const faulty = Context.get(context, SessionRevert.Service)
          const exit = yield* Effect.exit(faulty.unrevert({ sessionID: session.id }))

          expect(Exit.isFailure(exit)).toBe(true)
          expect((yield* sessions.get(session.id)).revert).toBeDefined()
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt"])

          yield* revert.unrevert({ sessionID: session.id })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt", "b.txt"])
        }),
      { git: true },
    ),
  )

  it.live(
    "uses the last retained step as the partial revert diff boundary",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const summary = yield* SessionSummary.Service
          const snapshot = yield* Snapshot.Service
          const session = yield* sessions.create({})
          yield* write(path.join(dir, "a.txt"), "a0\n")
          yield* write(path.join(dir, "b.txt"), "b0\n")
          const prompt = yield* user(session.id)
          const reply = yield* assistant(session.id, prompt.id, dir)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "text",
            text: "keep",
          })

          const first = yield* snapshot.track()
          if (!first) throw new Error("expected first snapshot")
          yield* write(path.join(dir, "a.txt"), "a1\n")
          const middle = yield* snapshot.track()
          if (!middle) throw new Error("expected middle snapshot")
          const firstPatch = yield* snapshot.patch(first)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: first,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: middle,
            cost: 0,
            tokens,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "patch",
            hash: firstPatch.hash,
            files: firstPatch.files,
          })
          const boundary = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "text",
            text: "undo from here",
          })

          yield* write(path.join(dir, "b.txt"), "b1\n")
          const last = yield* snapshot.track()
          if (!last) throw new Error("expected last snapshot")
          const secondPatch = yield* snapshot.patch(middle)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: middle,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: last,
            cost: 0,
            tokens,
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: reply.id,
            sessionID: session.id,
            type: "patch",
            hash: secondPatch.hash,
            files: secondPatch.files,
          })
          yield* summary.summarize({ sessionID: session.id, messageID: prompt.id })

          const info = yield* revert.revert({
            sessionID: session.id,
            messageID: reply.id,
            partID: boundary.id,
          })
          expect(files(yield* sessions.diff(session.id))).toEqual(["a.txt"])
          expect(files(info.summary?.diffs ?? [])).toEqual(["b.txt"])
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1\n")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0\n")
        }),
      { git: true },
    ),
  )
})
