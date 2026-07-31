import { describe, expect, it } from "bun:test"
import { PERSONAL, manifest, metadata, runtime } from "../../script/package-personal"

describe("personal extension packaging", () => {
  it("isolates runtime contribution namespaces", () => {
    const source = [
      "kilocode.kilo-code",
      "kilo-code.new.showChanges",
      "kilo-code.SidebarProvider",
      "kilo-code-ActivityBar",
      "kilo-code.nextEdit.hasPendingSuggestion",
      "kilocode.autocomplete.enableSmartInlineTaskKeybinding",
      "kilo-worktree-setup",
      "kilo-logo",
    ].join("\n")

    expect(runtime(source)).not.toContain("kilocode.kilo-code")
    expect(runtime(source)).toContain("jackson.kilo-code-personal")
    expect(runtime(source)).toContain("kilo-code.personal.showChanges")
    expect(runtime(source)).toContain("kilo-code-personal.SidebarProvider")
    expect(runtime(source)).toContain("kilo-code-personal-ActivityBar")
    expect(runtime(source)).toContain("kilo-code.personal.autocomplete.enableSmartInlineTaskKeybinding")
  })

  it("changes VSIX and package identities", () => {
    const xml = '<Identity Id="kilo-code" Publisher="kilocode" /><DisplayName>Kilo Code Official</DisplayName>'
    expect(manifest(xml)).toContain(`Id="${PERSONAL.name}"`)
    expect(manifest(xml)).toContain(`Publisher="${PERSONAL.publisher}"`)
    expect(manifest(xml)).toContain(`<DisplayName>${PERSONAL.displayName}</DisplayName>`)

    const pkg = metadata(
      JSON.stringify({
        name: "kilo-code",
        publisher: "kilocode",
        displayName: "Kilo Code",
        contributes: { commands: [{ command: "kilo-code.new.showChanges", category: "Kilo Code" }] },
      }),
    )
    expect(JSON.parse(pkg)).toMatchObject({
      name: PERSONAL.name,
      publisher: PERSONAL.publisher,
      displayName: PERSONAL.displayName,
    })
    expect(pkg).toContain("kilo-code.personal.showChanges")
    expect(pkg).toContain("Kilo Code Personal")
  })
})
