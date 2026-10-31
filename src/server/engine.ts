import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { CONFIG_SNIPPET, DISABLED_REASON, type TimelineConfig } from "../config.js"
import { createDocument } from "../shared/document.js"
import type {
  TimelineBackfill,
  TimelineDocument,
  TimelineError,
  TimelineEstimate,
  TimelineNotice,
  TimelineWatermark,
} from "../shared/types.js"
import { applyOutput } from "./apply.js"
import { chunkMessages, estimateBackfill } from "./chunk.js"
import { type Clock, systemClock, type TimerHandle } from "./clock.js"
import { buildDigest, type DigestAlias } from "./digest.js"
import {
  InvalidOutputFailure,
  ModelCallFailure,
  StorageFailure,
  TimelineFailure,
  isNotFound,
  sanitizeError,
  sessionIDOf,
  toTimelineError,
} from "./errors.js"
import { ModelFailure, type ModelClient } from "./model.js"
import { parseModelOutput, type ValidatedOutput } from "./output.js"
import { PROMPT_VERSION, buildPrompt, buildRepairPrompt } from "./prompt.js"
import { readSessionMessages, type SessionPartialReason } from "./read.js"
import type { TimelineStore } from "./store.js"
import { isRecord } from "./text.js"
import { sliceAfterWatermark } from "./watermark.js"

export type RefreshReason = "idle" | "open" | "manual" | "force"

const MISSING_MODEL_REASON = `Recap requires an explicit \`model\`.\n${CONFIG_SNIPPET}`
const SHUTTING_DOWN_REASON = "Recap is shutting down."
// Storage outages are usually transient. Automatic work backs off for a minute
// so a broken store cannot turn panel reloads or idle events into a retry loop.
const STORAGE_RETRY_DELAY_MS = 60_000

type RemainingMessages = { kind: "messages"; messages: SessionMessageInfo[] } | { kind: "history-changed" }

function remainingMessages(
  messages: readonly SessionMessageInfo[],
  watermark: TimelineWatermark | null,
): RemainingMessages {
  if (!watermark) return { kind: "messages", messages: [...messages] }
  const slice = sliceAfterWatermark(messages, watermark)
  if (slice.kind === "history-changed") return { kind: "history-changed" }
  return { kind: "messages", messages: slice.kind === "new" ? slice.messages : [] }
}

/**
 * Drop trailing in-flight messages from a snapshot. A streaming assistant (no
 * `time.completed`, or a running tool part), a running shell, and a running
 * compaction are not stable yet: the host updates them in place, so advancing
 * the watermark to them would permanently skip their final content. The
 * post-completion idle event processes them once settled.
 */
function settledMessages(messages: readonly SessionMessageInfo[]): SessionMessageInfo[] {
  let end = messages.length
  while (end > 0) {
    const message = messages[end - 1]
    if (!message) break
    if (message.type === "assistant") {
      const streaming =
        message.time.completed === undefined ||
        message.content.some(
          (part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "streaming"),
        )
      if (streaming) {
        end -= 1
        continue
      }
    }
    if (message.type === "shell" && message.status === "running") {
      end -= 1
      continue
    }
    if (message.type === "compaction" && message.status === "running") {
      end -= 1
      continue
    }
    break
  }
  return end === messages.length ? [...messages] : messages.slice(0, end)
}

function historyChangedNotice(now: string): TimelineNotice {
  return {
    kind: "history-changed",
    message: "The transcript changed. Rebuild the timeline to continue.",
    at: now,
  }
}

function estimateOf(value: unknown): TimelineEstimate | undefined {
  if (!isRecord(value)) return undefined
  const { messages, chars, chunks, approxCalls } = value
  if (
    typeof messages !== "number" ||
    typeof chars !== "number" ||
    typeof chunks !== "number" ||
    typeof approxCalls !== "number"
  ) {
    return undefined
  }
  return { messages, chars, chunks, approxCalls }
}

export interface EngineEventSink {
  updated(data: { sessionID: string; status: string; chapterCount: number; taskCount: number; updatedAt: string }): void
  progress(data: {
    sessionID: string
    phase: "backfill" | "update"
    processed: number
    total: number
    chapters: number
  }): void
  error(data: { sessionID: string; kind: string; message: string; retryable: boolean }): void
}

export interface GetResult {
  document: TimelineDocument | null
  busy: boolean
  disabledReason?: string | undefined
  error?: TimelineError | undefined
}

export interface EnsureResult extends GetResult {
  needsBackfill: boolean
  estimate?: TimelineEstimate | undefined
}

export interface EngineDeps {
  readonly ctx: Pick<
    Plugin.Context,
    "session" | "model" | "storage" | "event" | "generate" | "experimental" | "location"
  >
  readonly config: TimelineConfig
  readonly store: TimelineStore
  readonly model: ModelClient
  readonly clock?: Clock
  readonly events?: EngineEventSink
  readonly disabledReason?: string | undefined
  readonly log?: (message: string, data?: Record<string, unknown>) => void
}

interface SessionRuntime {
  running: Promise<void> | null
  lock: Promise<void>
  rerun: boolean
  followUp?: (() => Promise<void>) | undefined
  debounce?: TimerHandle | undefined
  force?: TimerHandle | undefined
  forceOnNextIdle: boolean
  backfill?: { cancelled: boolean } | undefined
  error?: TimelineError | undefined
  /** Automatic retries stay paused until this instant after a storage failure. */
  storageRetryAt?: number | undefined
  progress?: { phase: "backfill" | "update"; processed: number; total: number; chapters: number } | undefined
}

interface PreparedTask<T> {
  run: () => Promise<void>
  followUp?: (() => Promise<void>) | undefined
  value: T
}

interface BackfillResult {
  started: boolean
  estimate: TimelineEstimate
  needsBackfill?: boolean | undefined
}

