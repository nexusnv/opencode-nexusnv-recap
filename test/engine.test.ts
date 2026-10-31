import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { TimelineFailure } from "../src/server/errors"
import { ModelFailure } from "../src/server/model"
import type { TimelineDocument, TimelineWatermark } from "../src/shared/types"
import {
  NOOP_OUTPUT,
  TEST_MODEL,
  TEST_SESSION_ID,
  createTestEngine,
  makeDocument,
  type TestConfigOverrides,
  type TestEngineHarness,
} from "./helpers/engine"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

let sequence = 0

function nextID(prefix: string): string {
  sequence += 1
  return `${prefix}_${sequence}`
}

type UserMessage = Extract<SessionMessageInfo, { type: "user" }>
type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>
type ShellMessage = Extract<SessionMessageInfo, { type: "shell" }>
type IdleMessage = Extract<SessionMessageInfo, { type: "idle" }>
type CompactionMessage = Extract<SessionMessageInfo, { type: "compaction" }>

function user(created: number, text = "hello"): UserMessage {
  return { id: nextID("user"), time: { created }, type: "user", text }
}

function assistant(created: number, options: { completed?: number | undefined } = {}): AssistantMessage {
  return {
    id: nextID("assistant"),
    time: { created, ...(options.completed === undefined ? {} : { completed: options.completed }) },
    type: "assistant",
    agent: "build",
    model: { id: TEST_MODEL.modelID, providerID: TEST_MODEL.providerID },
    content: [{ type: "text", text: "done" }],
  }
}

function shell(created: number, status: ShellMessage["status"] = "running", output = ""): ShellMessage {
  return {
    id: nextID("shell"),
    time: { created, ...(status === "exited" ? { completed: created + 1_000 } : {}) },
    type: "shell",
    shellID: "sh_1",
    command: "bun test",
    status,
    ...(status === "exited" ? { exit: 0 } : {}),
    ...(output ? { output: { output, cursor: 0, size: output.length, truncated: false } } : {}),
  }
}

function idleMessage(created: number): IdleMessage {
  return { id: nextID("idle"), time: { created }, type: "idle", outcome: "succeeded" }
}

function compaction(created: number): CompactionMessage {
  return {
    id: nextID("compaction"),
    time: { created },
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "Earlier work",
  }
}

function watermarkOf(message: SessionMessageInfo, messageCount = 1): TimelineWatermark {
  return {
    messageID: message.id,
    createdAt: new Date(message.time.created).toISOString(),
    messageCount,
  }
}

const QUICK_UPDATE = {
  debounceMs: 1_000,
  minNewUserTurns: 1,
  minNewMessages: 1,
  forceAfterMinutes: 10,
}

function quickConfig(overrides: TestConfigOverrides = {}): TestConfigOverrides {
  return { ...overrides, update: { ...QUICK_UPDATE, ...overrides.update } }
}

