/** @jsxImportSource solid-js */

import { type Component, For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import type { SessionDiffFile, WebviewMessage } from "../../types/messages"
import { overview } from "./changed-files-overview"

interface Props {
  sessionID?: string
  files: SessionDiffFile[]
  canRedo: boolean
  onOpen: () => void
  onAction: (action: Extract<WebviewMessage, { type: "sessionReviewAction" }>["action"]) => void
}

export const ChangedFilesOverview: Component<Props> = (props) => {
  const [expanded, setExpanded] = createSignal(false)
  const [selected, setSelected] = createSignal<string>()
  const data = createMemo(() => overview(props.files))
  const canUndoAll = createMemo(() => props.files.length > 0 && props.files.every((file) => file.undoable))

  createEffect(() => {
    void props.sessionID
    setExpanded(false)
    setSelected(undefined)
  })

  return (
    <Show when={data().files > 0 || props.canRedo}>
      <div data-component="changed-files-overview">
        <div data-slot="header">
          <IconButton
            data-slot="toggle"
            variant="ghost"
            size="small"
            icon="chevron-down"
            aria-label={expanded() ? "Collapse changed files" : "Expand changed files"}
            aria-expanded={expanded()}
            onClick={() => setExpanded((value) => !value)}
          />
          <Button data-slot="summary" variant="ghost" size="small" onClick={() => setExpanded((value) => !value)}>
            <span data-slot="label">{data().files} Files</span>
          </Button>
          <div data-slot="actions">
            <Show when={props.canRedo}>
              <Button variant="ghost" size="small" onClick={() => props.onAction({ type: "redo" })}>
                Redo
              </Button>
            </Show>
            <Button
              variant="ghost"
              size="small"
              disabled={!canUndoAll()}
              onClick={() => props.onAction({ type: "undo-all" })}
            >
              Undo All
            </Button>
            <Button
              variant="ghost"
              size="small"
              disabled={data().files === 0}
              onClick={() => props.onAction({ type: "keep-all" })}
            >
              Keep All
            </Button>
            <Button data-slot="review" variant="secondary" size="small" onClick={props.onOpen}>
              Review
            </Button>
          </div>
        </div>
        <Show when={expanded()}>
          <div data-slot="list">
            <For each={data().visible}>
              {(file) => (
                <div data-slot="file-group">
                  <div data-slot="file-row">
                    <Button
                      data-slot="file"
                      variant="ghost"
                      size="small"
                      onClick={() => setSelected((value) => (value === file.file ? undefined : file.file))}
                    >
                      <span data-slot="path">{file.file}</span>
                      <span data-slot="stats">
                        <Show when={file.additions > 0}>
                          <span data-slot="additions">+{file.additions}</span>
                        </Show>
                        <Show when={file.deletions > 0}>
                          <span data-slot="deletions">-{file.deletions}</span>
                        </Show>
                      </span>
                    </Button>
                    <div data-slot="file-actions">
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={!file.undoable}
                        onClick={() => props.onAction({ type: "undo-file", file: file.file })}
                      >
                        Undo File
                      </Button>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => props.onAction({ type: "keep-file", file: file.file })}
                      >
                        Keep File
                      </Button>
                    </div>
                  </div>
                  <Show when={selected() === file.file}>
                    <div data-slot="hunks">
                      <For each={file.hunks}>
                        {(hunk) => (
                          <div data-slot="hunk">
                            <span data-slot="hunk-label">{hunk.label}</span>
                            <span data-slot="stats">
                              <Show when={hunk.additions > 0}>
                                <span data-slot="additions">+{hunk.additions}</span>
                              </Show>
                              <Show when={hunk.deletions > 0}>
                                <span data-slot="deletions">-{hunk.deletions}</span>
                              </Show>
                            </span>
                            <Button
                              variant="ghost"
                              size="small"
                              onClick={() => props.onAction({ type: "undo-hunk", file: file.file, hunk: hunk.id })}
                            >
                              Undo ⌘N
                            </Button>
                            <Button
                              variant="ghost"
                              size="small"
                              onClick={() => props.onAction({ type: "keep-hunk", file: file.file, hunk: hunk.id })}
                            >
                              Keep ⌘Y
                            </Button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={data().hidden > 0}>
              <Button data-slot="more" variant="ghost" size="small" onClick={props.onOpen}>
                Open review
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}
