/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { CONFIG_SNIPPET } from "../config.js"
import { PANEL_NAME } from "../shared/ids.js"
import { ChapterRow, HighlightRow } from "./chapter.js"
import { openExcerpt } from "./excerpt.js"
import { TimelineHeader } from "./header.js"
import { createTimelineState, type TimelineState } from "./state.js"
import { clampSelection, flattenRows, newestChapterID, type TimelineRow } from "./view.js"

/**
 * The host reuses the `session.panel` claim when `ui.panel.open` targets a
 * different session. Key the panel by session so its RPC state, event
 * subscriptions, and selection are recreated instead of staying bound to the
 * session that happened to be open first.
 */
export function TimelineSlot(props: { readonly context: Context; readonly panel: PanelInput }) {
  return (
    <Show keyed when={props.panel.name === PANEL_NAME ? props.panel.sessionID : undefined}>
      {(_sessionID) => <TimelinePanel context={props.context} panel={props.panel} />}
    </Show>
  )
}

export function TimelinePanel(props: { readonly context: Context; readonly panel: PanelInput }) {
  const state = createTimelineState(props.context, props.panel.sessionID)
  const isChild = createMemo(() => Boolean(props.context.data.session.get(props.panel.sessionID)?.parentID))
  const document = () => state.document()
  const [selected, setSelected] = createSignal(0)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()

  const rows = createMemo(() => {
    const value = document()
    return value ? flattenRows(value, expanded()) : []
  })
  const selectedRow = createMemo(() => rows()[clampSelection(selected(), rows())])

  const paused = () => document()?.status === "paused"
  const backfilling = () => document()?.status === "backfilling"
  const backfillIncomplete = () => {
    const backfill = document()?.backfill
    return backfill !== null && backfill !== undefined && backfill.completedAt === undefined
  }
  const hasRenderable = () => {
    const value = document()
    return value !== null && (value.watermark !== null || value.chapters.length > 0)
  }
  const emptySession = () => {
    const value = document()
    return (
      value !== null &&
      value.status === "empty" &&
      value.watermark === null &&
      value.chapters.length === 0 &&
      !state.needsBackfill() &&
      !state.busy()
    )
  }
  const errorMessage = () => state.error()?.message ?? document()?.meta.lastError?.message ?? "Recap update failed"
  // A notice already explains the state (and often the action), so it replaces
  // the generic stale badge. Rendering both as adjacent Show text nodes also
  // overlaps them in the terminal layout.
  const banner = () => {
    const value = document()
    const notice = value?.meta.notice
    if (notice) return notice.message
    if (value?.status === "stale") return "New activity — r to refresh"
    return undefined
  }
  const pausedAt = () => {
    const backfill = document()?.backfill
    return backfill ? `${backfill.processedMessages}/${backfill.totalMessages}` : "unknown"
  }
  const progressValue = () => {
    const live = state.progress()
    if (live) return { processed: live.processed, total: live.total }
    const backfill = document()?.backfill
    if (backfill) return { processed: backfill.processedMessages, total: backfill.totalMessages }
    return undefined
  }
  const progressBar = () => {
    const value = progressValue()
    if (!value) return ""
    const width = 10
    const total = Math.max(1, value.total)
    const filled = Math.max(0, Math.min(width, Math.round((value.processed / total) * width)))
    return `${"█".repeat(filled)}${"░".repeat(width - filled)} `
  }
  const progressText = () => {
    const value = progressValue()
    if (!value) return "Building recap…"
    return `${progressBar()}Backfilling ${value.processed}/${value.total} messages`
  }
  const footerHints = () => {
    if (backfilling()) return "x cancel"
    if (paused()) return "b resume"
    if (state.busy()) return "updating…"
    return "j/k move   enter open   r refresh   b build/rebuild   x cancel   g/G first/last"
  }

  // Child sessions have no timeline; never call `ensure` for them.
  onMount(() => {
    if (!isChild()) void state.load()
  })

  // Expand and select a chapter only when the newest chapter actually changes.
  // Re-running this on every document update would re-expand a chapter the user
  // collapsed and reset their selection on every refresh.
  createEffect(
    on(
      () => {
        const value = document()
        return value ? newestChapterID(value) : undefined
      },
      (newest, previous) => {
        if (!newest || newest === previous) return
        setExpanded((current) => new Set([...current, newest]))
        const index = rows().findIndex((row) => row.kind === "chapter" && row.chapterID === newest)
        if (index >= 0) setSelected(index)
      },
    ),
  )

  createEffect(
    on(
      // Track the scrollbox ref as well: it is assigned after the first render,
      // so the initial selection would otherwise never scroll into view.
      () => [selected(), rows().length, scroll()] as const,
      () => {
        const row = selectedRow()
        if (!row) return
        scroll()?.scrollChildIntoView(rowID(row))
      },
    ),
  )

  function move(delta: number): void {
    setSelected((current) => clampSelection(current + delta, rows()))
  }

  function activate(): void {
    const row = selectedRow()
    if (!row) return
    if (row.kind === "chapter") {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(row.chapterID)) next.delete(row.chapterID)
        else next.add(row.chapterID)
        return next
      })
      return
    }
    openExcerpt(props.context, state, row.highlight.anchorMessageID)
  }

  async function confirmStart(method: "backfill" | "rebuild"): Promise<void> {
    const first = method === "backfill" ? await state.backfill(false) : await state.rebuild(false)
    if (first.kind === "started") return
    if (first.kind === "error") {
      props.context.ui.toast.show({ message: first.message, variant: "error" })
      return
    }
    const confirmed = await props.context.ui.dialog.confirm({
      title: method === "backfill" ? "Build recap?" : "Rebuild recap?",
      message: `${first.estimate.messages} messages, about ${first.estimate.approxCalls} model calls.`,
      label: { confirm: method === "backfill" ? "Build" : "Rebuild", cancel: "Cancel" },
    })
    if (!confirmed) return
    const second = method === "backfill" ? await state.backfill(true) : await state.rebuild(true)
    if (second.kind === "error") props.context.ui.toast.show({ message: second.message, variant: "error" })
  }

  async function refresh(): Promise<void> {
    const value = document()
    // A failed initial load has no document to refresh; retry `ensure` so the
    // "r to retry" hint actually retries the call that failed.
    if (value === null) {
      await state.load()
      return
    }
    if (backfilling()) {
      props.context.ui.toast.show({ message: "Backfill in progress", variant: "info" })
      return
    }
    // An incremental update may be running; `refresh` coalesces into it rather
    // than being rejected, so `r` stays available outside a backfill.
    if (backfillIncomplete()) {
      props.context.ui.toast.show({ message: "Resume the backfill with b", variant: "warning" })
      return
    }
    if (value?.meta.notice?.kind === "history-changed") {
      props.context.ui.toast.show({ message: "Rebuild required; press b", variant: "warning" })
      return
    }
    // There is nothing to refresh before the first chunk: `refresh` rejects a
    // document without a watermark. `ensure` notices new messages and starts
    // the first build (or returns its estimate) instead.
    if (value.watermark === null) {
      await state.load()
      return
    }
    await state.refresh()
  }

  async function build(): Promise<void> {
    if (emptySession()) {
      // Messages can arrive while the panel stays open, and no event tells the
      // panel about a first build. `ensure` is the only call that notices and
      // starts it, so re-check before treating the document as still empty.
      await state.load()
      if (emptySession()) return
    }
    const value = document()
    if (backfilling()) {
      props.context.ui.toast.show({ message: "Backfill in progress", variant: "info" })
      return
    }
    if (state.busy()) {
      props.context.ui.toast.show({ message: "Recap update in progress", variant: "info" })
      return
    }
    // A rewritten transcript is not resumable; only a rebuild clears the notice.
    if (value?.meta.notice?.kind === "history-changed") {
      void confirmStart("rebuild")
      return
    }
    // Paused or interrupted backfills must resume, not rebuild from scratch.
    const resuming =
      value?.status === "paused" ||
      (value?.backfill !== null && value?.backfill !== undefined && value.backfill.completedAt === undefined)
    if (resuming) {
      void confirmStart("backfill")
      return
    }
    if (value?.watermark !== null && value?.watermark !== undefined) {
      void confirmStart("rebuild")
      return
    }
    void confirmStart("backfill")
  }

  function cancel(): void {
    void state.cancel()
  }

  props.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "j,down", title: "Next timeline row", group: "Recap", run: () => move(1) },
      { bind: "k,up", title: "Previous timeline row", group: "Recap", run: () => move(-1) },
      { bind: "enter", title: "Expand chapter or open excerpt", group: "Recap", run: activate },
      { bind: "r", title: "Refresh timeline", group: "Recap", run: () => void refresh() },
      { bind: "b", title: "Build, resume, or rebuild timeline", group: "Recap", run: () => void build() },
      { bind: "x", title: "Cancel backfill", group: "Recap", run: cancel },
      { bind: "g", title: "First timeline row", group: "Recap", run: () => setSelected(0) },
      {
        bind: "shift+g",
        title: "Last timeline row",
        group: "Recap",
        run: () => setSelected(Math.max(0, rows().length - 1)),
      },
    ],
  }))

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.raised.base}>
      <Show
        when={!isChild()}
        fallback={<text fg={props.context.theme.text.muted}>Recap is available for root sessions.</text>}
      >
        <Show
          when={!state.disabledReason()}
          fallback={
            <box flexDirection="column">
              <text fg={props.context.theme.text.muted}>{state.disabledReason()}</text>
              <text fg={props.context.theme.text.muted}>{CONFIG_SNIPPET}</text>
            </box>
          }
        >
          <Show when={!state.loading()} fallback={<text fg={props.context.theme.text.muted}>Loading recap…</text>}>
            <Show
              when={!state.requestError() || hasRenderable()}
              fallback={
                <box flexDirection="column">
                  <text fg={props.context.theme.text.feedback.error.base}>{state.requestError()}</text>
                  <text fg={props.context.theme.text.muted}>r to retry</text>
                </box>
              }
            >
              <box flexDirection="column" flexGrow={1}>
                <Show when={state.requestError() && hasRenderable()}>
                  <text fg={props.context.theme.text.feedback.error.base}>{state.requestError()}</text>
                </Show>
                <Show
                  when={document()}
                  fallback={
                    <box flexDirection="column">
                      <Show
                        when={state.busy()}
                        fallback={
                          <Show
                            when={state.needsBackfill() || state.estimate()}
                            fallback={<text fg={props.context.theme.text.muted}>No messages yet.</text>}
                          >
                            <BuildPrompt context={props.context} state={state} />
                          </Show>
                        }
                      >
                        <text fg={props.context.theme.text.feedback.info.base}>Building recap…</text>
                        <text fg={props.context.theme.text.muted}>x to cancel</text>
                      </Show>
                      <text fg={props.context.theme.text.faint}>{footerHints()}</text>
                    </box>
                  }
                >
                  {(current) => (
                    <box flexDirection="column" flexGrow={1}>
                      <TimelineHeader
                        context={props.context}
                        document={current()}
                        disabled={Boolean(state.disabledReason())}
                      />
                      <Show when={backfilling()}>
                        <text fg={props.context.theme.text.feedback.info.base}>{progressText()} · x to cancel</text>
                      </Show>
                      <Show when={paused() && rows().length > 0}>
                        <text fg={props.context.theme.text.feedback.warning.base}>
                          Backfill paused at {pausedAt()} messages — b to resume.
                        </text>
                      </Show>
                      <Show when={current().status === "error" && rows().length > 0}>
                        <text fg={props.context.theme.text.feedback.error.base}>
                          {errorMessage()} · {backfillIncomplete() ? "b to resume" : "b to resume/rebuild · r to retry"}
                        </text>
                      </Show>
                      <Show when={banner()}>
                        <text fg={props.context.theme.text.feedback.warning.base} wrapMode="word">
                          {banner()}
                        </text>
                      </Show>
                      <Show
                        when={rows().length > 0}
                        fallback={
                          <EmptyBody
                            context={props.context}
                            state={state}
                            document={current()}
                            emptySession={emptySession()}
                            errorMessage={errorMessage()}
                            pausedAt={pausedAt()}
                          />
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
                      <text fg={props.context.theme.text.faint}>{footerHints()}</text>
                    </box>
                  )}
                </Show>
              </box>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

function BuildPrompt(props: { readonly context: Context; readonly state: TimelineState }) {
  return (
    <box flexDirection="column">
      <text fg={props.context.theme.text.base}>Build recap from this session's history</text>
      <Show when={props.state.busy()}>
        <text fg={props.context.theme.text.feedback.info.base}>Building recap…</text>
      </Show>
      <Show when={props.state.estimate()}>
        <text fg={props.context.theme.text.muted}>
          ~{props.state.estimate()?.approxCalls} model calls over {props.state.estimate()?.messages} messages
        </text>
      </Show>
      <text fg={props.context.theme.text.muted}>Press b to build the recap.</text>
    </box>
  )
}

function EmptyBody(props: {
  readonly context: Context
  readonly state: TimelineState
  readonly document: NonNullable<ReturnType<TimelineState["document"]>>
  readonly emptySession: boolean
  readonly errorMessage: string
  readonly pausedAt: string
}) {
  return (
    <Show
      when={props.document.status === "error"}
      fallback={
        <Show
          when={props.document.status === "paused"}
          fallback={
            <Show
              when={props.document.watermark === null}
              fallback={
                <text fg={props.context.theme.text.muted}>
                  No milestones found yet. New activity will update this recap.
                </text>
              }
            >
              <Show when={props.emptySession} fallback={<BuildPrompt context={props.context} state={props.state} />}>
                <text fg={props.context.theme.text.muted}>No messages yet.</text>
              </Show>
            </Show>
          }
        >
          <box flexDirection="column">
            <text fg={props.context.theme.text.feedback.warning.base}>
              Backfill paused at {props.pausedAt} messages — b to resume.
            </text>
          </box>
        </Show>
      }
    >
      <box flexDirection="column">
        <text fg={props.context.theme.text.feedback.error.base}>{props.errorMessage}</text>
        <text fg={props.context.theme.text.muted}>
          {props.document.backfill && props.document.backfill.completedAt === undefined
            ? "b to resume"
            : "b to resume/rebuild · r to retry"}
        </text>
      </box>
    </Show>
  )
}

function rowID(row: TimelineRow): string {
  return row.kind === "chapter" ? `timeline-chapter-${row.chapter.id}` : `timeline-highlight-${row.highlight.id}`
}
