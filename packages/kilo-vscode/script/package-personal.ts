import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

export const PERSONAL = {
  name: "kilo-code-personal",
  publisher: "jackson",
  displayName: "Jackson Code",
  id: "jackson.kilo-code-personal",
  version: "7.4.18-jackson.1",
} as const

const ICON = "assets/icons/jackson-code"

const ids = [
  ["kilocode.kilo-code", PERSONAL.id],
  ["kilo-code.new", "kilo-code.personal"],
  ["kilo-code.SidebarProvider", "kilo-code-personal.SidebarProvider"],
  ["kilo-code-ActivityBar", "kilo-code-personal-ActivityBar"],
  ["kilo-code.nextEdit", "kilo-code-personal.nextEdit"],
  ["kilocode.autocomplete.", "kilo-code.personal.autocomplete."],
  ["kilo-worktree-setup", "kilo-personal-worktree-setup"],
  ["kilo-logo", "kilo-personal-logo"],
] as const

export function runtime(source: string) {
  return ids.reduce((text, [from, to]) => text.replaceAll(from, to), source)
}

export function branding(source: string) {
  return runtime(source).replaceAll("Kilo Code", PERSONAL.displayName)
}

export function manifest(source: string) {
  return branding(source)
    .replace('Id="kilo-code"', `Id="${PERSONAL.name}"`)
    .replace('Publisher="kilocode"', `Publisher="${PERSONAL.publisher}"`)
    .replace(/(<Identity\b[^>]*\bVersion=")[^"]+/, `$1${PERSONAL.version}`)
    .replace(/<DisplayName>[^<]*<\/DisplayName>/, `<DisplayName>${PERSONAL.displayName}</DisplayName>`)
    .replace("extension/assets/icons/logo-outline-black.png", `extension/${ICON}.png`)
    .replace('Value="#FFFFFF"', 'Value="#101820"')
    .replace('Value="light"', 'Value="dark"')
}

export function metadata(source: string) {
  const data = JSON.parse(source) as Record<string, unknown>
  data.name = PERSONAL.name
  data.publisher = PERSONAL.publisher
  data.version = PERSONAL.version
  const text = branding(JSON.stringify(data))
  const branded = JSON.parse(text) as Record<string, unknown>
  branded.displayName = PERSONAL.displayName
  branded.icon = `${ICON}.png`
  branded.galleryBanner = { color: "#101820", theme: "dark" }
  const contributes = branded.contributes as {
    viewsContainers?: { activitybar?: Array<Record<string, unknown>> }
  }
  for (const container of contributes.viewsContainers?.activitybar ?? []) {
    container.title = PERSONAL.displayName
    container.icon = `${ICON}.svg`
    container.darkIcon = `${ICON}.svg`
  }
  return JSON.stringify(branded, null, 2) + "\n"
}

async function files(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(dir, entry.name)
        return entry.isDirectory() ? files(file) : [file]
      }),
    )
  ).flat()
}

async function command(args: string[], cwd?: string) {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${args[0]} exited with code ${code}`)
}

async function main() {
  const input = process.argv[2]
  const output = process.argv[3]
  if (!input || !output) throw new Error("Usage: bun script/package-personal.ts <input.vsix> <output.vsix>")

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-personal-"))
  return command(["unzip", "-q", path.resolve(input), "-d", dir])
    .then(async () => {
      const root = path.join(dir, "extension")
      const pkg = path.join(root, "package.json")
      const xml = path.join(dir, "extension.vsixmanifest")
      await Promise.all([
        fs.readFile(pkg, "utf8").then((text) => fs.writeFile(pkg, metadata(text))),
        fs.readFile(xml, "utf8").then((text) => fs.writeFile(xml, manifest(text))),
        fs.copyFile(path.join(import.meta.dir, "..", `${ICON}.svg`), path.join(root, `${ICON}.svg`)),
        fs.copyFile(path.join(import.meta.dir, "..", `${ICON}.png`), path.join(root, `${ICON}.png`)),
      ])
      const dist = await files(path.join(root, "dist"))
      await Promise.all(
        dist
          .filter((file) => file.endsWith(".js"))
          .map((file) => fs.readFile(file, "utf8").then((text) => fs.writeFile(file, branding(text)))),
      )
      await fs.rm(path.resolve(output), { force: true })
      await command(["zip", "-qr", path.resolve(output), "."], dir)
      console.log(`Created ${path.resolve(output)} as ${PERSONAL.id}`)
    })
    .finally(() => fs.rm(dir, { recursive: true, force: true }))
}

if (import.meta.main) {
  await main()
}
