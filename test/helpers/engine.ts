import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import {
  DEFAULT_BACKFILL,
  DEFAULT_DIGEST,
  DEFAULT_LIMITS,
  DEFAULT_UPDATE,
  type BackfillConfig,
  type DigestConfig,
  type LimitsConfig,
  type TimelineConfig,
  type UpdateConfig,
} from "../../src/config"
import { createDocument } from "../../src/shared/document"
import { STORAGE_PREFIX } from "../../src/shared/ids"
import type { TimelineDocument, TimelineModelRef } from "../../src/shared/types"
import type { Clock, TimerHandle } from "../../src/server/clock"
import { TimelineEngine, type EngineDeps, type EngineEventSink } from "../../src/server/engine"
import type { ModelClient } from "../../src/server/model"
import { PluginTimelineStore } from "../../src/server/store"

export const TEST_SESSION_ID = "ses_1"
export const TEST_PROJECT_ID = "proj_1"
export const TEST_MODEL: TimelineModelRef = { providerID: "openai", modelID: "gpt-5-mini" }
export const NOOP_OUTPUT = '{"goal":"","tasks":null,"chapters":[]}'

export class FakeClock implements Clock {
  private time = Date.parse("2026-10-29T10:00:00.000Z")
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  private nextID = 1

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextID++
    this.timers.set(id, { at: this.time + ms, callback })
    return id as unknown as TimerHandle
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number)
  }

  pending(): number {
    return this.timers.size
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .toSorted((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      this.timers.delete(id)
      this.time = timer.at
      timer.callback()
      // A single microtask tick is not enough: scheduler callbacks drive async
      // chains (store loads, model calls, persist). Drain a bounded number of
      // microtasks so awaits inside the chain settle before the next timer.
      await drainMicrotasks()
    }
    this.time = target
  }
}

export class FakeStorage {
  readonly values = new Map<string, unknown>()
  failNextSet = false
  failSet = false

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key)
    return value === undefined ? undefined : structuredClone(value)
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error("disk full")
    }
    if (this.failSet) throw new Error("disk full")
    this.values.set(key, structuredClone(value))
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }

  seed(document: TimelineDocument): void {
    this.values.set(`${STORAGE_PREFIX}/${document.sessionID}`, structuredClone(document))
  }

  document(sessionID: string): TimelineDocument | undefined {
    const value = this.values.get(`${STORAGE_PREFIX}/${sessionID}`)
    return value === undefined ? undefined : (structuredClone(value) as TimelineDocument)
  }
}

class FakeEvents {
  private readonly queue: unknown[] = []
  private wake: (() => void) | undefined

  push(event: unknown): void {
    this.queue.push(event)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *subscribe(options: { signal?: AbortSignal } = {}): AsyncGenerator<unknown> {
    const signal = options.signal
    for (;;) {
      if (signal?.aborted) return
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal?.removeEventListener("abort", onAbort)
            resolve()
          }
          const onAbort = () => {
            if (this.wake === wake) this.wake = undefined
            resolve()
          }
          this.wake = wake
          signal?.addEventListener("abort", onAbort, { once: true })
        })
      }
      while (this.queue.length > 0) {
        if (signal?.aborted) return
        yield this.queue.shift()
      }
    }
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 500; tick += 1) await Promise.resolve()
}

export interface FakeModelCall {
  prompt: string
  signal: AbortSignal | undefined
}

export interface FakeModelState {
  outputs: string[]
  errors: unknown[]
  gate?: Promise<void> | undefined
  calls: FakeModelCall[]
  inFlight: number
  maxInFlight: number
}

function createFakeModel(state: FakeModelState): ModelClient {
  return {
    async complete(prompt, signal) {
      state.calls.push({ prompt, signal })
      state.inFlight += 1
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        const gate = state.gate
        if (gate) await gate
        const error = state.errors.shift()
        if (error !== undefined) throw error
        return state.outputs.shift() ?? NOOP_OUTPUT
      } finally {
        state.inFlight -= 1
      }
    },
  }
}

export interface TestConfigOverrides {
  enabled?: boolean
  model?: TimelineModelRef | null
  update?: Partial<UpdateConfig>
  backfill?: Partial<BackfillConfig>
  digest?: Partial<DigestConfig>
  limits?: Partial<LimitsConfig>
}

export interface TestEngineOptions {
  sessionID?: string
  messages?: SessionMessageInfo[]
  session?: Partial<SessionInfo>
  sessionError?: unknown
  outputs?: string[]
  modelError?: unknown
  document?: TimelineDocument
  config?: TestConfigOverrides
  modelList?: unknown
  disabledReason?: string
  storage?: FakeStorage
}

export type RecordedEngineEvent =
  | { type: "updated"; data: Parameters<EngineEventSink["updated"]>[0] }
  | { type: "progress"; data: Parameters<EngineEventSink["progress"]>[0] }
  | { type: "error"; data: Parameters<EngineEventSink["error"]>[0] }

