/** @jsxImportSource solid-js */

/**
 * ChangedFilesOverview - persistent changed-files panel above the chat input.
 * Shows a summary button (file count + diff stats) that opens the full changes view,
 * plus an expandable inline list of individual changed files.
 */

import { type Component, For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import type { SessionDiffFile } from "../../types/messages"
import { useLanguage } from "../../context/language"
import { overview } from "./changed-files-overview"

interface Props {
  sessionID?: string
  files: SessionDiffFile[]
  onOpen: () => void
  onFileOpen: (file: string) => void
}

export const ChangedFilesOverview: Component<Props> = (props) => {
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(false)
  const data = createMemo(() => overview(props.files))

  createEffect(() => {
    void props.sessionID
    setExpanded(false)
  })

  const toggle = () => setExpanded((p) => !p)

  const summary = () =>
    data().files === 1
      ? language.t("sidebar.session.changedFiles.count.one")
      : language.t("sidebar.session.changedFiles.count.other", { files: data().files })

  const tooltip = () =>
    data().files === 1
      ? language.t("sidebar.session.showChanges.tooltip.one", {
          additions: data().additions,
          deletions: data().deletions,
        })
      : language.t("sidebar.session.showChanges.tooltip.other", {
          files: data().files,
          additions: data().additions,
          deletions: data().deletions,
        })

  return (
    <Show when={data().files > 0}>
      <div data-component="changed-files-overview">
        <div data-slot="header">
          <Tooltip value={tooltip()} placement="top">
            <Button
              data-slot="summary"
              variant="ghost"
              size="small"
              icon="layers"
              onClick={props.onOpen}
              aria-label={language.t("command.session.show.changes")}
            >
              <span data-slot="label">{summary()}</span>
              <span data-slot="additions">+{data().additions}</span>
              <span data-slot="deletions">-{data().deletions}</span>
            </Button>
          </Tooltip>
          <IconButton
            data-slot="toggle"
            variant="ghost"
            size="small"
            icon="chevron-down"
            aria-label={language.t(
              expanded() ? "sidebar.session.changedFiles.collapse" : "sidebar.session.changedFiles.expand",
            )}
            aria-expanded={expanded()}
            onClick={toggle}
          />
        </div>
        <Show when={expanded()}>
          <div data-slot="list">
            <For each={data().visible}>
              {(item) => (
                <Button data-slot="file" variant="ghost" size="small" onClick={() => props.onFileOpen(item.file)}>
                  <span data-slot="path">{item.file}</span>
                  <span data-slot="stats">
                    <Show when={item.additions > 0}>
                      <span data-slot="additions">+{item.additions}</span>
                    </Show>
                    <Show when={item.deletions > 0}>
                      <span data-slot="deletions">-{item.deletions}</span>
                    </Show>
                  </span>
                </Button>
              )}
            </For>
            <Show when={data().hidden > 0}>
              <Button data-slot="more" variant="ghost" size="small" onClick={props.onOpen}>
                {language.t("command.session.show.changes")}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
