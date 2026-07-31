import { describe, expect, it } from "bun:test"
import { PERSONAL, branding, manifest, metadata, runtime } from "../../script/package-personal"

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
    const xml =
      '<PackageManifest Version="2.0.0"><Identity Id="kilo-code" Version="7.4.17" Publisher="kilocode" /><DisplayName>Kilo Code Official</DisplayName><Icon>extension/assets/icons/logo-outline-black.png</Icon></PackageManifest>'
    expect(manifest(xml)).toContain(`Id="${PERSONAL.name}"`)
    expect(manifest(xml)).toContain(`Publisher="${PERSONAL.publisher}"`)
    expect(manifest(xml)).toContain(`Version="${PERSONAL.version}"`)
    expect(manifest(xml)).toContain('PackageManifest Version="2.0.0"')
    expect(manifest(xml)).toContain(`<DisplayName>${PERSONAL.displayName}</DisplayName>`)
    expect(manifest(xml)).toContain("extension/assets/icons/jackson-code.png")

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
      version: PERSONAL.version,
      icon: "assets/icons/jackson-code.png",
    })
    expect(pkg).toContain("kilo-code.personal.showChanges")
    expect(pkg).toContain("Jackson Code")
    expect(branding("Open Kilo Code")).toBe("Open Jackson Code")
  })
})
