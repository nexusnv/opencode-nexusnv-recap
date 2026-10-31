/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup } from "solid-js"
import { TimelineRpc } from "../rpc.js"
import { requireRpcLocation } from "../shared/location.js"
import type { TimelineDocument, TimelineError } from "../shared/types.js"
import { isRecord, messageOf, parseEnvelope } from "./envelope.js"

export interface TimelineProgress {
  phase: "backfill" | "update"
  processed: number
  total: number
  chapters: number
}

export interface RecapState {
  document(): TimelineDocument | null
  busy(): boolean
  disabledReason(): string | undefined
  error(): TimelineError | undefined
  loading(): boolean
  requestError(): string | undefined
  progress(): TimelineProgress | undefined
  load(): Promise<void>
}

export function createRecapState(context: Context, sessionID: string): RecapState {
  const rpc = context.client.rpc(TimelineRpc)
  const location = requireRpcLocation(context)
  const controller = new AbortController()

  const [document, setDocument] = createSignal<TimelineDocument | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [disabledReason, setDisabledReason] = createSignal<string>()
  const [error, setError] = createSignal<TimelineError>()
  const [loading, setLoading] = createSignal(true)
  const [requestError, setRequestError] = createSignal<string>()
  const [progress, setProgress] = createSignal<TimelineProgress>()
  // Seed from the loaded document so the first progress event can detect a
  // chapter-count change instead of being treated as the baseline.
  let lastProgressChapters: number | undefined
  // Event-driven reloads can overlap. Only the newest request may apply its
  // response; otherwise a slow, older read can overwrite a newer timeline.
  let loadGeneration = 0

  function applyEnvelope(value: unknown): void {
    const envelope = parseEnvelope(value)
    setDocument(envelope.document)
    setBusy(envelope.busy)
    setDisabledReason(envelope.disabledReason)
    setError(envelope.error)
    // Progress is live-only. Drop a finished run's progress so a later rebuild
    // cannot briefly render stale counts before its first progress event.
    if (envelope.document?.status !== "backfilling") setProgress(undefined)
    lastProgressChapters = envelope.document?.chapters.length
  }

  async function load(): Promise<void> {
    const generation = ++loadGeneration
    // Only the first load needs the loading state. Background event reloads
    // must not replace the visible recap with a spinner.
    if (document() === null) setLoading(true)
    try {
      const result = await rpc.get({ sessionID }, { location, signal: controller.signal })
      if (controller.signal.aborted || generation !== loadGeneration) return
      applyEnvelope(result)
      setRequestError(undefined)
    } catch (cause) {
      if (!controller.signal.aborted && generation === loadGeneration) setRequestError(messageOf(cause))
    } finally {
      if (!controller.signal.aborted && generation === loadGeneration) setLoading(false)
    }
  }

  const offUpdated = rpc.events.on(
    "updated",
    (event) => {
      if (!isRecord(event.data) || event.data.sessionID !== sessionID) return
      void load()
    },
    { signal: controller.signal },
  )
  // Refetch on `error`, and on `progress` when the chapter count changes. The
  // local progress signal renders live progress; a chapter-count change also
  // refetches so the ticker grows immediately.
  const offProgress = rpc.events.on(
    "progress",
    (event) => {
      if (!isRecord(event.data) || event.data.sessionID !== sessionID) return
      const phase = event.data.phase
      if (phase !== "backfill" && phase !== "update") return
      setBusy(true)
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
  // An `error` event is a background-refresh failure; it refetches `get` so the
  // envelope error renders in the status line. `requestError` is reserved for
  // failures of our own calls.
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
    disabledReason,
    error,
    loading,
    requestError,
    progress,
    load,
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
