/**
 * Utilities for the Changed Files Overview component.
 * Bridges webview <-> extension messages for requesting and opening file diffs.
 */

import type { SessionDiffFile, WebviewMessage } from "../../types/messages"

export const INLINE_FILE_LIMIT = 20

export interface DiffRequest {
  sessionID: string
  requestID: string
}

export function accepts(
  current: string | undefined,
  pending: DiffRequest | undefined,
  message: { sessionID: string; requestID?: string },
) {
  if (message.sessionID !== current) return false
  if (!message.requestID) return true
  return pending?.sessionID === message.sessionID && pending.requestID === message.requestID
}

export function overview(files: SessionDiffFile[]) {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    visible: files.slice(0, INLINE_FILE_LIMIT),
    hidden: Math.max(0, files.length - INLINE_FILE_LIMIT),
  }
}

export function requestFile(post: (msg: WebviewMessage) => void, sessionID: string, file: string, requestID: string) {
  post({ type: "requestSessionDiffFile", sessionID, file, requestID })
}

export function requestChanges(post: (msg: WebviewMessage) => void, sessionID: string) {
  post({ type: "openChanges", source: "session", sessionID })
}