export class TimelineEngine {
  private readonly runtimeBySession = new Map<string, SessionRuntime>()
  private readonly deletedSessions = new Set<string>()
  private readonly clock: Clock
  private readonly log: (message: string, data?: Record<string, unknown>) => void
  private controller: AbortController | undefined
  private started = false
  private stopped = false
  private disabledReason: string | undefined
  private inFlight = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? systemClock
    this.log = deps.log ?? (() => undefined)
    this.disabledReason =
      deps.disabledReason ??
      (!deps.config.enabled ? DISABLED_REASON : deps.config.model ? undefined : MISSING_MODEL_REASON)
  }

  private runtime(sessionID: string): SessionRuntime {
    const existing = this.runtimeBySession.get(sessionID)
    if (existing) return existing
    // A deleted session must never get a fresh runtime entry. Callers guard
    // before reaching here; this is the final backstop.
    if (this.deletedSessions.has(sessionID)) {
      return { running: null, lock: Promise.resolve(), rerun: false, forceOnNextIdle: false }
    }
    const runtime: SessionRuntime = { running: null, lock: Promise.resolve(), rerun: false, forceOnNextIdle: false }
    this.runtimeBySession.set(sessionID, runtime)
    return runtime
  }

  /**
   * Serialize every load -> decide -> mutate -> persist path for a session.
   * The lock promise is a pure gate: it never rejects, so a failed mutation
   * cannot poison later waiters.
   */
  private async withLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const runtime = this.runtime(sessionID)
    const previous = runtime.lock
    let release!: () => void
    runtime.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private isInactive(sessionID: string): boolean {
    return this.stopped || this.deletedSessions.has(sessionID)
  }

  private sessionNotFound(sessionID: string): TimelineFailure {
    return new TimelineFailure("session_not_found", `Session not found: ${sessionID}`, { sessionID })
  }

  private assertNotDeleted(sessionID: string): void {
    if (this.deletedSessions.has(sessionID)) throw this.sessionNotFound(sessionID)
  }

  private assertActive(sessionID: string): void {
    if (this.deletedSessions.has(sessionID)) throw this.sessionNotFound(sessionID)
    if (this.stopped) throw new TimelineFailure("internal", SHUTTING_DOWN_REASON)
  }

  private now(): number {
    return this.clock.now()
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.validateModel()
    const controller = new AbortController()
    this.controller = controller
    void this.consume(controller.signal)
  }

  private async consume(signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.deps.ctx.event.subscribe({ signal })) {
        try {
          await this.handleEvent(event)
        } catch (error) {
          this.log("event handler failed", { error: sanitizeError(error) })
        }
      }
    } catch (error) {
      if (!signal.aborted) this.log("event stream ended", { error: sanitizeError(error) })
    }
  }

  private async handleEvent(event: unknown): Promise<void> {
    if (!isRecord(event) || typeof event.type !== "string") return
    if (event.type === "session.deleted") {
      const sessionID = sessionIDOf(event)
      if (!sessionID) return
      this.deletedSessions.add(sessionID)
      const runtime = this.runtimeBySession.get(sessionID)
      if (runtime) {
        if (runtime.backfill) runtime.backfill.cancelled = true
        runtime.rerun = false
        runtime.followUp = undefined
      }
      this.clearTimers(sessionID)
      this.runtimeBySession.delete(sessionID)
      await this.deps.store.remove(sessionID).catch(() => undefined)
      return
    }
    if (event.type !== "session.idle") return
    const sessionID = sessionIDOf(event)
    if (!sessionID) return
    const info = await this.deps.ctx.session.get({ sessionID }).catch(() => undefined)
    if (!info) return
    if (info.parentID) return
    if (info.projectID !== this.deps.ctx.location.project.id) return
    this.scheduleDebounce(sessionID)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller?.abort()
    this.controller = undefined
    for (const [sessionID, runtime] of this.runtimeBySession) {
      runtime.rerun = false
      runtime.followUp = undefined
      this.clearTimers(sessionID)
    }
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  private clearTimers(sessionID: string): void {
    const runtime = this.runtimeBySession.get(sessionID)
    if (!runtime) return
    if (runtime.debounce !== undefined) this.clock.clearTimeout(runtime.debounce)
    if (runtime.force !== undefined) this.clock.clearTimeout(runtime.force)
    runtime.debounce = undefined
    runtime.force = undefined
  }

  private scheduleDebounce(sessionID: string): void {
    if (this.isInactive(sessionID)) return
    // A disabled engine (missing model, bad config) must not log an error on
    // every idle event.
    if (this.disabledReason) return
    const runtime = this.runtime(sessionID)
    if (runtime.debounce !== undefined) this.clock.clearTimeout(runtime.debounce)
    runtime.debounce = this.clock.setTimeout(() => {
      runtime.debounce = undefined
      if (this.isInactive(sessionID)) return
      if (runtime.forceOnNextIdle) {
        runtime.forceOnNextIdle = false
        void this.refreshWithOptions(sessionID, "force", true).catch((error) => {
          this.log("forced refresh failed", { sessionID, error: sanitizeError(error) })
        })
        return
      }
      void this.refresh(sessionID, "idle").catch((error) => {
        this.log("idle refresh failed", { sessionID, error: sanitizeError(error) })
      })
    }, this.deps.config.update.debounceMs)
  }

  private scheduleForceTimer(sessionID: string, delayMs = this.deps.config.update.forceAfterMinutes * 60_000): void {
    if (this.isInactive(sessionID)) return
    const runtime = this.runtime(sessionID)
    if (runtime.force !== undefined) this.clock.clearTimeout(runtime.force)
    runtime.force = this.clock.setTimeout(
      () => {
        runtime.force = undefined
        if (this.isInactive(sessionID)) return
        void this.runForceTimer(sessionID).catch((error) => {
          this.log("force timer failed", { sessionID, error: sanitizeError(error) })
        })
      },
      Math.max(0, delayMs),
    )
  }

  private async runForceTimer(sessionID: string): Promise<void> {
    if (this.isInactive(sessionID)) return
    const document = await this.deps.store.load(sessionID)
    if (this.isInactive(sessionID) || !document?.watermark) return
    const read = await readSessionMessages(this.deps.ctx, sessionID)
    if (this.isInactive(sessionID)) return
    const messages = settledMessages(read.messages)
    const slice = sliceAfterWatermark(messages, document.watermark)
    if (slice.kind !== "new") return
    // `sessionBusy` must still see a trailing streaming message, so it gets the
    // untrimmed read while the slice uses only settled messages.
    if (await this.sessionBusy(sessionID, read.messages)) {
      this.runtime(sessionID).forceOnNextIdle = true
      return
    }
    await this.refreshWithOptions(sessionID, "force", true)
  }

  private async sessionBusy(sessionID: string, messages: readonly SessionMessageInfo[]): Promise<boolean> {
    const last = messages[messages.length - 1]
    if (!last) return false
    const info = await this.deps.ctx.session.get({ sessionID }).catch(() => undefined)
    if (info?.time.idle !== undefined && info.time.idle < last.time.created) return true
    if (last.type === "user") return true
    if (last.type === "shell" && last.status === "running") return true
    if (last.type === "assistant") {
      if (last.time.completed === undefined) return true
      if (
        last.content.some(
          (part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "streaming"),
        )
      ) {
        return true
      }
    }
    return false
  }

  async refresh(
    sessionID: string,
    reason: RefreshReason = "manual",
  ): Promise<{ started: boolean; coalesced: boolean }> {
    return this.refreshWithOptions(sessionID, reason, reason === "manual")
  }

  private async refreshWithOptions(
    sessionID: string,
    reason: RefreshReason,
    force: boolean,
  ): Promise<{ started: boolean; coalesced: boolean }> {
    const manual = reason === "manual"
    if (this.stopped) {
      if (manual) throw new TimelineFailure("internal", SHUTTING_DOWN_REASON)
      return { started: false, coalesced: false }
    }
    if (this.deletedSessions.has(sessionID)) {
      if (manual) throw this.sessionNotFound(sessionID)
      return { started: false, coalesced: false }
    }
    if (manual) this.assertEnabled()
    else if (this.disabledReason) return { started: false, coalesced: false }

    const info = await this.resolveSession(sessionID)
    const document = await this.deps.store.load(sessionID)
    if (this.stopped) {
      if (manual) throw new TimelineFailure("internal", SHUTTING_DOWN_REASON)
      return { started: false, coalesced: false }
    }
    if (this.deletedSessions.has(sessionID)) {
      if (manual) throw this.sessionNotFound(sessionID)
      return { started: false, coalesced: false }
    }
    const runtime = this.runtime(sessionID)
    if (!manual && runtime.storageRetryAt !== undefined && this.now() < runtime.storageRetryAt) {
      return { started: false, coalesced: false }
    }
    if (!document?.watermark) {
      if (manual) throw new TimelineFailure("invalid_request", "Build the timeline first.")
      return { started: false, coalesced: false }
    }
    if (document.backfill && document.backfill.completedAt === undefined) {
      if (manual) throw new TimelineFailure("invalid_request", "Resume the backfill before refreshing.")
      return { started: false, coalesced: false }
    }
    if (document.meta.notice?.kind === "history-changed") {
      if (manual) throw new TimelineFailure("invalid_request", "The transcript changed; rebuild is required.")
      return { started: false, coalesced: false }
    }
    const run = () => this.refreshOnce(sessionID, info, reason, force)
    return this.startTask(sessionID, run, run)
  }

  private async refreshOnce(
    sessionID: string,
    info: SessionInfo,
    reason: RefreshReason,
    force: boolean,
  ): Promise<void> {
    if (this.isInactive(sessionID)) return
    const document = await this.deps.store.load(sessionID)
    if (this.isInactive(sessionID)) return
    if (!document?.watermark) return
    if (document.backfill && document.backfill.completedAt === undefined) return
    if (document.meta.notice?.kind === "history-changed") return
    document.sessionTitle = info.title ?? document.sessionTitle

    const read = await readSessionMessages(this.deps.ctx, sessionID)
    if (this.isInactive(sessionID)) return
    const messages = settledMessages(read.messages)
    const slice = sliceAfterWatermark(messages, document.watermark)
    const now = this.nowIso()

    if (slice.kind === "history-changed") {
      // A compacted transcript can drop the watermark message without rewinding
      // history. The existing chapters still describe what was processed, and the
      // next post-compaction message will resume from the timestamp fallback.
      // Only a missing watermark in a non-partial read means the transcript was
      // rewound or replaced.
      if (read.partial) {
        document.meta.lastCheckedAt = now
        await this.persist(sessionID, document)
        if (this.isInactive(sessionID)) return
        this.emitUpdated(document)
        return
      }
      document.status = "stale"
      document.meta.lastCheckedAt = now
      document.meta.notice = historyChangedNotice(now)
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) return
      this.emitUpdated(document)
      return
    }

    if (slice.kind === "empty") {
      document.status = "ready"
      document.meta.lastCheckedAt = now
      delete document.meta.notice
      delete document.meta.lastError
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) return
      this.emitUpdated(document)
      return
    }

    if (reason === "idle" && !force && this.belowThreshold(slice.messages)) {
      document.status = "stale"
      document.meta.lastCheckedAt = now
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) return
      this.emitUpdated(document)
      const oldest = slice.messages[0]
      const age = oldest ? this.now() - oldest.time.created : 0
      const remaining = this.deps.config.update.forceAfterMinutes * 60_000 - age
      this.scheduleForceTimer(sessionID, remaining)
      return
    }

    const automatic = reason !== "manual"
    if (automatic && this.overHourlyCap(document)) {
      document.status = "stale"
      document.meta.lastCheckedAt = now
      document.meta.notice = {
        kind: "hourly-cap",
        message: "Automatic updates paused for this session. Press r to refresh now.",
        at: now,
      }
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) return
      this.emitUpdated(document)
      return
    }

    if (reason === "manual") {
      delete document.meta.notice
      document.meta.lastCheckedAt = now
    }

    const chunks = chunkMessages(slice.messages, this.deps.config)
    let processed = 0
    for (const chunk of chunks) {
      if (this.isInactive(sessionID)) return
      processed += chunk.length
      const digest = buildDigest(chunk, this.deps.config)
      const last = chunk[chunk.length - 1]
      if (!last) continue

      if (digest.includedCount === 0) {
        const previousWatermark = document.watermark
        this.advanceWatermark(document, last, messages.length)
        document.status = "ready"
        document.meta.lastCheckedAt = this.nowIso()
        delete document.meta.notice
        delete document.meta.lastError
        try {
          await this.persist(sessionID, document)
        } catch (error) {
          // A shared in-memory store may still reference this document. Never
          // leave it pointing past a chunk that was not durably saved.
          document.watermark = previousWatermark
          throw error
        }
        if (this.isInactive(sessionID)) return
        this.emitProgress(sessionID, "update", processed, slice.messages.length, document.chapters.length)
        continue
      }

      const prompt = buildPrompt({
        document,
        digest: digest.text,
        evidence: digest.evidence,
        config: this.deps.config,
      })

      let result: { output: ValidatedOutput; calls: number; chars: number }
      try {
        result = await this.callModel(prompt, digest.aliasMap)
      } catch (error) {
        if (this.isInactive(sessionID)) return
        await this.handleModelFailure(sessionID, document, error, prompt.length, automatic, 1)
        return
      }

      // A stop or session deletion can land while the model call is in flight.
      // Never apply a late result to the persisted document.
      if (this.isInactive(sessionID)) return

      applyOutput(document, {
        output: result.output,
        now: this.nowIso(),
        coveragePartial: read.partial,
        ...(read.partialReason ? { coverageReason: read.partialReason } : {}),
        model: this.deps.config.model!,
        promptVersion: PROMPT_VERSION,
        log: this.log,
      })
      const previousWatermark = document.watermark
      this.advanceWatermark(document, last, messages.length)
      document.status = "ready"
      document.meta.lastCheckedAt = this.nowIso()
      delete document.meta.notice
      delete document.meta.lastError
      this.recordCalls(document, result.chars, automatic, result.calls)
      try {
        await this.persist(sessionID, document)
      } catch (error) {
        document.watermark = previousWatermark
        throw error
      }
      if (this.isInactive(sessionID)) return
      this.emitProgress(sessionID, "update", processed, slice.messages.length, document.chapters.length)
    }

    if (this.isInactive(sessionID)) return
    this.emitUpdated(document)
  }

  private async callModel(
    prompt: string,
    aliases: ReadonlyMap<string, DigestAlias>,
  ): Promise<{ output: ValidatedOutput; calls: number; chars: number }> {
    await this.acquire()
    let calls = 1
    let chars = prompt.length
    try {
      if (this.stopped) throw new ModelFailure("Engine stopped", "aborted", false)
      let first: string
      try {
        first = await this.deps.model.complete(prompt, this.controller?.signal)
      } catch (error) {
        throw new ModelCallFailure(error, calls, chars)
      }
      const parsed = parseModelOutput(first, aliases)
      if (parsed.ok) return { output: parsed.output, calls, chars }

      const repair = buildRepairPrompt(prompt, parsed.error, first)
      calls = 2
      chars = prompt.length + repair.length
      let second: string
      try {
        second = await this.deps.model.complete(repair, this.controller?.signal)
      } catch (error) {
        throw new ModelCallFailure(error, calls, chars)
      }
      const repaired = parseModelOutput(second, aliases)
      if (!repaired.ok) throw new ModelCallFailure(new InvalidOutputFailure(repaired.error), calls, chars)
      return { output: repaired.output, calls, chars }
    } finally {
      this.release()
    }
  }

  private async handleModelFailure(
    sessionID: string,
    document: TimelineDocument,
    error: unknown,
    promptChars: number,
    automatic: boolean,
    calls: number,
    backfill?: TimelineBackfill,
  ): Promise<void> {
    const now = this.nowIso()
    const failure = toTimelineError(error, now)
    const callCount = error instanceof ModelCallFailure ? error.calls : calls
    const charCount = error instanceof ModelCallFailure ? error.chars : promptChars
    this.recordCalls(document, charCount, automatic, callCount)
    const cause = error instanceof ModelCallFailure ? error.cause : error
    if (cause instanceof ModelFailure && (cause.kind === "auth" || cause.kind === "config")) {
      this.disabledReason = sanitizeError(cause)
    }
    if (backfill) backfill.error = failure.message
    document.status = "error"
    document.meta.lastCheckedAt = now
    document.meta.lastError = failure
    await this.persist(sessionID, document)
    if (this.isInactive(sessionID)) return
    this.emitUpdated(document)
    this.emitError(sessionID, failure)
  }

  private advanceWatermark(document: TimelineDocument, message: SessionMessageInfo, messageCount: number): void {
    document.watermark = {
      messageID: message.id,
      createdAt: new Date(message.time.created).toISOString(),
      messageCount,
    }
  }

  private belowThreshold(messages: readonly SessionMessageInfo[]): boolean {
    const newUsers = messages.filter((message) => message.type === "user").length
    const oldest = messages[0]
    const age = oldest ? this.now() - oldest.time.created : 0
    return (
      newUsers < this.deps.config.update.minNewUserTurns &&
      messages.length < this.deps.config.update.minNewMessages &&
      age < this.deps.config.update.forceAfterMinutes * 60_000
    )
  }

  private overHourlyCap(document: TimelineDocument): boolean {
    const cutoff = this.now() - 3_600_000
    const recent = document.meta.recentAutoCalls.filter((value) => Date.parse(value) >= cutoff)
    return recent.length >= this.deps.config.limits.maxUpdatesPerHour
  }

  private recordCalls(document: TimelineDocument, chars: number, automatic: boolean, calls: number): void {
    document.meta.callCount += calls
    document.meta.estimatedInputChars += chars
    if (automatic) {
      for (let index = 0; index < calls; index += 1) {
        document.meta.recentAutoCalls.push(this.nowIso())
      }
    }
    const cutoff = this.now() - 3_600_000
    document.meta.recentAutoCalls = document.meta.recentAutoCalls.filter((value) => Date.parse(value) >= cutoff)
  }

  private async persist(sessionID: string, document: TimelineDocument): Promise<void> {
    if (this.isInactive(sessionID)) return
    try {
      await this.deps.store.save(document, this.nowIso())
      if (this.deletedSessions.has(sessionID)) {
        // The deletion may have raced the save. Never leave the document behind.
        await this.deps.store.remove(sessionID).catch(() => undefined)
        return
      }
      if (this.stopped) return
      const runtime = this.runtime(sessionID)
      delete runtime.error
      delete runtime.storageRetryAt
    } catch (error) {
      if (this.isInactive(sessionID)) return
      const failure: TimelineError = {
        message: sanitizeError(error),
        at: this.nowIso(),
        retryable: true,
        kind: "storage",
      }
      const runtime = this.runtime(sessionID)
      runtime.error = failure
      runtime.storageRetryAt = this.now() + STORAGE_RETRY_DELAY_MS
      // The failed save may have been mutating a watermark or backfill state.
      // Re-read the durable document and record only the error state, so a
      // transient failure leaves the last committed chunk coherent.
      await this.recordStorageFailure(sessionID, failure)
      // Abort the current run. Continuing would advance the in-memory watermark
      // past a chunk that was never durably saved, losing that chunk on retry.
      // The task loop reports the failure once; direct callers see the throw.
      throw new StorageFailure(failure.message)
    }
  }

  /**
   * Best-effort durable error status. This is separate from `persist` because
   * the caller may still be rolling back an in-memory watermark or backfill
   * counter after the failed write. Re-loading the last committed document
   * avoids persisting that uncommitted state.
   */
  private async recordStorageFailure(sessionID: string, failure: TimelineError): Promise<void> {
    if (this.isInactive(sessionID)) return
    try {
      const latest = await this.deps.store.load(sessionID)
      if (this.isInactive(sessionID) || !latest) return
      latest.status = "error"
      latest.meta.lastCheckedAt = failure.at
      latest.meta.lastError = failure
      if (latest.backfill && latest.backfill.completedAt === undefined) {
        latest.backfill.error = failure.message
      }
      await this.deps.store.save(latest, this.nowIso())
      if (this.deletedSessions.has(sessionID)) {
        await this.deps.store.remove(sessionID).catch(() => undefined)
      }
    } catch {
      // The store is still unavailable. The runtime error remains visible and
      // blocks automatic open refreshes until a manual retry succeeds.
    }
  }

  private emitUpdated(document: TimelineDocument): void {
    this.deps.events?.updated({
      sessionID: document.sessionID,
      status: document.status,
      chapterCount: document.chapters.length,
      taskCount: document.tasks.length,
      updatedAt: document.meta.updatedAt,
    })
  }

  private emitProgress(
    sessionID: string,
    phase: "backfill" | "update",
    processed: number,
    total: number,
    chapters: number,
  ): void {
    this.deps.events?.progress({ sessionID, phase, processed, total, chapters })
  }

  private emitError(sessionID: string, error: TimelineError): void {
    this.deps.events?.error({
      sessionID,
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    })
  }

  private async resolveSession(sessionID: string): Promise<SessionInfo> {
    this.assertNotDeleted(sessionID)
    let info: SessionInfo
    try {
      info = await this.deps.ctx.session.get({ sessionID })
    } catch (error) {
      if (isNotFound(error)) {
        await this.deps.store.remove(sessionID).catch(() => undefined)
        throw this.sessionNotFound(sessionID)
      }
      // A transport or host failure is not a missing session; keep the
      // distinction so the panel can offer a retry instead of a dead end.
      throw new TimelineFailure("internal", sanitizeError(error))
    }
    this.assertNotDeleted(sessionID)
    if (info.projectID !== this.deps.ctx.location.project.id) {
      throw this.sessionNotFound(sessionID)
    }
    if (info.parentID) {
      throw new TimelineFailure("invalid_request", "Recap is available for root sessions only.", {
        sessionID,
      })
    }
    return info
  }

  /** Public session guard for service methods that do not run a refresh. */
  resolve(sessionID: string): Promise<SessionInfo> {
    return this.resolveSession(sessionID)
  }

  private assertEnabled(): void {
    if (this.disabledReason) throw new TimelineFailure("disabled", this.disabledReason)
  }

  private async validateModel(): Promise<void> {
    if (this.disabledReason) return
    if (!this.deps.config.enabled) {
      this.disabledReason = DISABLED_REASON
      return
    }
    const model = this.deps.config.model
    if (!model) {
      this.disabledReason = MISSING_MODEL_REASON
      return
    }
    try {
      const listed: unknown = await this.deps.ctx.model.list()
      const models = Array.isArray(listed) ? listed : isRecord(listed) && Array.isArray(listed.data) ? listed.data : []
      const found = models.some(
        (entry) =>
          isRecord(entry) &&
          entry.providerID === model.providerID &&
          entry.modelID === model.modelID &&
          entry.enabled !== false,
      )
      if (!found) {
        this.disabledReason = `Configured model ${model.providerID}/${model.modelID} is not available. Update the plugin options.`
      }
    } catch {
      // The model list is advisory. If it is unavailable, defer the real check
      // to the first generate call, which reports auth/config failures.
      this.log("model list unavailable; deferring model validation")
    }
  }

  private async acquire(): Promise<void> {
    const limit = this.deps.config.limits.maxConcurrentCalls
    // Re-check after every wakeup: release() decrements before waking a waiter,
    // so a fresh acquire can take the slot first.
    while (this.inFlight >= limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.inFlight += 1
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.waiters.shift()?.()
  }

  private startTask(
    sessionID: string,
    task: () => Promise<void>,
    followUp?: () => Promise<void>,
  ): { started: boolean; coalesced: boolean } {
    const runtime = this.runtime(sessionID)
    if (runtime.running) {
      runtime.followUp = followUp ?? task
      runtime.rerun = true
      return { started: false, coalesced: true }
    }
    runtime.running = this.withLock(sessionID, async () => {
      try {
        await this.runTaskLoop(sessionID, runtime, task, followUp ?? task)
      } catch (error) {
        const failure = toTimelineError(error, this.nowIso())
        runtime.error = failure
        this.emitError(sessionID, failure)
      } finally {
        runtime.followUp = undefined
        runtime.rerun = false
        runtime.running = null
        runtime.progress = undefined
        delete runtime.backfill
      }
    })
    return { started: true, coalesced: false }
  }

  private async runTaskLoop(
    sessionID: string,
    runtime: SessionRuntime,
    task: () => Promise<void>,
    followUp: () => Promise<void>,
  ): Promise<void> {
    let current = task
    // A request can coalesce while the task waits for the lock (or while a
    // prepared task is preparing). Capture that flag before clearing it so the
    // acknowledged follow-up actually runs.
    let rerun = runtime.rerun
    for (;;) {
      runtime.rerun = false
      await current()
      if (this.isInactive(sessionID)) break
      if (!rerun && !runtime.rerun) break
      const pending = runtime.followUp
      runtime.followUp = undefined
      current = pending ?? followUp
      rerun = false
    }
  }

  /**
   * Run a task whose load -> validate -> decide work must happen under the same
   * lock as the job itself. The prepared value resolves once `prepare` succeeds;
   * prepare failures reject the caller without recording a runtime error.
   */
  private startPreparedTask<T>(sessionID: string, prepare: () => Promise<PreparedTask<T>>): Promise<T> {
    const runtime = this.runtime(sessionID)
    if (runtime.running) {
      return Promise.reject(new TimelineFailure("busy", "A timeline job is already running.", { sessionID }))
    }
    let resolveReady!: (value: T) => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<T>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    runtime.running = this.withLock(sessionID, async () => {
      try {
        let prepared: PreparedTask<T>
        try {
          prepared = await prepare()
        } catch (error) {
          rejectReady(error)
          // The failed prepare may have registered a backfill marker. The
          // follow-up drain is not a backfill, so clear it before running.
          delete runtime.backfill
          // A request may have coalesced onto this run while it was still
          // preparing. The caller was told it joined an active run, so drain
          // that request even though prepare produced no work.
          if (runtime.rerun && !this.isInactive(sessionID)) {
            const pending = runtime.followUp
            runtime.followUp = undefined
            await this.runTaskLoop(sessionID, runtime, pending ?? (async () => {}), async () => {})
          }
          return
        }
        resolveReady(prepared.value)
        await this.runTaskLoop(sessionID, runtime, prepared.run, prepared.followUp ?? prepared.run)
      } catch (error) {
        const failure = toTimelineError(error, this.nowIso())
        runtime.error = failure
        this.emitError(sessionID, failure)
      } finally {
        runtime.followUp = undefined
        runtime.rerun = false
        runtime.running = null
        runtime.progress = undefined
        delete runtime.backfill
      }
    })
    return ready
  }

  async waitForIdle(sessionID: string): Promise<void> {
    for (;;) {
      const runtime = this.runtimeBySession.get(sessionID)
      if (!runtime?.running) return
      await runtime.running
    }
  }

  async get(sessionID: string): Promise<GetResult> {
    this.assertNotDeleted(sessionID)
    await this.resolveSession(sessionID)
    const document = await this.recoverInterrupted(sessionID)
    const runtime = this.runtime(sessionID)
    return {
      document,
      busy: runtime.running !== null,
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {}),
      ...(runtime.error ? { error: runtime.error } : {}),
    }
  }

  async ensure(sessionID: string): Promise<EnsureResult> {
    this.assertNotDeleted(sessionID)
    await this.resolveSession(sessionID)
    const document = await this.recoverInterrupted(sessionID)
    const runtime = this.runtime(sessionID)
    if (this.disabledReason) {
      return {
        document,
        busy: runtime.running !== null,
        disabledReason: this.disabledReason,
        needsBackfill: false,
      }
    }
    // The panel calls `ensure` right after starting a build. Do not treat that
    // in-flight job as a fresh auto-start opportunity (it would throw "busy").
    // A normal incremental update keeps the current document visible as ready;
    // only a backfill needs the blocking progress state.
    if (runtime.running) {
      return { document, busy: runtime.backfill !== undefined, needsBackfill: false }
    }
    if (!document && runtime.error?.kind === "storage") {
      return { document: null, busy: false, needsBackfill: false, error: runtime.error }
    }
    if (!document) {
      const read = await readSessionMessages(this.deps.ctx, sessionID)
      const messages = settledMessages(read.messages)
      if (messages.length === 0) {
        if (this.runtime(sessionID).running !== null) {
          return { document: (await this.deps.store.load(sessionID)) ?? null, busy: true, needsBackfill: false }
        }
        return this.withLock(sessionID, async () => {
          const current = await this.deps.store.load(sessionID)
          if (current) {
            return {
              document: current,
              busy: this.runtime(sessionID).running !== null,
              needsBackfill: false,
            }
          }
          const info = await this.resolveSession(sessionID)
          const created = createDocument({
            sessionID,
            sessionTitle: info.title ?? null,
            model: this.deps.config.model!,
            promptVersion: PROMPT_VERSION,
            now: this.nowIso(),
          })
          await this.persist(sessionID, created)
          if (!this.isInactive(sessionID)) this.emitUpdated(created)
          return {
            document: created,
            busy: this.runtime(sessionID).running !== null,
            needsBackfill: false,
          }
        })
      }
      const estimate = estimateBackfill(messages, this.deps.config)
      if (estimate.approxCalls > this.deps.config.backfill.confirmOverCalls) {
        return { document: null, busy: false, needsBackfill: true, estimate }
      }
      return this.autoBackfill(sessionID, null)
    }
    if (document.backfill && document.backfill.completedAt === undefined) {
      return {
        document,
        busy: runtime.running !== null,
        needsBackfill: true,
        estimate: await this.remainingEstimate(sessionID, document),
        ...(runtime.error ? { error: runtime.error } : {}),
      }
    }
    if (document.status === "error" && document.watermark) {
      return {
        document,
        busy: false,
        needsBackfill: false,
        ...(runtime.error ? { error: runtime.error } : {}),
      }
    }
    if (document.meta.notice?.kind === "history-changed") {
      return {
        document,
        busy: false,
        needsBackfill: false,
        ...(runtime.error ? { error: runtime.error } : {}),
      }
    }
    // A failed error-state write leaves the stored document looking ready. Do
    // not let the panel's error reload start another automatic model call; the
    // user sees the runtime error and can retry with `r`.
    if (runtime.error?.kind === "storage") {
      return {
        document,
        busy: runtime.running !== null,
        needsBackfill: false,
        error: runtime.error,
      }
    }
    if (document.watermark === null) {
      const read = await readSessionMessages(this.deps.ctx, sessionID)
      const messages = settledMessages(read.messages)
      if (messages.length === 0) {
        return { document, busy: false, needsBackfill: false }
      }
      const estimate = estimateBackfill(messages, this.deps.config)
      if (estimate.approxCalls > this.deps.config.backfill.confirmOverCalls) {
        return { document, busy: false, needsBackfill: true, estimate }
      }
      return this.autoBackfill(sessionID, document)
    }
    const watermark = document.watermark
    const lastChecked = Date.parse(document.meta.lastCheckedAt)
    const due =
      !Number.isFinite(lastChecked) ||
      this.now() - lastChecked > this.deps.config.update.openRefreshAfterMinutes * 60_000
    if (due && document.status !== "error") {
      const read = await readSessionMessages(this.deps.ctx, sessionID)
      if (this.isInactive(sessionID)) {
        return {
          document,
          busy: runtime.running !== null,
          needsBackfill: false,
          ...(runtime.error ? { error: runtime.error } : {}),
        }
      }
      const messages = settledMessages(read.messages)
      const slice = sliceAfterWatermark(messages, watermark)
      if (slice.kind === "new") {
        // The panel should render the current document immediately; the refresh
        // runs in the background and reports through events.
        void this.refresh(sessionID, "open").catch((error) => {
          this.log("open refresh failed", { sessionID, error: sanitizeError(error) })
        })
        return {
          document,
          busy: true,
          needsBackfill: false,
          ...(runtime.error ? { error: runtime.error } : {}),
        }
      }
      // A rewritten (non-partial) transcript surfaces on open, not at the next
      // idle event. A partial (compacted) read keeps the document untouched; the
      // idle path finalizes or falls back to the timestamp slice.
      if (slice.kind === "history-changed" && !read.partial) {
        if (this.runtime(sessionID).running !== null) {
          return {
            document: (await this.deps.store.load(sessionID)) ?? document,
            busy: true,
            needsBackfill: false,
            ...(runtime.error ? { error: runtime.error } : {}),
          }
        }
        const current = await this.withLock(sessionID, async () => {
          const latest = await this.deps.store.load(sessionID)
          this.assertNotDeleted(sessionID)
          if (!latest) return null
          if (
            latest.watermark?.messageID === watermark.messageID &&
            latest.status !== "error" &&
            latest.meta.notice?.kind !== "history-changed"
          ) {
            const now = this.nowIso()
            latest.status = "stale"
            latest.meta.lastCheckedAt = now
            latest.meta.notice = historyChangedNotice(now)
            await this.persist(sessionID, latest)
            if (!this.isInactive(sessionID)) this.emitUpdated(latest)
          }
          return latest
        })
        return {
          document: current,
          busy: this.runtime(sessionID).running !== null,
          needsBackfill: false,
          ...(runtime.error ? { error: runtime.error } : {}),
        }
      }
      // The due check found nothing to process. Record the check so repeated
      // panel opens do not re-read the whole transcript until the interval
      // elapses again. A partial (compacted) history change is also a no-op:
      // the timestamp fallback resumes on the next settled message.
      if (slice.kind === "empty" || (slice.kind === "history-changed" && read.partial)) {
        const current = await this.markChecked(sessionID, watermark)
        return {
          document: current,
          busy: this.runtime(sessionID).running !== null,
          needsBackfill: false,
          ...(runtime.error ? { error: runtime.error } : {}),
        }
      }
    }
    return {
      document,
      busy: runtime.running !== null,
      needsBackfill: false,
      ...(runtime.error ? { error: runtime.error } : {}),
    }
  }

  /**
   * Persist a no-op open check. The read already happened, so advancing
   * `lastCheckedAt` is what makes `openRefreshAfterMinutes` gate the next one.
   * Re-load under the lock and bail if a real job changed the watermark while
   * the transcript was being read.
   */
  private async markChecked(sessionID: string, watermark: TimelineWatermark): Promise<TimelineDocument | null> {
    return this.withLock(sessionID, async () => {
      const latest = await this.deps.store.load(sessionID)
      this.assertNotDeleted(sessionID)
      if (!latest) return null
      if (latest.watermark?.messageID !== watermark.messageID) return latest
      if (latest.status === "error" || latest.meta.notice?.kind === "history-changed") return latest
      latest.meta.lastCheckedAt = this.nowIso()
      await this.persist(sessionID, latest)
      return latest
    })
  }

  private async autoBackfill(sessionID: string, fallback: TimelineDocument | null): Promise<EnsureResult> {
    try {
      const result = await this.backfillInternal(sessionID, true, true)
      const current = (await this.deps.store.load(sessionID)) ?? fallback
      if (result.needsBackfill) {
        return {
          document: current,
          busy: false,
          needsBackfill: true,
          estimate: result.estimate,
          ...(this.runtime(sessionID).error ? { error: this.runtime(sessionID).error } : {}),
        }
      }
      return {
        document: current,
        busy: result.started,
        needsBackfill: false,
      }
    } catch (error) {
      if (error instanceof TimelineFailure && error.code === "busy") {
        return {
          document: (await this.deps.store.load(sessionID)) ?? fallback,
          busy: true,
          needsBackfill: false,
        }
      }
      if (error instanceof TimelineFailure && error.code === "confirmation_required") {
        const estimate = estimateOf(error.data)
        return {
          document: fallback,
          busy: false,
          needsBackfill: true,
          ...(estimate ? { estimate } : {}),
        }
      }
      // A concurrent rebuild can finish between ensure's read and the auto-start.
      // The backfill then reports "already built"; ensure is idempotent, so return
      // the current document instead of surfacing a race as an error.
      if (error instanceof TimelineFailure && error.code === "invalid_request") {
        return {
          document: (await this.deps.store.load(sessionID)) ?? fallback,
          busy: false,
          needsBackfill: false,
        }
      }
      throw error
    }
  }

  private async recoverInterrupted(sessionID: string): Promise<TimelineDocument | null> {
    const document = await this.deps.store.load(sessionID)
    this.assertNotDeleted(sessionID)
    if (!document) return null
    // A disabled or stopped engine must not rewrite a document just to report
    // an interrupted backfill; the caller only needs the stored state.
    if (this.disabledReason || this.stopped) return document
    if (document.status !== "backfilling") return document
    // Never queue a read-only recovery behind a long-running job. The check and
    // the lock acquisition are synchronous with each other, so a job that starts
    // in between is observed by the re-check inside the lock.
    if (this.runtime(sessionID).running !== null) return document
    return this.withLock(sessionID, async () => {
      const current = await this.deps.store.load(sessionID)
      this.assertNotDeleted(sessionID)
      if (!current) return null
      if (this.disabledReason || this.stopped) return current
      if (current.status === "backfilling" && this.runtime(sessionID).running === null) {
        // The recovery write is not a retry: keep the failure that interrupted
        // the job visible until a real run succeeds.
        const failure = this.runtime(sessionID).error
        current.status = current.backfill?.error ? "error" : "paused"
        await this.persist(sessionID, current)
        if (failure) this.runtime(sessionID).error = failure
        if (!this.isInactive(sessionID)) this.emitUpdated(current)
      }
      return current
    })
  }

  async backfill(sessionID: string, confirm = false): Promise<{ started: boolean; estimate: TimelineEstimate }> {
    const result = await this.backfillInternal(sessionID, confirm, false)
    return { started: result.started, estimate: result.estimate }
  }

  private async backfillInternal(sessionID: string, confirm: boolean, auto: boolean): Promise<BackfillResult> {
    const info = await this.resolveSession(sessionID)
    this.assertActive(sessionID)
    this.assertEnabled()
    if (this.runtime(sessionID).running) {
      throw new TimelineFailure("busy", "A timeline job is already running.", { sessionID })
    }
    const value = await this.startPreparedTask<BackfillResult>(sessionID, async () => {
      this.assertActive(sessionID)
      this.runtime(sessionID).backfill = { cancelled: false }
      const document = await this.deps.store.load(sessionID)
      this.assertActive(sessionID)
      if (auto && document?.backfill && document.backfill.completedAt === undefined) {
        // `ensure` read the document before deciding to auto-start. A concurrent
        // run may have cancelled or failed in the meantime, leaving an
        // incomplete backfill. Surface it for explicit resume instead of
        // silently restarting it.
        delete this.runtime(sessionID).backfill
        const read = await readSessionMessages(this.deps.ctx, sessionID)
        this.assertActive(sessionID)
        const messages = settledMessages(read.messages)
        const remaining = remainingMessages(messages, document.watermark)
        const estimate = estimateBackfill(remaining.kind === "messages" ? remaining.messages : [], this.deps.config)
        return { run: async () => {}, value: { started: false, estimate, needsBackfill: true } }
      }
      if (document?.watermark && (!document.backfill || document.backfill.completedAt !== undefined)) {
        throw new TimelineFailure("invalid_request", "Recap already built; use rebuild.", { sessionID })
      }

      const read = await readSessionMessages(this.deps.ctx, sessionID)
      this.assertActive(sessionID)
      const messages = settledMessages(read.messages)
      const remaining = remainingMessages(messages, document?.watermark ?? null)

      if (remaining.kind === "history-changed" && !read.partial) {
        const target = document ?? this.newDocument(info)
        const now = this.nowIso()
        target.status = "stale"
        // A rewritten transcript cannot be resumed; only a rebuild can recover.
        // Clear the incomplete backfill so `ensure` surfaces the notice rather
        // than offering a resume that can never make progress.
        target.backfill = null
        target.meta.lastCheckedAt = now
        target.meta.notice = historyChangedNotice(now)
        await this.persist(sessionID, target)
        if (!this.isInactive(sessionID)) this.emitUpdated(target)
        return {
          run: async () => {},
          value: { started: false, estimate: estimateBackfill([], this.deps.config) },
        }
      }

      const pending = remaining.kind === "messages" ? remaining.messages : []
      const estimate = estimateBackfill(pending, this.deps.config)
      if (auto && estimate.approxCalls > this.deps.config.backfill.confirmOverCalls) {
        // Messages arrived between `ensure`'s estimate and this locked snapshot.
        // The authoritative estimate is over threshold, so surface it for
        // confirmation instead of starting without one.
        delete this.runtime(sessionID).backfill
        return { run: async () => {}, value: { started: false, estimate, needsBackfill: true } }
      }
      if (estimate.approxCalls > this.deps.config.backfill.confirmOverCalls && !confirm) {
        throw new TimelineFailure("confirmation_required", "This backfill needs confirmation.", estimate)
      }

      if (pending.length === 0) {
        const target = document ?? this.newDocument(info)
        if (read.partial) {
          target.coverage.partial = true
          target.coverage.reason = read.partialReason ?? "compacted-history"
        }
        delete target.meta.notice
        // Resuming a backfill that has no remaining messages finalizes it rather
        // than downgrading a document that already has chapters to "empty".
        if (target.backfill && target.backfill.completedAt === undefined) {
          target.backfill.processedMessages = target.backfill.totalMessages
          target.backfill.completedAt = this.nowIso()
          delete target.backfill.cancelled
          delete target.backfill.error
        }
        delete target.meta.lastError
        target.status = target.chapters.length > 0 ? "ready" : "empty"
        target.meta.lastCheckedAt = this.nowIso()
        await this.persist(sessionID, target)
        if (!this.isInactive(sessionID)) this.emitUpdated(target)
        return { run: async () => {}, value: { started: false, estimate } }
      }

      this.assertActive(sessionID)
      const target = document ?? this.newDocument(info)
      return {
        run: () => this.runBackfill(sessionID, info, target, pending, read.partialReason, messages.length),
        // Catch up on messages that arrived during the backfill in exactly one
        // forced pass; a threshold-skipped "open" refresh would leave them
        // pending until the next idle event.
        followUp: () => this.refreshOnce(sessionID, info, "force", true),
        value: { started: true, estimate },
      }
    })
    return value
  }

  private async runBackfill(
    sessionID: string,
    info: SessionInfo,
    document: TimelineDocument,
    messages: readonly SessionMessageInfo[],
    partialReason: SessionPartialReason | undefined,
    // `TimelineWatermark.messageCount` is a diagnostic (spec §5.1): the transcript
    // length of the read that produced this snapshot — never the cumulative
    // backfill total across resumes.
    contextLength: number,
  ): Promise<void> {
    const runtime = this.runtime(sessionID)
    // A cancel can arrive while the prepare read is still in flight; reuse the
    // object so that cancellation is not lost when the job starts.
    const cancelState = (runtime.backfill ??= { cancelled: false })
    const now = this.nowIso()
    document.sessionTitle = info.title ?? document.sessionTitle
    const alreadyProcessed = document.backfill?.processedMessages ?? 0
    const state: TimelineBackfill = {
      processedMessages: alreadyProcessed,
      totalMessages: alreadyProcessed + messages.length,
      startedAt: document.backfill?.startedAt ?? now,
    }
    document.status = "backfilling"
    document.backfill = state
    delete document.meta.notice
    if (partialReason) {
      document.coverage.partial = true
      document.coverage.reason = partialReason
    }
    await this.persist(sessionID, document)
    if (this.isInactive(sessionID)) {
      delete runtime.backfill
      return
    }
    this.emitUpdated(document)

    const chunks = chunkMessages(messages, this.deps.config)
    let processed = alreadyProcessed

    for (const chunk of chunks) {
      if (this.isInactive(sessionID)) {
        delete runtime.backfill
        return
      }
      if (cancelState.cancelled) break

      const digest = buildDigest(chunk, this.deps.config)
      const last = chunk[chunk.length - 1]
      if (!last) continue

      if (digest.includedCount === 0) {
        const previousWatermark = document.watermark
        const previousProcessed = processed
        this.advanceWatermark(document, last, contextLength)
        processed += chunk.length
        state.processedMessages = processed
        document.meta.lastCheckedAt = this.nowIso()
        try {
          await this.persist(sessionID, document)
        } catch (error) {
          document.watermark = previousWatermark
          processed = previousProcessed
          state.processedMessages = previousProcessed
          throw error
        }
        if (this.isInactive(sessionID)) {
          delete runtime.backfill
          return
        }
        this.emitProgress(sessionID, "backfill", processed, state.totalMessages, document.chapters.length)
        continue
      }

      const prompt = buildPrompt({
        document,
        digest: digest.text,
        evidence: digest.evidence,
        config: this.deps.config,
      })

      let result: { output: ValidatedOutput; calls: number; chars: number }
      try {
        result = await this.callModel(prompt, digest.aliasMap)
      } catch (error) {
        if (this.isInactive(sessionID)) {
          delete runtime.backfill
          return
        }
        // A cancellation while the model call was in flight is not a failure:
        // discard the result and let the loop mark the backfill paused.
        if (cancelState.cancelled) break
        await this.handleModelFailure(sessionID, document, error, prompt.length, false, 1, state)
        delete runtime.backfill
        return
      }

      if (this.isInactive(sessionID)) {
        delete runtime.backfill
        return
      }
      if (cancelState.cancelled) break

      applyOutput(document, {
        output: result.output,
        now: this.nowIso(),
        coveragePartial: partialReason !== undefined,
        ...(partialReason ? { coverageReason: partialReason } : {}),
        model: this.deps.config.model!,
        promptVersion: PROMPT_VERSION,
        log: this.log,
      })
      const previousWatermark = document.watermark
      const previousProcessed = processed
      this.advanceWatermark(document, last, contextLength)
      processed += chunk.length
      state.processedMessages = processed
      document.status = "backfilling"
      document.meta.lastCheckedAt = this.nowIso()
      this.recordCalls(document, result.chars, false, result.calls)
      try {
        await this.persist(sessionID, document)
      } catch (error) {
        document.watermark = previousWatermark
        processed = previousProcessed
        state.processedMessages = previousProcessed
        throw error
      }
      if (this.isInactive(sessionID)) {
        delete runtime.backfill
        return
      }
      this.emitProgress(sessionID, "backfill", processed, state.totalMessages, document.chapters.length)
    }

    if (this.isInactive(sessionID)) {
      delete runtime.backfill
      return
    }

    if (cancelState.cancelled) {
      document.status = document.watermark ? "paused" : "empty"
      state.cancelled = true
      delete state.completedAt
      document.meta.lastCheckedAt = this.nowIso()
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) {
        delete runtime.backfill
        return
      }
      this.emitUpdated(document)
      delete runtime.backfill
      return
    }

    state.completedAt = this.nowIso()
    document.status = "ready"
    document.meta.lastCheckedAt = this.nowIso()
    delete document.meta.lastError
    await this.persist(sessionID, document)
    if (this.isInactive(sessionID)) {
      delete runtime.backfill
      return
    }

    // A cancel can land while the completion persist is in flight. The chunks
    // are already durable, so record the cancellation without rewinding.
    if (cancelState.cancelled) {
      document.status = document.watermark ? "paused" : "empty"
      state.cancelled = true
      delete state.completedAt
      document.meta.lastCheckedAt = this.nowIso()
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) {
        delete runtime.backfill
        return
      }
      this.emitUpdated(document)
      delete runtime.backfill
      return
    }
    this.emitUpdated(document)
    delete runtime.backfill

    const latest = await readSessionMessages(this.deps.ctx, sessionID)
    if (this.isInactive(sessionID)) return
    const tail = settledMessages(latest.messages)
    const slice = sliceAfterWatermark(tail, document.watermark)
    if (slice.kind === "new") {
      document.status = "stale"
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) return
      this.emitUpdated(document)
      runtime.rerun = true
    } else if (slice.kind === "history-changed" && !latest.partial) {
      const checkedAt = this.nowIso()
      document.status = "stale"
      document.meta.lastCheckedAt = checkedAt
      document.meta.notice = historyChangedNotice(checkedAt)
      await this.persist(sessionID, document)
      if (this.isInactive(sessionID)) return
      this.emitUpdated(document)
    }
  }

  async rebuild(sessionID: string, confirm = false): Promise<{ started: boolean; estimate: TimelineEstimate }> {
    const info = await this.resolveSession(sessionID)
    this.assertActive(sessionID)
    this.assertEnabled()
    if (this.runtime(sessionID).running) {
      throw new TimelineFailure("busy", "A timeline job is already running.", { sessionID })
    }
    const value = await this.startPreparedTask(sessionID, async () => {
      this.assertActive(sessionID)
      this.runtime(sessionID).backfill = { cancelled: false }
      const read = await readSessionMessages(this.deps.ctx, sessionID)
      this.assertActive(sessionID)
      const messages = settledMessages(read.messages)
      const estimate = estimateBackfill(messages, this.deps.config)
      if (!confirm) {
        throw new TimelineFailure("confirmation_required", "Rebuilding clears the existing timeline.", estimate)
      }

      const document = this.newDocument(info)
      if (messages.length === 0) {
        document.status = "empty"
        await this.persist(sessionID, document)
        if (!this.isInactive(sessionID)) this.emitUpdated(document)
        return { run: async () => {}, value: { started: false, estimate } }
      }

      return {
        run: () => this.runBackfill(sessionID, info, document, messages, read.partialReason, messages.length),
        // Catch up on messages that arrived during the backfill in exactly one
        // forced pass; a threshold-skipped "open" refresh would leave them
        // pending until the next idle event.
        followUp: () => this.refreshOnce(sessionID, info, "force", true),
        value: { started: true, estimate },
      }
    })
    return { started: value.started, estimate: value.estimate }
  }

  async cancel(sessionID: string): Promise<{ cancelled: boolean }> {
    await this.resolveSession(sessionID)
    const runtime = this.runtimeBySession.get(sessionID)
    if (!runtime?.backfill) return { cancelled: false }
    runtime.backfill.cancelled = true
    return { cancelled: true }
  }

  private newDocument(info: SessionInfo): TimelineDocument {
    return createDocument({
      sessionID: info.id,
      sessionTitle: info.title ?? null,
      model: this.deps.config.model!,
      promptVersion: PROMPT_VERSION,
      now: this.nowIso(),
    })
  }

  private async remainingEstimate(sessionID: string, document: TimelineDocument): Promise<TimelineEstimate> {
    const read = await readSessionMessages(this.deps.ctx, sessionID)
    const messages = settledMessages(read.messages)
    const remaining = remainingMessages(messages, document.watermark)
    // A non-partial rewrite cannot be resumed; report zero remaining messages.
    // `backfill` persists the history-changed notice when the user retries.
    if (remaining.kind === "history-changed" && !read.partial) {
      return estimateBackfill([], this.deps.config)
    }
    return estimateBackfill(remaining.kind === "messages" ? remaining.messages : [], this.deps.config)
  }
}
