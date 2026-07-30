import type { SessionDiffFile, WebviewMessage } from "../../types/messages"

export const INLINE_FILE_LIMIT = 20

export function overview(files: SessionDiffFile[]) {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    visible: files.slice(0, INLINE_FILE_LIMIT),
    hidden: Math.max(0, files.length - INLINE_FILE_LIMIT),
  }
}

export function request(post: (msg: WebviewMessage) => void, sessionID: string, requestID: string) {
  post({ type: "requestSessionDiff", sessionID, requestID })
}

export function shortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">) {
  if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
  if (event.key.toLowerCase() === "n") return "undo"
  if (event.key.toLowerCase() === "y") return "keep"
}
