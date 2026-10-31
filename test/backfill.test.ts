import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { TimelineFailure } from "../src/server/errors"
import { ModelFailure } from "../src/server/model"
import type { TimelineBackfill, TimelineChapter, TimelineDocument, TimelineWatermark } from "../src/shared/types"
import {
  NOOP_OUTPUT,
  TEST_MODEL,
  TEST_SESSION_ID,
  createTestEngine,
  makeDocument,
  type RecordedEngineEvent,
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

function longUser(created: number, label: string): UserMessage {
  return user(created, `${label} ${"x".repeat(200)}`)
}

function oversizedUser(created: number, label: string): UserMessage {
  return user(created, `${label} ${"x".repeat(2_500)}`)
}

function watermarkOf(message: SessionMessageInfo, messageCount = 1): TimelineWatermark {
  return {
    messageID: message.id,
    createdAt: new Date(message.time.created).toISOString(),
    messageCount,
  }
}

function ghostWatermark(createdAt: number): TimelineWatermark {
  return {
    messageID: "ghost",
    createdAt: new Date(createdAt).toISOString(),
    messageCount: 1,
  }
}

function incompleteBackfill(processedMessages: number, totalMessages: number): TimelineBackfill {
  return {
    processedMessages,
    totalMessages,
    startedAt: "2026-10-29T09:00:00.000Z",
  }
}

function makeChapter(title = "Existing chapter"): TimelineChapter {
  const at = new Date(BASE_TIME - 60_000).toISOString()
  return {
    id: `ch_${nextID("chapter")}`,
    title,
    summary: "Existing work",
    startedAt: at,
    endedAt: at,
    highlights: [
      {
        id: `hl_${nextID("highlight")}`,
        kind: "implementation",
        text: "Existing work",
        at,
        anchorMessageID: "user_old",
      },
    ],
    createdAt: at,
    updatedAt: at,
  }
}

function chapterOutput(anchor = "m1", text = "Implemented a chunk"): string {
  return JSON.stringify({
    goal: "Ship the timeline",
    tasks: null,
    chapters: [
      {
        mode: "new",
        title: text,
        summary: text,
        highlights: [{ kind: "implementation", text, anchor }],
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

async function storedDocument(h: TestEngineHarness): Promise<TimelineDocument> {
  const document = h.storage.document(TEST_SESSION_ID)
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

type ProgressEvent = Extract<RecordedEngineEvent, { type: "progress" }>

function progressEvents(h: TestEngineHarness): ProgressEvent[] {
  return h.events.filter((event): event is ProgressEvent => event.type === "progress")
}

describe("TimelineEngine backfill", () => {
  test("backfills every chunk, appends chapters, and advances the watermark after each chunk", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const third = longUser(BASE_TIME + 2_000, "gamma")
    const h = createTestEngine({
      messages: [first, second, third],
      outputs: [
        chapterOutput("m1", "First chunk"),
        chapterOutput("m1", "Second chunk"),
        chapterOutput("m1", "Third chunk"),
      ],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gates = [deferred(), deferred(), deferred()]
    h.modelState.gates = gates.map((gate) => gate.promise)

    const started = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(started.started).toBe(true)
    expect(started.estimate.approxCalls).toBe(3)

    await h.waitFor(() => h.modelCalls.length === 1, "the first chunk call")
    gates[0]?.resolve()
    await h.waitFor(() => progressEvents(h).length === 1, "the first progress event")
    expect((await storedDocument(h)).watermark?.messageID).toBe(first.id)

    gates[1]?.resolve()
    await h.waitFor(() => progressEvents(h).length === 2, "the second progress event")
    expect((await storedDocument(h)).watermark?.messageID).toBe(second.id)

    gates[2]?.resolve()
    await h.waitFor(() => progressEvents(h).length === 3, "the third progress event")
    await finish(h)

    expect(h.modelCalls).toHaveLength(3)
    const document = await storedDocument(h)
    expect(document.status).toBe("ready")
    expect(document.chapters).toHaveLength(3)
    expect(document.watermark?.messageID).toBe(third.id)
    expect(document.backfill?.completedAt).toBeDefined()
    const progress = progressEvents(h)
    expect(progress.map((event) => event.data.processed)).toEqual([1, 2, 3])
    expect(progress.map((event) => event.data.total)).toEqual([3, 3, 3])
    expect(progress.map((event) => event.data.chapters)).toEqual([1, 2, 3])
    expect(progress.every((event) => event.data.phase === "backfill")).toBe(true)
    await h.engine.stop()
  })

  test("a chunk failure keeps earlier chunks and resumes from the watermark", async () => {
    const first = oversizedUser(BASE_TIME, "alpha")
    const second = oversizedUser(BASE_TIME + 1_000, "beta")
    const third = oversizedUser(BASE_TIME + 2_000, "gamma")
    const h = createTestEngine({
      messages: [first, second, third],
      outputs: [
        chapterOutput("m1", "First chunk"),
        chapterOutput("m1", "Second chunk"),
        chapterOutput("m1", "Third chunk"),
      ],
      config: { digest: { maxChars: 2_000 } },
    })
    await h.engine.start()
    h.modelState.errors = [undefined, new ModelFailure("provider unavailable", "transient", true)]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await finish(h)

    const failed = await storedDocument(h)
    expect(failed.status).toBe("error")
    expect(failed.watermark?.messageID).toBe(first.id)
    expect(failed.chapters).toHaveLength(1)
    expect(failed.backfill?.error).toContain("provider unavailable")
    expect(failed.backfill?.completedAt).toBeUndefined()
    expect(h.modelCalls).toHaveLength(2)

    const resumed = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(resumed.started).toBe(true)
    expect(resumed.estimate.messages).toBe(2)
    await finish(h)

    const done = await storedDocument(h)
    expect(done.status).toBe("ready")
    expect(done.watermark?.messageID).toBe(third.id)
    expect(done.chapters).toHaveLength(3)
    expect(done.backfill?.completedAt).toBeDefined()
    expect(done.backfill?.error).toBeUndefined()
    expect(h.modelCalls).toHaveLength(4)
    expect(h.modelCalls[2]?.prompt).toContain("beta")
    expect(h.modelCalls[2]?.prompt).not.toContain("alpha")
    await h.engine.stop()
  })

  test("cancel after a chunk pauses the backfill and resume continues from the watermark", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const third = longUser(BASE_TIME + 2_000, "gamma")
    const h = createTestEngine({
      messages: [first, second, third],
      outputs: [
        chapterOutput("m1", "First chunk"),
        chapterOutput("m1", "Cancelled chunk"),
        chapterOutput("m1", "Second chunk"),
        chapterOutput("m1", "Third chunk"),
      ],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const firstGate = deferred()
    const secondGate = deferred()
    h.modelState.gates = [firstGate.promise, secondGate.promise]

    const started = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(started.started).toBe(true)
    await h.waitFor(() => h.modelCalls.length === 1, "the first chunk call")
    firstGate.resolve()
    await h.waitFor(() => progressEvents(h).length === 1, "the first progress event")
    await h.waitFor(() => h.modelCalls.length === 2, "the second chunk call")

    expect(await h.engine.cancel(TEST_SESSION_ID)).toEqual({ cancelled: true })
    secondGate.resolve()
    await finish(h)

    const paused = await storedDocument(h)
    expect(paused.status).toBe("paused")
    expect(paused.backfill?.cancelled).toBe(true)
    expect(paused.backfill?.completedAt).toBeUndefined()
    expect(paused.chapters).toHaveLength(1)
    expect(paused.watermark?.messageID).toBe(first.id)

    expect(await h.engine.refresh(TEST_SESSION_ID, "idle")).toEqual({ started: false, coalesced: false })
    const failure = await failureOf(h.engine.refresh(TEST_SESSION_ID, "manual"))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("invalid_request")
    expect(h.modelCalls).toHaveLength(2)

    const resumed = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(resumed.started).toBe(true)
    expect(resumed.estimate.messages).toBe(2)
    await finish(h)

    const done = await storedDocument(h)
    expect(done.status).toBe("ready")
    expect(done.backfill?.completedAt).toBeDefined()
    expect(done.backfill?.cancelled).toBeUndefined()
    expect(done.watermark?.messageID).toBe(third.id)
    expect(done.chapters).toHaveLength(3)
    expect(h.modelCalls).toHaveLength(4)
    expect(await h.engine.cancel(TEST_SESSION_ID)).toEqual({ cancelled: false })
    await h.engine.stop()
  })

  test("cancel before any chunk leaves an empty document with no chapters", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const h = createTestEngine({
      messages: [first],
      outputs: [chapterOutput()],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 1, "the first chunk call")
    expect(await h.engine.cancel(TEST_SESSION_ID)).toEqual({ cancelled: true })
    gate.resolve()
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("empty")
    expect(document.chapters).toHaveLength(0)
    expect(document.watermark).toBeNull()
    expect(document.backfill?.cancelled).toBe(true)
    expect(document.backfill?.completedAt).toBeUndefined()
    await h.engine.stop()
  })

  test("completion runs exactly one follow-up refresh for messages that arrived during the backfill", async () => {
    const snapshot = user(BASE_TIME, "snapshot")
    const h = createTestEngine({
      messages: [snapshot],
      outputs: [chapterOutput("m1", "Snapshot chunk"), chapterOutput("m1", "Follow-up chunk")],
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 1, "the snapshot call")
    const lateUser = user(BASE_TIME + 1_000, "new request")
    const lateReply = assistant(BASE_TIME + 2_000, { completed: BASE_TIME + 3_000 })
    h.messages.push(lateUser, lateReply)
    gate.resolve()
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("ready")
    expect(document.watermark?.messageID).toBe(lateReply.id)
    expect(document.chapters).toHaveLength(2)
    expect(document.backfill?.completedAt).toBeDefined()
    expect(h.modelCalls).toHaveLength(2)
    const statuses = h.events.filter((event) => event.type === "updated").map((event) => event.data.status)
    expect(statuses).toContain("stale")
    expect(statuses.at(-1)).toBe("ready")
    await h.engine.stop()
  })
})

describe("TimelineEngine rebuild", () => {
  test("requires confirmation and replaces the existing timeline", async () => {
    const old = user(BASE_TIME - 60_000, "old work")
    const fresh = user(BASE_TIME, "new work")
    const document = makeDocument({ watermark: watermarkOf(old), status: "ready" })
    document.chapters.push(makeChapter("Old chapter"))
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [chapterOutput("m1", "Rebuilt chapter")],
      document,
    })
    await h.engine.start()

    const failure = await failureOf(h.engine.rebuild(TEST_SESSION_ID))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("confirmation_required")
    const estimate = (failure as TimelineFailure).data as { approxCalls: number }
    expect(estimate.approxCalls).toBe(1)
    const untouched = await storedDocument(h)
    expect(untouched.chapters.map((chapter) => chapter.title)).toEqual(["Old chapter"])
    expect(untouched.watermark?.messageID).toBe(old.id)
    expect(untouched.status).toBe("ready")

    const rebuilt = await h.engine.rebuild(TEST_SESSION_ID, true)
    expect(rebuilt.started).toBe(true)
    expect(rebuilt.estimate.messages).toBe(2)
    await finish(h)

    const after = await storedDocument(h)
    expect(after.chapters.map((chapter) => chapter.title)).toEqual(["Rebuilt chapter"])
    expect(after.watermark?.messageID).toBe(fresh.id)
    expect(after.status).toBe("ready")
    expect(after.backfill?.completedAt).toBeDefined()
    expect(h.modelCalls).toHaveLength(1)
    await h.engine.stop()
  })
})

describe("TimelineEngine ensure backfill lifecycle", () => {
  test("auto-starts a small backfill and reports it busy", async () => {
    const h = createTestEngine({
      messages: [user(BASE_TIME, "build this")],
      outputs: [chapterOutput("m1", "Auto chunk")],
    })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.needsBackfill).toBe(false)
    expect(result.busy).toBe(true)
    expect(result.document).not.toBeNull()
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("ready")
    expect(document.chapters).toHaveLength(1)
    expect(document.backfill?.completedAt).toBeDefined()
    expect(h.modelCalls).toHaveLength(1)
    await h.engine.stop()
  })

  test("asks for confirmation when the estimate exceeds the threshold", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const third = longUser(BASE_TIME + 2_000, "gamma")
    const h = createTestEngine({
      messages: [first, second, third],
      config: { digest: { maxChars: 100 }, backfill: { confirmOverCalls: 2 } },
    })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.needsBackfill).toBe(true)
    expect(result.busy).toBe(false)
    expect(result.document).toBeNull()
    expect(result.estimate?.messages).toBe(3)
    expect(result.estimate?.approxCalls).toBe(3)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    await h.engine.stop()
  })

  test("reports an incomplete backfill with a remaining estimate and does not resume", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const third = longUser(BASE_TIME + 2_000, "gamma")
    const document = makeDocument({ watermark: watermarkOf(first), status: "paused" })
    document.backfill = incompleteBackfill(1, 3)
    const h = createTestEngine({ messages: [first, second, third], document, config: { digest: { maxChars: 100 } } })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.needsBackfill).toBe(true)
    expect(result.busy).toBe(false)
    expect(result.estimate?.messages).toBe(2)
    expect(result.estimate?.approxCalls).toBe(2)
    expect(h.modelCalls).toHaveLength(0)
    expect((await storedDocument(h)).status).toBe("paused")
    await h.engine.stop()
  })

  test("returns an incremental error document without retrying", async () => {
    const old = user(BASE_TIME - 120_000, "old")
    const fresh = user(BASE_TIME, "fresh")
    const document = makeDocument({
      watermark: watermarkOf(old),
      status: "error",
      now: "2026-10-29T09:00:00.000Z",
    })
    document.meta.lastError = {
      message: "provider unavailable",
      at: "2026-10-29T09:00:00.000Z",
      retryable: true,
      kind: "model",
    }
    const h = createTestEngine({ messages: [old, fresh], document })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.document?.status).toBe("error")
    expect(result.needsBackfill).toBe(false)
    expect(result.busy).toBe(false)
    expect(h.modelCalls).toHaveLength(0)
    await h.drain()
    expect(h.modelCalls).toHaveLength(0)
    await h.engine.stop()
  })

  test("returns a history-changed notice without retrying", async () => {
    const only = user(BASE_TIME, "only")
    const document = makeDocument({
      watermark: ghostWatermark(BASE_TIME + 10_000),
      status: "stale",
      now: "2026-10-29T09:00:00.000Z",
    })
    document.meta.notice = {
      kind: "history-changed",
      message: "The transcript changed. Rebuild the timeline to continue.",
      at: "2026-10-29T09:00:00.000Z",
    }
    const h = createTestEngine({ messages: [only], document })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.document?.meta.notice?.kind).toBe("history-changed")
    expect(result.needsBackfill).toBe(false)
    expect(result.busy).toBe(false)
    expect(h.modelCalls).toHaveLength(0)
    await h.drain()
    expect(h.modelCalls).toHaveLength(0)
    await h.engine.stop()
  })

  test("ensure and backfill create an empty document without a model call", async () => {
    const ensureHarness = createTestEngine({})
    await ensureHarness.engine.start()
    const ensured = await ensureHarness.engine.ensure(TEST_SESSION_ID)
    expect(ensured.document?.status).toBe("empty")
    expect(ensured.document?.watermark).toBeNull()
    expect(ensured.needsBackfill).toBe(false)
    expect(ensureHarness.modelCalls).toHaveLength(0)
    expect(ensureHarness.storage.document(TEST_SESSION_ID)?.status).toBe("empty")
    await ensureHarness.engine.stop()

    const backfillHarness = createTestEngine({})
    await backfillHarness.engine.start()
    const built = await backfillHarness.engine.backfill(TEST_SESSION_ID, true)
    expect(built.started).toBe(false)
    expect(built.estimate.approxCalls).toBe(0)
    expect(backfillHarness.modelCalls).toHaveLength(0)
    const document = backfillHarness.storage.document(TEST_SESSION_ID)
    expect(document?.status).toBe("empty")
    expect(document?.chapters).toHaveLength(0)
    await backfillHarness.engine.stop()
  })

  test("an interrupted backfill is surfaced as paused without auto-resuming", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const third = longUser(BASE_TIME + 2_000, "gamma")
    const document = makeDocument({ watermark: watermarkOf(first), status: "backfilling" })
    document.backfill = incompleteBackfill(1, 3)
    const h = createTestEngine({ messages: [first, second, third], document, config: { digest: { maxChars: 100 } } })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.document?.status).toBe("paused")
    expect(result.needsBackfill).toBe(true)
    expect(result.estimate?.messages).toBe(2)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.storage.document(TEST_SESSION_ID)?.status).toBe("paused")
    await h.engine.stop()
  })
})

