/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { ChapterRow, HighlightRow } from "./chapter.js"
import { TimelineHeader } from "./header.js"
import { createTimelineState } from "./state.js"
import { clampSelection, flattenRows, newestChapterID, type TimelineRow } from "./view.js"

export function TimelinePanel(props: { readonly context: Context; readonly panel: PanelInput }) {
  const state = createTimelineState(props.context, props.panel.sessionID)
  const isChild = createMemo(() => Boolean(props.context.data.session.get(props.panel.sessionID)?.parentID))
  const [selected, setSelected] = createSignal(0)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()

  const rows = createMemo(() => {
    const value = state.document()
    return value ? flattenRows(value, expanded()) : []
  })
  const selectedRow = createMemo(() => rows()[clampSelection(selected(), rows())])

  // Child sessions have no timeline; never call `ensure` for them.
  onMount(() => {
    if (!isChild()) void state.load()
  })

  // Expand the newest chapter the first time a document with chapters arrives.
  // The flag is set before the writes so the effect cannot re-enter itself.
  const [initialized, setInitialized] = createSignal(false)
  createEffect(() => {
    const value = state.document()
    if (!value || initialized()) return
    const newest = newestChapterID(value)
    if (!newest) return
    setInitialized(true)
    const next = new Set([newest])
    setExpanded(next)
    const index = flattenRows(value, next).findIndex((row) => row.kind === "chapter" && row.chapterID === newest)
    if (index >= 0) setSelected(index)
  })

  createEffect(() => {
    const row = selectedRow()
    const box = scroll()
    if (row && box) box.scrollChildIntoView(rowID(row))
  })

  const progressText = () => {
    const value = state.progress()
    if (!value) return "Building recap…"
    return `Building recap… ${value.processed}/${value.total} messages`
  }

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.raised.base}>
      <Show
        when={!isChild()}
        fallback={<text fg={props.context.theme.text.muted}>Recap is available for root sessions.</text>}
      >
        <Show when={!state.loading()} fallback={<text fg={props.context.theme.text.muted}>Loading recap…</text>}>
          <Show
            when={!state.disabledReason()}
            fallback={<text fg={props.context.theme.text.muted}>{state.disabledReason()}</text>}
          >
            <Show
              when={!state.requestError()}
              fallback={<text fg={props.context.theme.text.feedback.error.base}>{state.requestError()}</text>}
            >
              <Show
                when={state.document()}
                fallback={
                  <box flexDirection="column">
                    <text fg={props.context.theme.text.base}>Build recap from this session's history</text>
                    <Show when={state.busy()}>
                      <text fg={props.context.theme.text.feedback.info.base}>{progressText()}</text>
                    </Show>
                    <Show when={state.estimate()}>
                      <text fg={props.context.theme.text.muted}>
                        ~{state.estimate()?.approxCalls} model calls over {state.estimate()?.messages} messages
                      </text>
                    </Show>
                    <text fg={props.context.theme.text.muted}>Press b to build the recap.</text>
                  </box>
                }
              >
                {(document) => (
                  <box flexDirection="column" flexGrow={1}>
                    <TimelineHeader
                      context={props.context}
                      document={document()}
                      busy={state.busy()}
                      disabled={Boolean(state.disabledReason())}
                    />
                    <Show when={state.busy() || document().status === "backfilling"}>
                      <text fg={props.context.theme.text.feedback.info.base}>{progressText()}</text>
                    </Show>
                    <Show when={document().status === "paused"}>
                      <text fg={props.context.theme.text.feedback.warning.base}>
                        Backfill paused. Press r to resume.
                      </text>
                    </Show>
                    <Show when={document().status === "error"}>
                      <text fg={props.context.theme.text.feedback.error.base}>
                        {state.error()?.message ?? "Recap failed."}
                      </text>
                    </Show>
                    <Show
                      when={document().watermark === null}
                      fallback={
                        <Show
                          when={rows().length > 0}
                          fallback={
                            <text fg={props.context.theme.text.muted}>
                              No milestones found yet. New activity will update this recap.
                            </text>
                          }
                        >
                          <scrollbox ref={(value) => setScroll(value)} flexGrow={1} width="100%">
                            <For each={rows()}>
                              {(row) => (
                                <Show
                                  when={row.kind === "chapter"}
                                  fallback={
                                    row.kind === "highlight" ? (
                                      <HighlightRow
                                        context={props.context}
                                        highlight={row.highlight}
                                        selected={row.ordinal === selectedRow()?.ordinal}
                                      />
                                    ) : null
                                  }
                                >
                                  {row.kind === "chapter" ? (
                                    <ChapterRow
                                      context={props.context}
                                      chapter={row.chapter}
                                      expanded={row.expanded}
                                      selected={row.ordinal === selectedRow()?.ordinal}
                                    />
                                  ) : null}
                                </Show>
                              )}
                            </For>
                          </scrollbox>
                        </Show>
                      }
                    >
                      <box flexDirection="column">
                        <text fg={props.context.theme.text.base}>Build recap from this session's history</text>
                        <Show when={state.busy()}>
                          <text fg={props.context.theme.text.feedback.info.base}>{progressText()}</text>
                        </Show>
                        <Show when={state.estimate()}>
                          <text fg={props.context.theme.text.muted}>
                            ~{state.estimate()?.approxCalls} model calls over {state.estimate()?.messages} messages
                          </text>
                        </Show>
                        <text fg={props.context.theme.text.muted}>Press b to build the recap.</text>
                      </box>
                    </Show>
                    <text fg={props.context.theme.text.faint}>
                      j/k move · enter expand · x excerpt · r refresh · b build · c cancel
                    </text>
                  </box>
                )}
              </Show>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

function rowID(row: TimelineRow): string {
  return row.kind === "chapter" ? `timeline-chapter-${row.chapter.id}` : `timeline-highlight-${row.highlight.id}`
}
