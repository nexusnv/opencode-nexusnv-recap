/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup } from "solid-js"
import { TimelineRpc } from "../rpc.js"
import { parseDocument } from "../shared/document.js"
import { requireRpcLocation } from "../shared/location.js"
import type { ExcerptItem, TimelineDocument, TimelineError, TimelineEstimate } from "../shared/types.js"

export type StartResult =
  | { kind: "started" }
  | { kind: "confirmation_required"; estimate: TimelineEstimate }
  | { kind: "error"; message: string }

export interface TimelineProgress {
  phase: "backfill" | "update"
  processed: number
  total: number
  chapters: number
}

export interface TimelineState {
  document(): TimelineDocument | null
  busy(): boolean
  needsBackfill(): boolean
  estimate(): TimelineEstimate | undefined
  disabledReason(): string | undefined
  error(): TimelineError | undefined
  loading(): boolean
  requestError(): string | undefined
  progress(): TimelineProgress | undefined
  load(): Promise<void>
  refresh(): Promise<void>
  backfill(confirm?: boolean): Promise<StartResult>
  rebuild(confirm?: boolean): Promise<StartResult>
  cancel(): Promise<void>
  excerpt(messageID: string): Promise<ExcerptItem[]>
}

export function createTimelineState(context: Context, sessionID: string): TimelineState {
  const rpc = context.client.rpc(TimelineRpc)
  const location = requireRpcLocation(context)
  const controller = new AbortController()

  const [document, setDocument] = createSignal<TimelineDocument | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [needsBackfill, setNeedsBackfill] = createSignal(false)
  const [estimate, setEstimate] = createSignal<TimelineEstimate>()
  const [disabledReason, setDisabledReason] = createSignal<string>()
  const [error, setError] = createSignal<TimelineError>()
  const [loading, setLoading] = createSignal(true)
  const [requestError, setRequestError] = createSignal<string>()
  const [progress, setProgress] = createSignal<TimelineProgress>()
  // Seed from the loaded document so the first progress event can detect a
  // chapter-count change instead of being treated as the baseline.
  let lastProgressChapters: number | undefined

  function applyEnvelope(value: unknown): void {
    if (!isRecord(value)) throw new TypeError("Recap returned an invalid response")
    const rawDocument = value.document
    let parsed: TimelineDocument | null
    if (rawDocument === null) {
      parsed = null
    } else {
      const candidate = parseDocument(rawDocument)
      if (!candidate) throw new TypeError("Recap returned an invalid document")
      parsed = candidate
    }
    setDocument(parsed)
    setBusy(value.busy === true)
    setNeedsBackfill(value.needsBackfill === true)
    setEstimate(isEstimate(value.estimate) ? value.estimate : undefined)
    setDisabledReason(typeof value.disabledReason === "string" ? value.disabledReason : undefined)
    setError(isTimelineError(value.error) ? value.error : undefined)
    lastProgressChapters = parsed?.chapters.length
  }

  async function load(): Promise<void> {
    // Only the first load needs the full-screen loading state. Background
    // event reloads must not replace the visible timeline with a spinner.
    if (document() === null) setLoading(true)
    try {
      const result = await rpc.ensure({ sessionID }, { location, signal: controller.signal })
      if (controller.signal.aborted) return
      applyEnvelope(result)
      setRequestError(undefined)
    } catch (cause) {
      if (!controller.signal.aborted) setRequestError(messageOf(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  async function refresh(): Promise<void> {
    try {
      await rpc.refresh({ sessionID }, { location, signal: controller.signal })
      await load()
    } catch (cause) {
      if (!controller.signal.aborted) setRequestError(messageOf(cause))
    }
  }

  async function start(method: "backfill" | "rebuild", confirm: boolean): Promise<StartResult> {
    setProgress(undefined)
    try {
      await rpc[method]({ sessionID, confirm }, { location, signal: controller.signal })
      if (controller.signal.aborted) return { kind: "error", message: "Request aborted" }
      setRequestError(undefined)
      void load()
      return { kind: "started" }
    } catch (cause) {
      const failure = rpcFailure(cause)
      if (failure.type === "confirmation_required" && isEstimate(failure.data)) {
        setEstimate(failure.data)
        return { kind: "confirmation_required", estimate: failure.data }
      }
      return { kind: "error", message: failure.message }
    }
  }

  async function cancel(): Promise<void> {
    try {
      await rpc.cancel({ sessionID }, { location, signal: controller.signal })
      await load()
    } catch (cause) {
      if (!controller.signal.aborted) setRequestError(messageOf(cause))
    }
  }

  async function excerpt(messageID: string): Promise<ExcerptItem[]> {
    const result = await rpc.excerpt({ sessionID, messageID }, { location, signal: controller.signal })
    if (!isRecord(result) || !Array.isArray(result.items)) throw new TypeError("Recap returned an invalid excerpt")
    return result.items.filter(isExcerptItem)
  }

  const offUpdated = rpc.events.on(
    "updated",
    (event) => {
      if (!isRecord(event.data) || event.data.sessionID !== sessionID) return
      void load()
    },
    { signal: controller.signal },
  )
  // Spec §10.2: refetch on `updated`, on `error`, and on `progress` when the
  // chapter count changes. The local progress signal renders live progress; a
  // chapter-count change also refetches so the timeline grows immediately.
  const offProgress = rpc.events.on(
    "progress",
    (event) => {
      if (!isRecord(event.data) || event.data.sessionID !== sessionID) return
      const phase = event.data.phase
      if (phase !== "backfill" && phase !== "update") return
      const chapters = numberOrZero(event.data.chapters)
      setProgress({
        phase,
        processed: numberOrZero(event.data.processed),
        total: numberOrZero(event.data.total),
        chapters,
      })
      if (lastProgressChapters !== undefined && chapters !== lastProgressChapters) void load()
      lastProgressChapters = chapters
    },
    { signal: controller.signal },
  )
  // Spec §10.2: an `error` event is a background-refresh failure; it refetches
  // `ensure` — the envelope `error` renders in doc-error state — not a
  // `requestError`. `requestError` is reserved for failures of our own calls.
  const offError = rpc.events.on(
    "error",
    (event) => {
      if (!isRecord(event.data) || event.data.sessionID !== sessionID) return
      void load()
    },
    { signal: controller.signal },
  )

  onCleanup(() => {
    offUpdated()
    offProgress()
    offError()
    controller.abort()
  })

  return {
    document,
    busy,
    needsBackfill,
    estimate,
    disabledReason,
    error,
    loading,
    requestError,
    progress,
    load,
    refresh,
    backfill: (confirm = false) => start("backfill", confirm),
    rebuild: (confirm = false) => start("rebuild", confirm),
    cancel,
    excerpt,
  }
}

function rpcFailure(cause: unknown): { type?: string; message: string; data?: unknown } {
  if (isRecord(cause)) {
    return {
      ...(typeof cause.type === "string" ? { type: cause.type } : {}),
      message: typeof cause.message === "string" ? cause.message : "Recap request failed",
      data: cause.data,
    }
  }
  return { message: messageOf(cause) }
}

function isEstimate(value: unknown): value is TimelineEstimate {
  return (
    isRecord(value) &&
    typeof value.messages === "number" &&
    typeof value.chars === "number" &&
    typeof value.chunks === "number" &&
    typeof value.approxCalls === "number"
  )
}

function isTimelineError(value: unknown): value is TimelineError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.kind === "string"
  )
}

function isExcerptItem(value: unknown): value is ExcerptItem {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant" || value.role === "tool" || value.role === "system") &&
    typeof value.at === "string" &&
    typeof value.text === "string" &&
    typeof value.messageID === "string" &&
    typeof value.isAnchor === "boolean"
  )
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Recap request failed"
}
