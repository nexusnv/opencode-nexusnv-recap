/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import type { TimelineDocument, TimelineHighlight } from "../shared/types.js"
import { compactChapterRange, glyph, kindColor, statusColor, statusWord } from "./format.js"
import { MarqueeLine, type MarqueeSegment } from "./marquee-line.js"
import {
  deriveSidebar,
  nextPhaseID,
  normalizePlanText,
  phaseDwellMs,
  phasePosition,
  type SidebarPhase,
} from "./sidebar-view.js"
import { createRecapState } from "./sidebar-state.js"

export function RecapSidebar(props: { readonly context: Context; readonly sessionID: string }) {
  const isChild = createMemo(() => Boolean(props.context.data.session.get(props.sessionID)?.parentID))
  return (
    <Show keyed when={isChild() ? undefined : props.sessionID}>
      {(sessionID) => <SidebarBody context={props.context} sessionID={sessionID} />}
    </Show>
  )
}

function SidebarBody(props: { readonly context: Context; readonly sessionID: string }) {
  const state = createRecapState(props.context, props.sessionID)
  const [tickerID, setTickerID] = createSignal<string>()

  const document = () => state.document()
  const view = createMemo(() => {
    const value = document()
    return value ? deriveSidebar(value) : { phases: [], now: null, next: null }
  })
  const phases = () => view().phases
  const activePhase = createMemo(() => {
    const list = phases()
    return list.find((phase) => phase.id === tickerID()) ?? list[0]
  })

  onMount(() => {
    void state.load()
  })

  createEffect(
    on(
      () =>
        phases()
          .map((phase) => phase.id)
          .join("\u0000"),
      () => {
        const list = phases()
        if (list.length === 0) {
          setTickerID(undefined)
          return
        }
        if (!list.some((phase) => phase.id === tickerID())) setTickerID(list[0]?.id)
      },
    ),
  )

  // The ticker holds each phase for its dwell time, then advances oldest to
  // newest. The newest phase is already current in `Now`, so it gets the
  // longest dwell and the cycle restarts from the oldest phase.
  createEffect(
    on(
      () => [tickerID(), phases()] as const,
      ([id, list]) => {
        const phase = list.find((entry) => entry.id === id) ?? list[0]
        if (!phase) return
        const timer = setTimeout(
          () => setTickerID(nextPhaseID(list, phase.id)),
          phaseDwellMs(phase.title, phase.current),
        )
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )

  const position = () => phasePosition(phases(), activePhase()?.id)
  const status = () => headerStatus()
  // A request failure is local to this component. An envelope error is a
  // server-side runtime failure that may not be reflected in the persisted
  // status yet, so both surface through the same error line.
  const errorText = () => state.requestError() ?? state.error()?.message
  const headerRight = () => {
    const parts: string[] = []
    if (position().total > 0) parts.push(`${position().current}/${position().total}`)
    const word = status().word
    if (word) parts.push(word)
    return parts.join(" ")
  }

  function headerStatus(): { word: string | undefined; color: ReturnType<typeof statusColor> } {
    if (state.disabledReason()) return { word: "disabled", color: props.context.theme.text.muted }
    if (errorText()) return { word: "error", color: props.context.theme.text.feedback.error.base }
    const value = document()
    if (!value) return { word: state.loading() ? "loading" : "not built", color: props.context.theme.text.muted }
    const word = statusWord(value.status, false, state.busy())
    if (!word && value.coverage.partial) {
      return { word: "partial", color: props.context.theme.text.feedback.warning.base }
    }
    return {
      word,
      color: statusColor(props.context, value.status, false, state.busy()),
    }
  }

  const headline = (): { text: string; color: ReturnType<typeof kindColor> } | undefined => {
    if (state.disabledReason())
      return { text: singleLine(state.disabledReason()!), color: props.context.theme.text.muted }
    const value = document()
    // Keep an already-rendered ticker and Now line visible when a background
    // reload fails; the status line carries the error instead.
    if (value && value.chapters.length > 0) return undefined
    if (errorText()) return { text: "Recap unavailable", color: props.context.theme.text.feedback.error.base }
    if (state.loading()) return { text: "Loading recap", color: props.context.theme.text.muted }
    if (!value) return { text: "Not built", color: props.context.theme.text.muted }
    if (value.status === "error") {
      return { text: "Recap failed", color: props.context.theme.text.feedback.error.base }
    }
    if (value.status === "paused")
      return { text: "Backfill paused", color: props.context.theme.text.feedback.warning.base }
    if (value.status === "backfilling") {
      return { text: "Building recap", color: props.context.theme.text.feedback.info.base }
    }
    if (value.watermark === null) return { text: "Not built", color: props.context.theme.text.muted }
    return { text: "No milestones yet", color: props.context.theme.text.muted }
  }

  const statusLine = (): { text: string; color: ReturnType<typeof kindColor>; prefix: string } | undefined => {
    if (state.disabledReason()) return undefined
    if (errorText()) {
      return {
        text: `${errorText()} · /recap to retry`,
        color: props.context.theme.text.feedback.error.base,
        prefix: "!",
      }
    }
    const value = document()
    if (!value) {
      if (state.loading()) return undefined
      return { text: "/recap to build", color: props.context.theme.text.muted, prefix: "·" }
    }
    if (value.status === "backfilling") {
      return {
        text: buildingText(value, state.progress()),
        color: props.context.theme.text.feedback.info.base,
        prefix: "·",
      }
    }
    if (value.status === "paused") {
      return { text: pausedText(value), color: props.context.theme.text.feedback.warning.base, prefix: "!" }
    }
    if (value.status === "error") {
      return {
        text: `${errorMessage(value)} · /recap to retry`,
        color: props.context.theme.text.feedback.error.base,
        prefix: "!",
      }
    }
    if (value.meta.notice) {
      return { text: value.meta.notice.message, color: props.context.theme.text.feedback.warning.base, prefix: "!" }
    }
    if (value.watermark === null) {
      return { text: "/recap to build", color: props.context.theme.text.muted, prefix: "·" }
    }
    const next = view().next
    if (next) {
      return {
        text: `${glyph(next.highlight.kind)} ${normalizePlanText(next.highlight.text)}`,
        color: props.context.theme.text.feedback.info.base,
        prefix: "Next",
      }
    }
    return undefined
  }

  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <box flexDirection="row" width="100%" justifyContent="space-between" flexShrink={0}>
        <text flexShrink={0} wrapMode="none" fg={props.context.theme.text.base}>
          Recap
        </text>
        <Show when={headerRight()}>
          <text flexShrink={0} wrapMode="none" fg={status().color}>
            {headerRight()}
          </text>
        </Show>
      </box>
      <Show
        when={headline()}
        fallback={
          <>
            <TickerLine context={props.context} phase={activePhase()} />
            <NowLine
              context={props.context}
              chapterTitle={view().now?.chapterTitle}
              highlight={view().now?.highlight ?? null}
            />
          </>
        }
      >
        {(line) => (
          <MarqueeLine
            context={props.context}
            prefix="·"
            prefixColor={props.context.theme.text.muted}
            segments={[{ text: line().text, color: line().color }]}
          />
        )}
      </Show>
      <Show when={statusLine()}>
        {(line) => (
          <MarqueeLine
            context={props.context}
            prefix={line().prefix}
            prefixColor={line().color}
            segments={[{ text: line().text, color: line().color }]}
          />
        )}
      </Show>
    </box>
  )
}

function TickerLine(props: { readonly context: Context; readonly phase: SidebarPhase | undefined }) {
  const segments = (): MarqueeSegment[] => {
    const phase = props.phase
    if (!phase) return []
    return [
      {
        text: phase.title || "Untitled chapter",
        color: phase.current ? props.context.theme.text.base : props.context.theme.text.muted,
      },
      { text: " · ", color: props.context.theme.text.faint },
      { text: compactChapterRange(phase.startedAt, phase.endedAt), color: props.context.theme.text.faint },
    ]
  }
  return (
    <MarqueeLine
      context={props.context}
      prefix="▸"
      prefixColor={props.phase?.current ? props.context.theme.text.action.primary.base : props.context.theme.text.muted}
      segments={segments()}
    />
  )
}

function NowLine(props: {
  readonly context: Context
  readonly chapterTitle: string | undefined
  readonly highlight: TimelineHighlight | null
}) {
  const segments = (): MarqueeSegment[] => {
    const title = props.chapterTitle || "Untitled chapter"
    if (!props.highlight) return [{ text: title, color: props.context.theme.text.base }]
    return [
      { text: title, color: props.context.theme.text.base },
      { text: " · ", color: props.context.theme.text.faint },
      {
        text: `${glyph(props.highlight.kind)} ${props.highlight.text}`,
        color: kindColor(props.context, props.highlight),
      },
    ]
  }
  return (
    <MarqueeLine
      context={props.context}
      prefix="Now"
      prefixColor={props.context.theme.text.muted}
      segments={segments()}
    />
  )
}

function buildingText(document: TimelineDocument, progress: { processed: number; total: number } | undefined): string {
  if (progress) return `Building ${progress.processed}/${progress.total}`
  const backfill = document.backfill
  if (backfill) return `Building ${backfill.processedMessages}/${backfill.totalMessages}`
  return "Building recap"
}

function pausedText(document: TimelineDocument): string {
  const backfill = document.backfill
  if (!backfill) return "Backfill paused · /recap to resume"
  return `Paused at ${backfill.processedMessages}/${backfill.totalMessages} · /recap to resume`
}

function errorMessage(document: TimelineDocument): string {
  return document.meta.lastError?.message ?? "Recap update failed"
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}