function chapterOutput(anchor = "m1"): string {
  return JSON.stringify({
    goal: "Ship the timeline",
    tasks: null,
    chapters: [
      {
        mode: "new",
        title: "Refresh engine",
        summary: "Implemented the refresh engine",
        highlights: [
          {
            kind: "implementation",
            text: "Implemented the refresh engine",
            anchor,
          },
        ],
      },
    ],
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function finish(h: TestEngineHarness): Promise<void> {
  await h.drain()
  await h.engine.waitForIdle(TEST_SESSION_ID)
  await h.drain()
}

async function storedDocument(h: TestEngineHarness, sessionID = TEST_SESSION_ID): Promise<TimelineDocument> {
  const document = h.storage.document(sessionID)
  if (!document) throw new Error("expected a persisted document")
  return document
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the promise to reject")
}

describe("TimelineEngine debounce and thresholds", () => {
  test("debounces idle events and refreshes exactly once", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(500)
    await h.emitIdle()
    await h.clock.advance(500)
    expect(h.modelCalls).toHaveLength(0)

    await h.clock.advance(1_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    expect((await storedDocument(h)).watermark?.messageID).toBe(fresh.id)
    await h.engine.stop()
  })

  test("small recent batches become stale without a model call and schedule the force timer", async () => {
    const old = user(BASE_TIME - 600_000)
    const fresh = user(BASE_TIME)
    const h = createTestEngine({
      messages: [old, fresh],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: {
        update: { debounceMs: 1_000, minNewUserTurns: 2, minNewMessages: 6, forceAfterMinutes: 10 },
      },
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    const document = await storedDocument(h)
    expect(document.status).toBe("stale")
    expect(document.watermark?.messageID).toBe(old.id)
    expect(h.clock.pending()).toBeGreaterThan(0)
    await h.engine.stop()
  })

  test("the force timer processes a below-threshold batch once it elapses", async () => {
    const old = user(BASE_TIME - 600_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 1_500 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: {
        update: { debounceMs: 1_000, minNewUserTurns: 2, minNewMessages: 6, forceAfterMinutes: 10 },
      },
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)
    expect(h.modelCalls).toHaveLength(0)
    expect((await storedDocument(h)).status).toBe("stale")

    await h.clock.advance(600_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    const document = await storedDocument(h)
    expect(document.status).toBe("ready")
    expect(document.watermark?.messageID).toBe(reply.id)
    await h.engine.stop()
  })

  test("a busy force timer defers to the next idle event", async () => {
    const old = user(BASE_TIME - 600_000)
    const fresh = user(BASE_TIME)
    const pending = assistant(BASE_TIME + 1_000)
    const h = createTestEngine({
      messages: [old, fresh, pending],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: {
        update: { debounceMs: 1_000, minNewUserTurns: 2, minNewMessages: 6, forceAfterMinutes: 10 },
      },
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)
    expect((await storedDocument(h)).status).toBe("stale")

    await h.clock.advance(600_000)
    await finish(h)
    expect(h.modelCalls).toHaveLength(0)
    expect((await storedDocument(h)).watermark?.messageID).toBe(old.id)

    pending.time.completed = h.clock.now()
    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    expect((await storedDocument(h)).watermark?.messageID).toBe(pending.id)
    await h.engine.stop()
  })

  test("idle events never start a first build", async () => {
    const h = createTestEngine({
      messages: [user(BASE_TIME)],
      config: quickConfig(),
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(5_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    await h.engine.stop()
  })

  test("child sessions are ignored without creating a document", async () => {
    const h = createTestEngine({
      messages: [user(BASE_TIME)],
      session: { parentID: "ses_parent" },
      config: quickConfig(),
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(5_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    await h.engine.stop()
  })
})

describe("TimelineEngine refresh control", () => {
  test("coalesces concurrent refreshes into one follow-up run without overlap", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gate = gate.promise

    const first = h.engine.refresh(TEST_SESSION_ID, "manual")
    await h.waitFor(() => h.modelCalls.length === 1, "the first model call")
    const second = h.engine.refresh(TEST_SESSION_ID, "manual")
    const third = h.engine.refresh(TEST_SESSION_ID, "manual")
    expect(await second).toEqual({ started: false, coalesced: true })
    expect(await third).toEqual({ started: false, coalesced: true })

    gate.resolve()
    await first
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    expect(h.modelState.maxInFlight).toBe(1)
    await h.engine.stop()
  })

  test("a refresh requested during a run executes once after it finishes", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const later = user(BASE_TIME + 3_000, "follow up")
    const h = createTestEngine({
      messages: [old, fresh, reply],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gate = gate.promise

    const first = h.engine.refresh(TEST_SESSION_ID, "manual")
    await h.waitFor(() => h.modelCalls.length === 1, "the first model call")
    h.messages.push(later)
    expect(await h.engine.refresh(TEST_SESSION_ID, "manual")).toEqual({
      started: false,
      coalesced: true,
    })

    gate.resolve()
    await first
    await h.waitFor(() => h.modelCalls.length === 2, "the coalesced follow-up call")
    await finish(h)

    expect(h.modelCalls).toHaveLength(2)
    expect(h.modelState.maxInFlight).toBe(1)
    expect((await storedDocument(h)).watermark?.messageID).toBe(later.id)
    await h.engine.stop()
  })

  test("a coalesced manual refresh keeps its own reason and force semantics", async () => {
    const old = user(BASE_TIME - 700_000)
    const firstUser = user(BASE_TIME - 2_000)
    const secondUser = user(BASE_TIME - 1_000)
    const reply = assistant(BASE_TIME + 500, { completed: BASE_TIME + 1_000 })
    const later = user(BASE_TIME + 2_000, "manual follow up")
    const h = createTestEngine({
      messages: [old, firstUser, secondUser, reply],
      outputs: [NOOP_OUTPUT, NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig({ update: { minNewUserTurns: 2, minNewMessages: 6 } }),
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gate = gate.promise

    await h.emitIdle()
    await h.clock.advance(1_000)
    await h.waitFor(() => h.modelCalls.length === 1, "the gated idle model call")

    h.messages.push(later)
    expect(await h.engine.refresh(TEST_SESSION_ID, "manual")).toEqual({
      started: false,
      coalesced: true,
    })

    gate.resolve()
    await finish(h)

    expect(h.modelCalls).toHaveLength(2)
    expect((await storedDocument(h)).watermark?.messageID).toBe(later.id)
    await h.engine.stop()
  })

  test("automatic refresh respects the hourly cap and manual refresh bypasses it", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const document = makeDocument({ watermark: watermarkOf(old) })
    document.meta.recentAutoCalls = [new Date(BASE_TIME).toISOString()]
    const h = createTestEngine({
      messages: [old, fresh, reply],
      document,
      config: quickConfig({ limits: { maxUpdatesPerHour: 1 } }),
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    const capped = await storedDocument(h)
    expect(capped.status).toBe("stale")
    expect(capped.meta.notice?.kind).toBe("hourly-cap")
    expect(capped.watermark?.messageID).toBe(old.id)

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    const refreshed = await storedDocument(h)
    expect(refreshed.meta.notice).toBeUndefined()
    expect(refreshed.status).toBe("ready")
    expect(refreshed.watermark?.messageID).toBe(reply.id)
    await h.engine.stop()
  })

  test("stop clears pending timers", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const document = makeDocument({ watermark: watermarkOf(old) })
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [NOOP_OUTPUT],
      document,
      config: quickConfig(),
    })
    await h.engine.start()

    await h.emitIdle()
    expect(h.clock.pending()).toBeGreaterThan(0)
    await h.engine.stop()

    await h.clock.advance(5_000)
    await h.drain()

    expect(h.modelCalls).toHaveLength(0)
    expect((await storedDocument(h)).watermark?.messageID).toBe(old.id)
  })

  test("stop rejects a manual refresh without writing", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()
    await h.engine.stop()
    const writes = h.storage.writes

    const failure = await failureOf(h.engine.refresh(TEST_SESSION_ID, "manual"))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("internal")
    expect((failure as Error).message).toBe("Recap is shutting down.")

    await h.drain()
    expect(h.storage.writes).toBe(writes)
    expect((await storedDocument(h)).watermark?.messageID).toBe(old.id)
  })

  test("stop ignores a model result that resolves after the engine stopped", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const document = makeDocument({ watermark: watermarkOf(old), status: "ready" })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [chapterOutput()],
      document,
      config: quickConfig(),
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gate = gate.promise

    void h.engine.refresh(TEST_SESSION_ID, "manual")
    await h.waitFor(() => h.modelCalls.length === 1, "the in-flight model call")
    await h.engine.stop()
    gate.resolve()
    await finish(h)

    const unchanged = await storedDocument(h)
    expect(unchanged.watermark?.messageID).toBe(old.id)
    expect(unchanged.chapters).toHaveLength(0)
    expect(unchanged.status).toBe("ready")
    expect(h.modelCalls[0]?.signal?.aborted).toBe(true)
  })

  test("a deleted session is not resurrected by an in-flight refresh", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [chapterOutput()],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gate = gate.promise

    void h.engine.refresh(TEST_SESSION_ID, "manual")
    await h.waitFor(() => h.modelCalls.length === 1, "the in-flight model call")
    await h.emitEvent({ type: "session.deleted", data: { sessionID: TEST_SESSION_ID } })
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()

    gate.resolve()
    await finish(h)

    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    expect(h.storage.writes).toBe(0)

    const failure = await failureOf(h.engine.refresh(TEST_SESSION_ID, "manual"))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("session_not_found")
    await h.engine.stop()
  })
})

describe("TimelineEngine model output handling", () => {
  test("a model failure sets error, keeps the watermark, records the call, and retries cleanly", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [chapterOutput()],
      modelError: new ModelFailure("provider unavailable", "transient", true),
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const failed = await storedDocument(h)
    expect(failed.status).toBe("error")
    expect(failed.watermark?.messageID).toBe(old.id)
    expect(failed.meta.callCount).toBe(1)
    expect(failed.meta.lastError?.kind).toBe("model")
    expect(failed.chapters).toHaveLength(0)

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const retried = await storedDocument(h)
    expect(retried.status).toBe("ready")
    expect(retried.watermark?.messageID).toBe(reply.id)
    expect(retried.meta.callCount).toBe(2)
    expect(retried.meta.lastError).toBeUndefined()
    expect(retried.chapters).toHaveLength(1)
    expect(h.modelCalls).toHaveLength(2)
    await h.engine.stop()
  })

  test("an invalid first response is repaired and advances the watermark", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: ["not json", NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const document = await storedDocument(h)
    expect(h.modelCalls).toHaveLength(2)
    expect(document.status).toBe("ready")
    expect(document.watermark?.messageID).toBe(reply.id)
    expect(document.meta.callCount).toBe(2)
    expect(document.meta.lastError).toBeUndefined()
    await h.engine.stop()
  })

  test("an invalid repair keeps the watermark and records both calls", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: ["not json", "still not json"],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const document = await storedDocument(h)
    expect(h.modelCalls).toHaveLength(2)
    expect(document.status).toBe("error")
    expect(document.watermark?.messageID).toBe(old.id)
    expect(document.meta.callCount).toBe(2)
    expect(document.meta.lastError?.kind).toBe("invalid-output")
    expect(document.chapters).toHaveLength(0)
    await h.engine.stop()
  })

  test("history changes mark the document stale and manual refresh rejects", async () => {
    const only = user(BASE_TIME)
    const document = makeDocument({
      watermark: {
        messageID: "ghost",
        createdAt: new Date(BASE_TIME + 10_000).toISOString(),
        messageCount: 1,
      },
    })
    const h = createTestEngine({
      messages: [only],
      document,
      config: quickConfig(),
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    const changed = await storedDocument(h)
    expect(changed.status).toBe("stale")
    expect(changed.meta.notice?.kind).toBe("history-changed")
    expect(changed.watermark?.messageID).toBe("ghost")

    const failure = await failureOf(h.engine.refresh(TEST_SESSION_ID, "manual"))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("invalid_request")
    expect(h.modelCalls).toHaveLength(0)
    await h.engine.stop()
  })

  test("a compacted transcript keeps the document without a history-changed notice", async () => {
    const start = compaction(BASE_TIME)
    const document = makeDocument({
      watermark: {
        messageID: "ghost",
        createdAt: new Date(BASE_TIME + 10_000).toISOString(),
        messageCount: 1,
      },
      status: "ready",
    })
    const h = createTestEngine({
      messages: [start],
      document,
      config: quickConfig(),
    })
    await h.engine.start()

    await h.emitIdle()
    await h.clock.advance(1_000)
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    const kept = await storedDocument(h)
    expect(kept.status).toBe("ready")
    expect(kept.meta.notice).toBeUndefined()
    expect(kept.watermark?.messageID).toBe("ghost")
    await h.engine.stop()
  })

  test("a valid no-op advances the watermark", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const document = await storedDocument(h)
    expect(h.modelCalls).toHaveLength(1)
    expect(document.status).toBe("ready")
    expect(document.watermark?.messageID).toBe(reply.id)
    expect(document.chapters).toHaveLength(0)
    expect(document.meta.callCount).toBe(1)
    expect(document.meta.estimatedInputChars).toBeGreaterThan(0)
    await h.engine.stop()
  })

  test("an ignored-only chunk advances the watermark without a model call", async () => {
    const old = user(BASE_TIME - 120_000)
    const firstIdle = idleMessage(BASE_TIME)
    const secondIdle = idleMessage(BASE_TIME + 1_000)
    const h = createTestEngine({
      messages: [old, firstIdle, secondIdle],
      document: makeDocument({ watermark: watermarkOf(old) }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const document = await storedDocument(h)
    expect(h.modelCalls).toHaveLength(0)
    expect(document.status).toBe("ready")
    expect(document.watermark?.messageID).toBe(secondIdle.id)
    expect(document.chapters).toHaveLength(0)
    await h.engine.stop()
  })

  test("an ignored-only chunk clears an old notice and error", async () => {
    const old = user(BASE_TIME - 120_000)
    const ignored = idleMessage(BASE_TIME)
    const document = makeDocument({
      watermark: watermarkOf(old),
      now: "2026-10-29T09:00:00.000Z",
    })
    document.meta.notice = {
      kind: "hourly-cap",
      message: "Automatic updates paused for this session. Press r to refresh now.",
      at: "2026-10-29T09:00:00.000Z",
    }
    document.meta.lastError = {
      message: "provider unavailable",
      at: "2026-10-29T09:00:00.000Z",
      retryable: true,
      kind: "model",
    }
    const h = createTestEngine({
      messages: [old, ignored],
      document,
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "open")
    await finish(h)

    const updated = await storedDocument(h)
    expect(h.modelCalls).toHaveLength(0)
    expect(updated.status).toBe("ready")
    expect(updated.meta.notice).toBeUndefined()
    expect(updated.meta.lastError).toBeUndefined()
    expect(updated.meta.lastCheckedAt).toBe(new Date(h.clock.now()).toISOString())
    await h.engine.stop()
  })

  test("a trailing running shell is deferred until it exits", async () => {
    const old = user(BASE_TIME - 120_000)
    const running = shell(BASE_TIME)
    const h = createTestEngine({
      messages: [old, running],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old), status: "ready" }),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    expect(h.modelCalls).toHaveLength(0)
    expect((await storedDocument(h)).watermark?.messageID).toBe(old.id)

    running.status = "exited"
    running.exit = 0
    running.time.completed = BASE_TIME + 5_000
    running.output = { output: "12 tests passed", cursor: 0, size: 15, truncated: false }
    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    expect(h.modelCalls[0]?.prompt).toContain("12 tests passed")
    expect((await storedDocument(h)).watermark?.messageID).toBe(running.id)
    await h.engine.stop()
  })

  test("storage failures leave the durable watermark unchanged", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old), status: "ready" }),
      config: quickConfig(),
    })
    await h.engine.start()
    h.storage.failNextSet = true

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const document = await storedDocument(h)
    expect(h.modelCalls).toHaveLength(1)
    expect(document.watermark?.messageID).toBe(old.id)
    expect(document.status).toBe("error")
    expect(document.meta.lastError?.kind).toBe("storage")

    // The background error event reloads through `ensure`. It must not start
    // another automatic model call against the failed store.
    const ensured = await h.engine.ensure(TEST_SESSION_ID)
    expect(ensured.error?.kind).toBe("storage")
    expect(h.modelCalls).toHaveLength(1)
    expect((await h.engine.get(TEST_SESSION_ID)).error?.kind).toBe("storage")
    await h.engine.stop()
  })

  test("automatic refreshes back off for a minute after a storage failure", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [NOOP_OUTPUT, NOOP_OUTPUT],
      document: makeDocument({ watermark: watermarkOf(old), status: "ready" }),
      config: quickConfig(),
    })
    await h.engine.start()
    h.storage.failSet = true

    expect(await h.engine.refresh(TEST_SESSION_ID, "open")).toEqual({ started: true, coalesced: false })
    await finish(h)
    expect(h.modelCalls).toHaveLength(1)

    expect(await h.engine.refresh(TEST_SESSION_ID, "open")).toEqual({ started: false, coalesced: false })
    expect(h.modelCalls).toHaveLength(1)

    h.storage.failSet = false
    await h.clock.advance(60_000)
    expect(await h.engine.refresh(TEST_SESSION_ID, "open")).toEqual({ started: true, coalesced: false })
    await finish(h)

    expect(h.modelCalls).toHaveLength(2)
    expect((await storedDocument(h)).status).toBe("ready")
    await h.engine.stop()
  })

  test("a persistent storage failure blocks the open-refresh retry loop and recovers on manual retry", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const h = createTestEngine({
      messages: [old, fresh, reply],
      outputs: [NOOP_OUTPUT, NOOP_OUTPUT],
      document: makeDocument({
        watermark: watermarkOf(old),
        status: "ready",
        now: "2026-10-29T09:00:00.000Z",
      }),
      config: quickConfig(),
    })
    await h.engine.start()
    h.storage.failSet = true

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    const durable = await storedDocument(h)
    expect(durable.status).toBe("ready")
    expect(durable.watermark?.messageID).toBe(old.id)

    const ensured = await h.engine.ensure(TEST_SESSION_ID)
    expect(ensured.error?.kind).toBe("storage")
    expect(ensured.busy).toBe(false)
    expect(h.modelCalls).toHaveLength(1)

    h.storage.failSet = false
    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    expect(h.modelCalls).toHaveLength(2)
    expect((await h.engine.get(TEST_SESSION_ID)).error).toBeUndefined()
    const recovered = await storedDocument(h)
    expect(recovered.status).toBe("ready")
    expect(recovered.watermark?.messageID).toBe(reply.id)
    await h.engine.stop()
  })
})

describe("TimelineEngine availability", () => {
  test("start disables the engine when configuration has no model", async () => {
    const h = createTestEngine({ config: { model: null } })
    await h.engine.start()

    const result = await h.engine.get(TEST_SESSION_ID)
    expect(result.disabledReason).toContain("explicit `model`")

    const failure = await failureOf(h.engine.refresh(TEST_SESSION_ID, "manual"))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("disabled")
    await h.engine.stop()
  })

  test("ensure before start reports a missing model without persisting", async () => {
    const h = createTestEngine({ config: { model: null }, messages: [user(BASE_TIME)] })

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.disabledReason).toContain("explicit `model`")
    expect(result.document).toBeNull()
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    expect(h.storage.writes).toBe(0)
    await h.engine.stop()
  })

  test("start disables the engine when recap is turned off", async () => {
    const h = createTestEngine({ config: { enabled: false } })
    await h.engine.start()

    const result = await h.engine.get(TEST_SESSION_ID)
    expect(result.disabledReason).toBe("Recap is disabled.")
    await h.engine.stop()
  })

  test("start disables the engine when the configured model is unavailable", async () => {
    const h = createTestEngine({ modelList: { data: [] } })
    await h.engine.start()

    const result = await h.engine.get(TEST_SESSION_ID)
    expect(result.disabledReason).toContain("is not available")

    const failure = await failureOf(h.engine.refresh(TEST_SESSION_ID, "manual"))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("disabled")
    await h.engine.stop()
  })

  test("an auth failure disables the engine with a sanitized reason", async () => {
    const old = user(BASE_TIME - 120_000)
    const fresh = user(BASE_TIME)
    const reply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
    const h = createTestEngine({
      messages: [old, fresh, reply],
      document: makeDocument({ watermark: watermarkOf(old) }),
      modelError: new ModelFailure(`Invalid API key: ${secret}`, "auth", false),
      config: quickConfig(),
    })
    await h.engine.start()

    await h.engine.refresh(TEST_SESSION_ID, "manual")
    await finish(h)

    const result = await h.engine.get(TEST_SESSION_ID)
    expect(result.disabledReason).toBeDefined()
    expect(result.disabledReason).not.toContain(secret)
    expect(result.disabledReason).toContain("[REDACTED]")
    await h.engine.stop()
  })

  test("a disabled engine does not rewrite an interrupted backfill", async () => {
    const document = makeDocument({ status: "backfilling" })
    document.backfill = {
      processedMessages: 1,
      totalMessages: 2,
      startedAt: "2026-10-29T09:00:00.000Z",
    }
    const h = createTestEngine({
      config: { model: null },
      document,
      messages: [user(BASE_TIME)],
    })

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.document?.status).toBe("backfilling")
    expect(h.storage.document(TEST_SESSION_ID)?.status).toBe("backfilling")
    expect(h.storage.writes).toBe(0)
    await h.engine.stop()
  })
})
