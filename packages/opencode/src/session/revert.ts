import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Log } from "@opencode-ai/core/util/log"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import * as KiloRevertDiff from "@/kilocode/session/revert-diff" // kilocode_change

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: SessionV1.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)

      // kilocode_change start
      const diffs = yield* KiloRevertDiff.prepare({
        sessionID: input.sessionID,
        messages: all,
        revert: rev,
        storage,
        summary,
        snapshot: snap,
        reverted: !!session.revert,
      })
      // kilocode_change end

      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
      // kilocode_change start
      const summaryDiffs: Snapshot.SummaryFileDiff[] = diffs.undone.map((d) => ({
        file: d.file,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status,
      }))
      yield* KiloRevertDiff.change(
        input.sessionID,
        Effect.gen(function* () {
          yield* KiloRevertDiff.save(storage, input.sessionID, diffs.active)
          yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs.active })
          yield* sessions.setRevert({
            sessionID: input.sessionID,
            revert: rev,
            summary: {
              additions: diffs.undone.reduce((sum, x) => sum + x.additions, 0),
              deletions: diffs.undone.reduce((sum, x) => sum + x.deletions, 0),
              files: diffs.undone.length,
              diffs: summaryDiffs,
            },
          })
        }),
      )
      // kilocode_change end
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      // kilocode_change start - restore the active cumulative diff and notify SSE consumers
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      const diffs = yield* KiloRevertDiff.restore({ sessionID: input.sessionID, messages: all, storage, summary })
      yield* KiloRevertDiff.change(
        input.sessionID,
        Effect.gen(function* () {
          yield* KiloRevertDiff.save(storage, input.sessionID, diffs)
          yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
          yield* sessions.setSummary({ sessionID: input.sessionID, summary: KiloRevertDiff.totals(diffs) })
          yield* sessions.clearRevert(input.sessionID)
          yield* KiloRevertDiff.clear(storage, input.sessionID)
        }),
      )
      // kilocode_change end
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as SessionV1.WithParts[]
      let target: SessionV1.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
          // kilocode_change start - clear a reverted provider error from the retained assistant message
          if (target.info.role === "assistant" && target.info.error) {
            delete target.info.error
            yield* sessions.updateMessage(target.info)
          }
          // kilocode_change end
        }
      }
      // kilocode_change start - keep summary totals aligned with the permanently retained session diff
      const diffs = yield* sessions.diff(sessionID)
      yield* KiloRevertDiff.change(
        sessionID,
        Effect.gen(function* () {
          yield* sessions.setSummary({ sessionID, summary: KiloRevertDiff.totals(diffs) })
          yield* sessions.clearRevert(sessionID)
          yield* KiloRevertDiff.clear(storage, sessionID)
        }),
      )
      // kilocode_change end
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