export interface TestEngineHarness {
  engine: TimelineEngine
  store: PluginTimelineStore
  clock: FakeClock
  storage: FakeStorage
  events: RecordedEngineEvent[]
  logs: Array<{ message: string; data?: Record<string, unknown> }>
  modelCalls: FakeModelCall[]
  modelState: FakeModelState
  session: SessionInfo
  messages: SessionMessageInfo[]
  config: TimelineConfig
  emitEvent(event: unknown): Promise<void>
  emitIdle(sessionID?: string): Promise<void>
  drain(): Promise<void>
  waitFor(condition: () => boolean, label: string): Promise<void>
}

export function makeDocument(
  overrides: {
    sessionID?: string
    watermark?: TimelineDocument["watermark"]
    status?: TimelineDocument["status"]
    now?: string
  } = {},
): TimelineDocument {
  const now = overrides.now ?? "2026-10-29T10:00:00.000Z"
  const sessionID = overrides.sessionID ?? TEST_SESSION_ID
  const document = createDocument({
    sessionID,
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 1,
    now,
  })
  if (overrides.watermark !== undefined) document.watermark = overrides.watermark
  if (overrides.status !== undefined) document.status = overrides.status
  return document
}

export function createTestEngine(options: TestEngineOptions = {}): TestEngineHarness {
  const sessionID = options.sessionID ?? TEST_SESSION_ID
  const clock = new FakeClock()
  const storage = options.storage ?? new FakeStorage()
  const store = new PluginTimelineStore(storage as unknown as Plugin.Context["storage"])
  const messages = options.messages ?? []
  const fakeEvents = new FakeEvents()
  const events: RecordedEngineEvent[] = []
  const logs: Array<{ message: string; data?: Record<string, unknown> }> = []

  const model = options.config?.model === null ? undefined : (options.config?.model ?? TEST_MODEL)
  const config: TimelineConfig = {
    enabled: options.config?.enabled ?? true,
    ...(model ? { model } : {}),
    update: { ...DEFAULT_UPDATE, ...options.config?.update },
    backfill: { ...DEFAULT_BACKFILL, ...options.config?.backfill },
    digest: { ...DEFAULT_DIGEST, ...options.config?.digest },
    limits: { ...DEFAULT_LIMITS, ...options.config?.limits },
  }

  const session = {
    id: sessionID,
    projectID: TEST_PROJECT_ID,
    title: "Test session",
    cost: 0,
    tokens: {},
    time: { created: clock.now(), updated: clock.now() },
    location: { directory: "/tmp" },
    ...options.session,
  } as unknown as SessionInfo

  const defaultModels = model ? [{ ...model, enabled: true }] : []
  const modelList = options.modelList ?? { data: defaultModels }

  const ctx = {
    session: {
      async get() {
        if (options.sessionError !== undefined) throw options.sessionError
        return session
      },
      async context() {
        return messages
      },
    },
    model: {
      async list() {
        return modelList
      },
    },
    event: fakeEvents,
    generate: { text: async () => ({ text: "" }) },
    experimental: { terminal: { read: async () => ({}) } },
    location: {
      directory: "/tmp",
      project: { id: TEST_PROJECT_ID, directory: "/tmp", canonical: "/tmp" },
    },
    storage,
  } as unknown as EngineDeps["ctx"]

  const modelState: FakeModelState = {
    outputs: [...(options.outputs ?? [])],
    errors: options.modelError === undefined ? [] : [options.modelError],
    calls: [],
    inFlight: 0,
    maxInFlight: 0,
  }
  const modelClient = createFakeModel(modelState)

  const sink: EngineEventSink = {
    updated(data) {
      events.push({ type: "updated", data })
    },
    progress(data) {
      events.push({ type: "progress", data })
    },
    error(data) {
      events.push({ type: "error", data })
    },
  }

  if (options.document) storage.seed(options.document)

  const engine = new TimelineEngine({
    ctx,
    config,
    store,
    model: modelClient,
    clock,
    events: sink,
    ...(options.disabledReason !== undefined ? { disabledReason: options.disabledReason } : {}),
    log(message, data) {
      logs.push(data === undefined ? { message } : { message, data })
    },
  })

  return {
    engine,
    store,
    clock,
    storage,
    events,
    logs,
    modelCalls: modelState.calls,
    modelState,
    session,
    messages,
    config,
    async emitEvent(event) {
      fakeEvents.push(event)
      await drainMicrotasks()
    },
    async emitIdle(id = sessionID) {
      fakeEvents.push({ type: "session.idle", data: { sessionID: id } })
      await drainMicrotasks()
    },
    drain: drainMicrotasks,
    async waitFor(condition, label) {
      for (let tick = 0; tick < 2_000; tick += 1) {
        if (condition()) return
        await Promise.resolve()
      }
      throw new Error(`Timed out waiting for ${label}`)
    },
  }
}