describe("TimelineEngine backfill history changes", () => {
  test("backfill calls are manual and do not consume the automatic update cap", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const h = createTestEngine({
      messages: [first, second],
      outputs: [chapterOutput("m1", "First chunk"), chapterOutput("m1", "Second chunk")],
      config: { digest: { maxChars: 100 }, limits: { maxUpdatesPerHour: 1 } },
    })
    await h.engine.start()

    await h.engine.backfill(TEST_SESSION_ID, true)
    await finish(h)

    const document = await storedDocument(h)
    expect(document.meta.callCount).toBe(2)
    expect(document.meta.recentAutoCalls).toHaveLength(0)
    expect(document.status).toBe("ready")
    await h.engine.stop()
  })

  test("a rewritten transcript clears an incomplete backfill and surfaces history-changed", async () => {
    const only = user(BASE_TIME - 60_000, "old history")
    const document = makeDocument({ watermark: ghostWatermark(BASE_TIME), status: "paused" })
    document.backfill = incompleteBackfill(1, 2)
    document.chapters.push(makeChapter("Existing chapter"))
    const h = createTestEngine({ messages: [only], document })
    await h.engine.start()

    const result = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(result.started).toBe(false)
    expect(result.estimate.approxCalls).toBe(0)
    expect(h.modelCalls).toHaveLength(0)

    const changed = await storedDocument(h)
    expect(changed.status).toBe("stale")
    expect(changed.backfill).toBeNull()
    expect(changed.meta.notice?.kind).toBe("history-changed")
    expect(changed.watermark?.messageID).toBe("ghost")
    await h.engine.stop()
  })

  test("a compacted read finalizes a paused backfill without a model call", async () => {
    const start = compaction(BASE_TIME - 60_000)
    const document = makeDocument({ watermark: ghostWatermark(BASE_TIME), status: "paused" })
    document.backfill = incompleteBackfill(1, 2)
    document.chapters.push(makeChapter("Existing chapter"))
    const h = createTestEngine({ messages: [start], document })
    await h.engine.start()

    const result = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(result.started).toBe(false)
    expect(h.modelCalls).toHaveLength(0)

    const finalized = await storedDocument(h)
    expect(finalized.status).toBe("ready")
    expect(finalized.coverage.partial).toBe(true)
    expect(finalized.coverage.reason).toBe("compacted-history")
    expect(finalized.meta.notice).toBeUndefined()
    expect(finalized.backfill?.completedAt).toBeDefined()
    expect(finalized.backfill?.processedMessages).toBe(2)
    await h.engine.stop()
  })

  test("a rewrite detected after the final chunk marks the document stale", async () => {
    const original = user(BASE_TIME, "original")
    const h = createTestEngine({
      messages: [original],
      outputs: [chapterOutput("m1", "Only chunk")],
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 1, "the only chunk call")
    h.messages.splice(0, h.messages.length, user(BASE_TIME - 60_000, "rewritten"))
    gate.resolve()
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("stale")
    expect(document.meta.notice?.kind).toBe("history-changed")
    expect(document.backfill?.completedAt).toBeDefined()
    expect(document.watermark?.messageID).toBe(original.id)
    expect(document.chapters).toHaveLength(1)
    expect(h.modelCalls).toHaveLength(1)
    await h.engine.stop()
  })
})

