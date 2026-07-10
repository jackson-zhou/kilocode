import { describe, expect, it } from "bun:test"
import { handleSidebarWorktreeMessage } from "../../src/kilo-provider/sidebar-worktree"

describe("sidebar worktree changes routing", () => {
  it("prefers the session rendered by the webview over stale extension state", async () => {
    const calls: Array<[string | undefined, string | undefined, "session" | "workspace" | undefined]> = []
    const ctx = {
      post: () => {},
      openAgentManager: async () => {},
      openAdvancedWorktree: async () => {},
      openChanges: async (sessionID?: string, turnID?: string, source?: "session" | "workspace") => {
        calls.push([sessionID, turnID, source])
      },
      currentSessionId: "session-a",
    }

    await handleSidebarWorktreeMessage({ type: "openChanges", sessionID: "session-b", source: "session" }, ctx)
    await handleSidebarWorktreeMessage({ type: "openChanges", source: "workspace" }, ctx)

    expect(calls).toEqual([
      ["session-b", undefined, "session"],
      ["session-a", undefined, "workspace"],
    ])
  })
})
