import { expect, test } from "@playwright/test"

const STORY = "chat--changed-files-review-controls"
const GLOBALS = "colorScheme:dark;theme:kilo-vscode;vscodeTheme:dark-modern"

test("changed files card exposes bulk, file, and command-hunk actions", async ({ page }) => {
  await page.goto(`/iframe.html?id=${STORY}&viewMode=story&globals=${GLOBALS}`, { waitUntil: "load" })

  const card = page.locator('[data-component="changed-files-overview"]')
  await expect(card.getByText("2 Files")).toBeVisible()
  await expect(card.getByText("Undo All")).toBeVisible()
  await expect(card.getByText("Keep All")).toBeVisible()
  await expect(card.getByText("Review", { exact: true })).toBeVisible()

  await card.getByText("2 Files").click()
  await card.getByText("src/InspectObjectPage.tsx").click()
  await expect(card.getByText("Undo ⌘N").first()).toBeVisible()
  await page.keyboard.press("Meta+n")
  await expect(page.getByTestId("last-review-action")).toHaveText(
    '{"type":"undo-hunk","file":"src/InspectObjectPage.tsx","hunk":"hunk-a"}',
  )

  await card.getByText("Keep File").first().click()
  await expect(page.getByTestId("last-review-action")).toHaveText(
    '{"type":"keep-file","file":"src/InspectObjectPage.tsx"}',
  )
})
