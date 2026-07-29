/** @jsxImportSource solid-js */

import { type Component, For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import type { SessionDiffFile } from "../../types/messages"
import { overview } from "./changed-files-overview"

interface Props {
  sessionID?: string
  files: SessionDiffFile[]
  onOpen: () => void
}

export const ChangedFilesOverview: Component<Props> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const data = createMemo(() => overview(props.files))

  createEffect(() => {
    void props.sessionID
    setExpanded(false)
  })

  return (
    <Show when={data().files > 0}>
      <div data-component="changed-files-overview">
        <div data-slot="header">
          <Button data-slot="summary" variant="ghost" size="small" icon="layers" onClick={props.onOpen}>
            <span data-slot="label">{data().files} Changed Files</span>
            <span data-slot="additions">+{data().additions}</span>
            <span data-slot="deletions">-{data().deletions}</span>
          </Button>
          <IconButton
            data-slot="toggle"
            variant="ghost"
            size="small"
            icon="chevron-down"
            aria-label={expanded() ? "Collapse changed files" : "Expand changed files"}
            aria-expanded={expanded()}
            onClick={() => setExpanded((value) => !value)}
          />
        </div>
        <Show when={expanded()}>
          <div data-slot="list">
            <For each={data().visible}>
              {(file) => (
                <Button data-slot="file" variant="ghost" size="small" onClick={props.onOpen}>
                  <span data-slot="path">{file.file}</span>
                  <span data-slot="stats">
                    <Show when={file.additions > 0}><span data-slot="additions">+{file.additions}</span></Show>
                    <Show when={file.deletions > 0}><span data-slot="deletions">-{file.deletions}</span></Show>
                  </span>
                </Button>
              )}
            </For>
            <Show when={data().hidden > 0}>
              <Button data-slot="more" variant="ghost" size="small" onClick={props.onOpen}>Open review</Button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
