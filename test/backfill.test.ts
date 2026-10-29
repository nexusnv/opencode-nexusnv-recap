import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { TimelineFailure } from "../src/server/errors"
import { ModelFailure } from "../src/server/model"
import type { TimelineBackfill, TimelineChapter, TimelineDocument, TimelineWatermark } from "../src/shared/types"
import {
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