describe("TimelineEngine backfill concurrency and lifecycle hardening", () => {
  test("concurrent ensure calls do not reject with busy", async () => {
    const only = user(BASE_TIME, "build this")
    const h = createTestEngine({
      messages: [only],
      outputs: [chapterOutput("m1", "Concurrent chunk")],
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    const results = await Promise.all([h.engine.ensure(TEST_SESSION_ID), h.engine.ensure(TEST_SESSION_ID)])
    expect(results.some((result) => result.busy)).toBe(true)
    expect(h.modelCalls).toHaveLength(1)

    gate.resolve()
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("ready")
    expect(document.chapters).toHaveLength(1)
    expect(document.watermark?.messageID).toBe(only.id)
    await h.engine.stop()
  })

  test("finalizing an incomplete backfill clears stale flags and emits updated", async () => {
    const only = user(BASE_TIME, "only")
    const document = makeDocument({ watermark: watermarkOf(only), status: "paused" })
    document.backfill = {
      ...incompleteBackfill(1, 1),
      cancelled: true,
      error: "provider unavailable",
    }
    document.meta.lastError = {
      message: "provider unavailable",
      at: "2026-10-29T09:00:00.000Z",
      retryable: true,
      kind: "model",
    }
    const h = createTestEngine({ messages: [only], document })
    await h.engine.start()

    const result = await h.engine.backfill(TEST_SESSION_ID)
    expect(result.started).toBe(false)
    expect(result.estimate.approxCalls).toBe(0)

    const stored = await storedDocument(h)
    expect(stored.status).toBe("empty")
    expect(stored.backfill?.completedAt).toBeDefined()
    expect(stored.backfill?.processedMessages).toBe(1)
    expect(stored.backfill?.cancelled).toBeUndefined()
    expect(stored.backfill?.error).toBeUndefined()
    expect(stored.meta.lastError).toBeUndefined()
    expect(h.events.some((event) => event.type === "updated" && event.data.status === "empty")).toBe(true)
    await h.engine.stop()
  })

  test("a trailing streaming assistant is deferred until it settles", async () => {
    const firstUser = user(BASE_TIME, "first request")
    const firstReply = assistant(BASE_TIME + 1_000, { completed: BASE_TIME + 2_000 })
    const secondUser = user(BASE_TIME + 3_000, "second request")
    const token = "STREAMING_TOKEN_9f3c"
    const streaming = assistant(BASE_TIME + 4_000)
    streaming.content = [{ type: "text", text: `partial ${token}` }]
    const h = createTestEngine({
      messages: [firstUser, firstReply, secondUser, streaming],
      outputs: [chapterOutput("m1", "Snapshot chunk"), chapterOutput("m1", "Settled chunk")],
      config: { update: { minNewMessages: 1 } },
    })
    await h.engine.start()

    await h.engine.backfill(TEST_SESSION_ID, true)
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    expect(h.modelCalls[0]?.prompt).not.toContain(token)
    const firstPass = await storedDocument(h)
    expect(firstPass.watermark?.messageID).toBe(secondUser.id)
    expect(firstPass.status).toBe("ready")

    streaming.time.completed = BASE_TIME + 5_000
    streaming.content = [{ type: "text", text: `final ${token}` }]
    await h.emitIdle()
    await h.clock.advance(h.config.update.debounceMs)
    await finish(h)

    expect(h.modelCalls).toHaveLength(2)
    expect(h.modelCalls[1]?.prompt).toContain(token)
    const settled = await storedDocument(h)
    expect(settled.watermark?.messageID).toBe(streaming.id)
    expect(settled.chapters).toHaveLength(2)
    await h.engine.stop()
  })

  test("a storage failure mid-backfill keeps the last durable chunk and resumes", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const h = createTestEngine({
      messages: [first, second],
      outputs: [
        chapterOutput("m1", "First chunk"),
        chapterOutput("m1", "Second chunk"),
        chapterOutput("m1", "Resumed chunk"),
      ],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [undefined, gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 2, "the second chunk call")
    expect((await storedDocument(h)).watermark?.messageID).toBe(first.id)

    h.storage.failNextSet = true
    gate.resolve()
    await finish(h)

    const failed = await storedDocument(h)
    expect(failed.watermark?.messageID).toBe(first.id)
    expect(failed.status).toBe("backfilling")
    expect(failed.chapters).toHaveLength(1)
    expect(h.events.some((event) => event.type === "error" && event.data.kind === "storage")).toBe(true)
    expect((await h.engine.get(TEST_SESSION_ID)).error?.kind).toBe("storage")

    const resumed = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(resumed.started).toBe(true)
    await finish(h)

    const done = await storedDocument(h)
    expect(done.watermark?.messageID).toBe(second.id)
    expect(done.status).toBe("ready")
    expect(done.chapters).toHaveLength(2)
    expect(done.backfill?.completedAt).toBeDefined()
    await h.engine.stop()
  })

  test("stop during backfill discards the in-flight result", async () => {
    const only = longUser(BASE_TIME, "alpha")
    const h = createTestEngine({
      messages: [only],
      outputs: [chapterOutput()],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 1, "the only chunk call")
    await h.engine.stop()
    gate.resolve()
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("backfilling")
    expect(document.watermark).toBeNull()
    expect(document.chapters).toHaveLength(0)
    expect(h.storage.writes).toBe(1)
  })

  test("session deletion during backfill removes storage and stops writes", async () => {
    const only = longUser(BASE_TIME, "alpha")
    const h = createTestEngine({
      messages: [only],
      outputs: [chapterOutput()],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 1, "the only chunk call")
    const writes = h.storage.writes
    await h.emitEvent({ type: "session.deleted", data: { sessionID: TEST_SESSION_ID } })
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()

    gate.resolve()
    await h.drain()
    await h.waitFor(() => h.modelState.inFlight === 0, "the in-flight model call to finish")
    await h.drain()

    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    expect(h.storage.writes).toBe(writes)
    await h.engine.stop()
  })

  test("an auth failure during backfill is sanitized and recorded on the backfill", async () => {
    const only = longUser(BASE_TIME, "alpha")
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
    const h = createTestEngine({
      messages: [only],
      modelError: new ModelFailure(`Invalid API key: ${secret}`, "auth", false),
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()

    await h.engine.backfill(TEST_SESSION_ID, true)
    await finish(h)

    const document = await storedDocument(h)
    expect(document.status).toBe("error")
    expect(document.backfill?.error).toContain("[REDACTED]")
    expect(document.backfill?.error).not.toContain(secret)
    const result = await h.engine.get(TEST_SESSION_ID)
    expect(result.disabledReason).toBeDefined()
    expect(result.disabledReason).toContain("[REDACTED]")
    expect(result.disabledReason).not.toContain(secret)
    expect(JSON.stringify(h.events)).not.toContain(secret)
    expect(JSON.stringify(h.logs)).not.toContain(secret)
    await h.engine.stop()
  })

  test("a second backfill or rebuild is rejected while a backfill is running", async () => {
    const only = longUser(BASE_TIME, "alpha")
    const h = createTestEngine({
      messages: [only],
      outputs: [chapterOutput("m1", "Only chunk")],
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    await h.engine.backfill(TEST_SESSION_ID, true)
    await h.waitFor(() => h.modelCalls.length === 1, "the only chunk call")

    const backfillFailure = await failureOf(h.engine.backfill(TEST_SESSION_ID, true))
    expect(backfillFailure).toBeInstanceOf(TimelineFailure)
    expect((backfillFailure as TimelineFailure).code).toBe("busy")
    const rebuildFailure = await failureOf(h.engine.rebuild(TEST_SESSION_ID, true))
    expect(rebuildFailure).toBeInstanceOf(TimelineFailure)
    expect((rebuildFailure as TimelineFailure).code).toBe("busy")

    gate.resolve()
    await finish(h)

    expect(h.modelCalls).toHaveLength(1)
    const document = await storedDocument(h)
    expect(document.chapters).toHaveLength(1)
    expect(document.status).toBe("ready")
    await h.engine.stop()
  })

  test("rebuild replaces the document without removing storage", async () => {
    const old = user(BASE_TIME - 60_000, "old work")
    const fresh = user(BASE_TIME, "new work")
    const document = makeDocument({ watermark: watermarkOf(old), status: "ready" })
    document.chapters.push(makeChapter("Old chapter"))
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [chapterOutput("m1", "Rebuilt chapter")],
      document,
    })
    await h.engine.start()

    const writes = h.storage.writes
    const failure = await failureOf(h.engine.rebuild(TEST_SESSION_ID))
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("confirmation_required")
    expect(h.storage.writes).toBe(writes)
    expect(h.storage.removes).toBe(0)
    expect((await storedDocument(h)).chapters.map((chapter) => chapter.title)).toEqual(["Old chapter"])

    const rebuilt = await h.engine.rebuild(TEST_SESSION_ID, true)
    expect(rebuilt.started).toBe(true)
    await finish(h)

    expect(h.storage.removes).toBe(0)
    const after = await storedDocument(h)
    expect(after.chapters.map((chapter) => chapter.title)).toEqual(["Rebuilt chapter"])
    expect(after.watermark?.messageID).toBe(fresh.id)
    expect(after.status).toBe("ready")
    await h.engine.stop()
  })

  test("a confirmed rebuild of an empty session persists an empty document", async () => {
    const document = makeDocument({ status: "ready" })
    document.chapters.push(makeChapter())
    const h = createTestEngine({ messages: [], document })
    await h.engine.start()

    const result = await h.engine.rebuild(TEST_SESSION_ID, true)
    expect(result.started).toBe(false)
    expect(result.estimate.approxCalls).toBe(0)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.storage.removes).toBe(0)

    const stored = await storedDocument(h)
    expect(stored.status).toBe("empty")
    expect(stored.chapters).toHaveLength(0)
    expect(stored.backfill).toBeNull()
    await h.engine.stop()
  })

  test("ensure launches an open refresh and reports busy", async () => {
    const old = user(BASE_TIME - 120_000, "old")
    const fresh = user(BASE_TIME, "fresh")
    const document = makeDocument({
      watermark: watermarkOf(old),
      status: "ready",
      now: "2026-10-29T09:00:00.000Z",
    })
    document.meta.lastCheckedAt = "2026-10-29T09:00:00.000Z"
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [NOOP_OUTPUT],
      document,
    })
    await h.engine.start()

    const result = await h.engine.ensure(TEST_SESSION_ID)
    expect(result.busy).toBe(true)
    expect(result.needsBackfill).toBe(false)
    await finish(h)

    const stored = await storedDocument(h)
    expect(stored.status).toBe("ready")
    expect(stored.watermark?.messageID).toBe(fresh.id)
    expect(h.modelCalls).toHaveLength(1)
    await h.engine.stop()
  })

  test("ensure records a no-op open check so repeated opens do not re-read", async () => {
    const old = user(BASE_TIME - 120_000, "old")
    const document = makeDocument({
      watermark: watermarkOf(old),
      status: "ready",
      now: "2026-10-29T09:00:00.000Z",
    })
    document.meta.lastCheckedAt = "2026-10-29T09:00:00.000Z"
    let reads = 0
    const h = createTestEngine({
      messages: [old],
      document,
      beforeContext: () => {
        reads += 1
      },
    })
    await h.engine.start()

    const first = await h.engine.ensure(TEST_SESSION_ID)
    expect(first.busy).toBe(false)
    expect(reads).toBe(1)
    const checked = await storedDocument(h)
    expect(checked.meta.lastCheckedAt).toBe(new Date(h.clock.now()).toISOString())

    await h.engine.ensure(TEST_SESSION_ID)
    expect(reads).toBe(1)
    await h.engine.stop()
  })

  test("ensure does not overwrite a rebuild that completed while it was reading", async () => {
    const old = user(BASE_TIME - 60_000, "old")
    const fresh = user(BASE_TIME, "new")
    const document = makeDocument({
      watermark: ghostWatermark(BASE_TIME + 10_000),
      status: "ready",
      now: "2026-10-29T09:00:00.000Z",
    })
    document.meta.lastCheckedAt = "2026-10-29T09:00:00.000Z"
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [chapterOutput("m1", "Rebuilt chapter")],
      document,
    })
    await h.engine.start()

    const gate = deferred()
    let gated = false
    h.storage.beforeGet = async () => {
      if (gated) return
      gated = true
      await gate.promise
    }

    const pending = h.engine.ensure(TEST_SESSION_ID)
    await h.waitFor(() => gated, "ensure's first load")
    const rebuilt = await h.engine.rebuild(TEST_SESSION_ID, true)
    expect(rebuilt.started).toBe(true)
    await finish(h)

    gate.resolve()
    const result = await pending

    expect(result.document?.status).toBe("ready")
    expect(result.document?.chapters.map((chapter) => chapter.title)).toEqual(["Rebuilt chapter"])
    expect(result.document?.meta.notice).toBeUndefined()
    const stored = await storedDocument(h)
    expect(stored.status).toBe("ready")
    expect(stored.chapters.map((chapter) => chapter.title)).toEqual(["Rebuilt chapter"])
    expect(stored.meta.notice).toBeUndefined()
    await h.engine.stop()
  })

  test("resumed backfill records the full snapshot length in the watermark", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const second = longUser(BASE_TIME + 1_000, "beta")
    const third = longUser(BASE_TIME + 2_000, "gamma")
    const document = makeDocument({ watermark: watermarkOf(first), status: "paused" })
    document.backfill = incompleteBackfill(1, 3)
    const h = createTestEngine({
      messages: [first, second, third],
      outputs: [chapterOutput("m1", "Second chunk"), chapterOutput("m1", "Third chunk")],
      document,
      config: { digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const gate = deferred()
    h.modelState.gates = [gate.promise]

    const started = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(started.started).toBe(true)
    await h.waitFor(() => h.modelCalls.length === 1, "the first resumed chunk")
    gate.resolve()
    await h.waitFor(() => progressEvents(h).length === 1, "the first resumed progress")

    const afterFirst = await storedDocument(h)
    expect(afterFirst.watermark?.messageID).toBe(second.id)
    expect(afterFirst.watermark?.messageCount).toBe(3)

    await finish(h)
    const done = await storedDocument(h)
    expect(done.watermark?.messageID).toBe(third.id)
    expect(done.watermark?.messageCount).toBe(3)
    expect(done.chapters).toHaveLength(2)
    expect(done.status).toBe("ready")
    await h.engine.stop()
  })

  test("ensure does not auto-resume a backfill cancelled after its read", async () => {
    const only = user(BASE_TIME, "build this")
    const document = makeDocument({ status: "empty", now: "2026-10-29T09:00:00.000Z" })
    const h = createTestEngine({
      messages: [only],
      outputs: [chapterOutput("m1", "Cancelled chunk")],
      document,
    })
    await h.engine.start()
    const releaseGet = deferred()
    const releaseModel = deferred()
    h.modelState.gates = [releaseModel.promise]

    let blocked = false
    h.storage.beforeGet = async () => {
      if (blocked) return
      blocked = true
      await releaseGet.promise
    }

    // `ensure` captures the pre-backfill document, then blocks. The concurrent
    // backfill cancels while ensure is still deciding whether to auto-start.
    const pending = h.engine.ensure(TEST_SESSION_ID)
    await h.waitFor(() => blocked, "ensure's first load")

    const started = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(started.started).toBe(true)
    await h.waitFor(() => h.modelCalls.length === 1, "the backfill call")
    expect((await h.engine.cancel(TEST_SESSION_ID)).cancelled).toBe(true)
    releaseModel.resolve()
    await finish(h)

    const paused = await storedDocument(h)
    expect(paused.status).toBe("empty")
    expect(paused.backfill?.cancelled).toBe(true)

    releaseGet.resolve()
    const result = await pending

    expect(result.needsBackfill).toBe(true)
    expect(result.busy).toBe(false)
    expect(h.modelCalls).toHaveLength(1)
    const stored = await storedDocument(h)
    expect(stored.status).toBe("empty")
    expect(stored.backfill?.cancelled).toBe(true)
    await h.engine.stop()
  })

  test("ensure does not auto-resume a backfill that failed after its read", async () => {
    const only = user(BASE_TIME, "build this")
    const document = makeDocument({ status: "empty", now: "2026-10-29T09:00:00.000Z" })
    const h = createTestEngine({
      messages: [only],
      outputs: [chapterOutput("m1", "Failed chunk")],
      modelError: new ModelFailure("provider unavailable", "transient", true),
      document,
    })
    await h.engine.start()
    const releaseGet = deferred()

    let blocked = false
    h.storage.beforeGet = async () => {
      if (blocked) return
      blocked = true
      await releaseGet.promise
    }

    const pending = h.engine.ensure(TEST_SESSION_ID)
    await h.waitFor(() => blocked, "ensure's first load")

    const started = await h.engine.backfill(TEST_SESSION_ID, true)
    expect(started.started).toBe(true)
    await finish(h)

    const failed = await storedDocument(h)
    expect(failed.status).toBe("error")
    expect(failed.backfill?.completedAt).toBeUndefined()
    expect(failed.backfill?.error).toContain("provider unavailable")

    releaseGet.resolve()
    const result = await pending

    expect(result.needsBackfill).toBe(true)
    expect(result.busy).toBe(false)
    expect(h.modelCalls).toHaveLength(1)
    const stored = await storedDocument(h)
    expect(stored.status).toBe("error")
    expect(stored.backfill?.completedAt).toBeUndefined()
    expect(stored.meta.lastError?.kind).toBe("model")
    await h.engine.stop()
  })

  test("ensure does not auto-start a backfill that grew past the confirmation threshold", async () => {
    const first = longUser(BASE_TIME, "alpha")
    const h = createTestEngine({
      messages: [first],
      outputs: [chapterOutput("m1", "Too big")],
      config: { backfill: { confirmOverCalls: 1 }, digest: { maxChars: 100 } },
    })
    await h.engine.start()
    const release = deferred()
    let gets = 0
    h.storage.beforeGet = async () => {
      gets += 1
      if (gets === 2) await release.promise
    }

    // `ensure` estimates one chunk from its first read, then the locked
    // auto-start re-read sees two more messages.
    const pending = h.engine.ensure(TEST_SESSION_ID)
    await h.waitFor(() => gets === 2, "the auto-start load")
    h.messages.push(longUser(BASE_TIME + 1_000, "beta"), longUser(BASE_TIME + 2_000, "gamma"))
    release.resolve()
    const result = await pending

    expect(result.needsBackfill).toBe(true)
    expect(result.busy).toBe(false)
    expect(result.estimate?.approxCalls).toBe(3)
    expect(h.modelCalls).toHaveLength(0)
    expect(h.storage.document(TEST_SESSION_ID)).toBeUndefined()
    await h.engine.stop()
  })

  test("a coalesced refresh survives a prepared task that fails during prepare", async () => {
    const old = user(BASE_TIME - 60_000, "old")
    const fresh = user(BASE_TIME, "new")
    const document = makeDocument({ watermark: watermarkOf(old), status: "ready" })
    const releaseRead = deferred()
    const releaseModel = deferred()
    let blocked = false
    const h = createTestEngine({
      messages: [old, fresh],
      outputs: [chapterOutput("m1", "Refreshed chapter")],
      document,
      config: { update: { minNewMessages: 1 } },
      beforeContext: async () => {
        if (blocked) return
        blocked = true
        await releaseRead.promise
      },
    })
    await h.engine.start()
    h.modelState.gates = [releaseModel.promise]

    const rebuild = h.engine.rebuild(TEST_SESSION_ID)
    await h.waitFor(() => blocked, "the rebuild prepare read")
    const refresh = h.engine.refresh(TEST_SESSION_ID, "manual")
    await h.drain()
    releaseRead.resolve()

    const failure = await failureOf(rebuild)
    expect(failure).toBeInstanceOf(TimelineFailure)
    expect((failure as TimelineFailure).code).toBe("confirmation_required")
    expect(await refresh).toEqual({ started: false, coalesced: true })

    // The coalesced refresh is running, not a backfill. `ensure` and `cancel`
    // must not report a backfill in flight during the drain.
    await h.waitFor(() => h.modelCalls.length === 1, "the drained refresh")
    const mid = await h.engine.ensure(TEST_SESSION_ID)
    expect(mid.busy).toBe(false)
    expect((await h.engine.cancel(TEST_SESSION_ID)).cancelled).toBe(false)

    releaseModel.resolve()
    await finish(h)
    const stored = await storedDocument(h)
    expect(stored.watermark?.messageID).toBe(fresh.id)
    expect(stored.chapters.map((chapter) => chapter.title)).toEqual(["Refreshed chapter"])
    expect(h.modelCalls).toHaveLength(1)
    await h.engine.stop()
  })

  test("a refresh coalesced while a rebuild prepares still runs", async () => {
    const old = user(BASE_TIME - 60_000, "old")
    const document = makeDocument({ watermark: watermarkOf(old), status: "ready" })
    const releaseRead = deferred()
    let reads = 0
    let blocked = false
    const h = createTestEngine({
      messages: [old],
      outputs: [chapterOutput("m1", "Rebuilt chapter")],
      document,
      config: { update: { minNewMessages: 1 } },
      beforeContext: async () => {
        reads += 1
        if (blocked) return
        blocked = true
        await releaseRead.promise
      },
    })
    await h.engine.start()

    const rebuild = h.engine.rebuild(TEST_SESSION_ID, true)
    await h.waitFor(() => blocked, "the rebuild prepare read")
    const refresh = h.engine.refresh(TEST_SESSION_ID, "manual")
    await h.drain()
    releaseRead.resolve()

    const rebuilt = await rebuild
    expect(rebuilt.started).toBe(true)
    expect(await refresh).toEqual({ started: false, coalesced: true })

    await finish(h)
    // Prepare read, post-completion tail read, and the coalesced refresh read.
    expect(reads).toBe(3)
    const stored = await storedDocument(h)
    expect(stored.chapters.map((chapter) => chapter.title)).toEqual(["Rebuilt chapter"])
    expect(h.modelCalls).toHaveLength(1)
    await h.engine.stop()
  })
})
