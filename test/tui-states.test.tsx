/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createDocument } from "../src/shared/document"
import type { TimelineChapter, TimelineDocument, TimelineError, TimelineHighlight } from "../src/shared/types"
import { TimelinePanel } from "../src/tui/panel"
import { TEST_MODEL } from "./helpers/engine"
import { fakeTui, panelInput, type FakeRpc, type FakeTuiOptions } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"
const ESTIMATE = { messages: 12, chars: 12_000, chunks: 12, approxCalls: 12 }

function baseDocument(): TimelineDocument {
  return createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 1,
    now: NOW,
  })
}

function highlight(id: string, text: string): TimelineHighlight {
  return { id, kind: "implementation", text, at: NOW, anchorMessageID: `msg_${id}` }
}

function chapter(id: string, title: string, summary: string, highlights: TimelineHighlight[]): TimelineChapter {
  return { id, title, summary, startedAt: NOW, endedAt: NOW, highlights, createdAt: NOW, updatedAt: NOW }
}

function readyDocument(): TimelineDocument {
  const document = baseDocument()
  document.goal = "Ship the recap plugin"
  document.status = "ready"
  document.watermark = { messageID: "msg_last", createdAt: NOW, messageCount: 4 }
  document.chapters = [
    chapter("c1", "First chapter", "The first summary.", [highlight("h1", "First highlight")]),
    chapter("c2", "Newest chapter", "The newest summary.", [highlight("h2", "Newest highlight")]),
  ]
  return document
}

function errorOf(message: string): TimelineError {
  return { message, at: NOW, retryable: true, kind: "model" }
}

async function mount(
  rpc: Partial<FakeRpc> = {},
  options: FakeTuiOptions = {},
  size: { width: number; height: number } = { width: 100, height: 30 },
) {
  const fake = fakeTui(rpc, options)
  const app = await testRender(() => <TimelinePanel context={fake.context} panel={panelInput()} />, size)
  return { fake, app }
}

function command(fake: ReturnType<typeof fakeTui>, bind: string) {
  const found = fake
    .keymapCommands()
    .find((entry) => typeof entry.bind === "string" && entry.bind.split(",").includes(bind))
  if (!found) throw new Error(`missing key binding: ${bind}`)
  return found
}

async function press(fake: ReturnType<typeof fakeTui>, bind: string): Promise<void> {
  await command(fake, bind).run()
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

function methods(fake: ReturnType<typeof fakeTui>): string[] {
  return fake.calls.map((call) => call.method)
}

describe("TimelinePanel states", () => {
  test("an empty session shows No messages yet and does not build", async () => {
    const document = baseDocument()
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      await app.waitForFrame((frame) => frame.includes("No messages yet."))
      await press(fake, "b")
      await drain()

      expect(methods(fake)).toEqual(["ensure"])
      expect(fake.uiCalls.toasts).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  test("a document with history shows the estimate and b starts a backfill", async () => {
    const document = baseDocument()
    document.watermark = null
    const { fake, app } = await mount({
      ensure: async () => ({ document, busy: false, needsBackfill: true, estimate: ESTIMATE }),
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Build recap from this session's history"))
      expect(frame).toContain("~12 model calls over 12 messages")
      expect(frame).toContain("Press b to build the recap.")

      await press(fake, "b")
      await drain()

      expect(fake.calls.find((call) => call.method === "backfill")?.input).toEqual({
        sessionID: "ses_1",
        confirm: false,
      })
    } finally {
      await app.dispose()
    }
  })

  test("a large backfill asks for confirmation and retries with confirm true", async () => {
    const document = baseDocument()
    document.watermark = null
    const { fake, app } = await mount({
      ensure: async () => ({ document, busy: false, needsBackfill: true, estimate: ESTIMATE }),
      backfill: async (input) => {
        const confirm = (input as { confirm?: boolean }).confirm === true
        if (!confirm) throw { type: "confirmation_required", message: "Needs confirmation", data: ESTIMATE }
        return { started: true, estimate: ESTIMATE }
      },
    })
    try {
      await app.waitForFrame((value) => value.includes("Build recap from this session's history"))
      await press(fake, "b")
      await drain()

      expect(fake.uiCalls.confirms).toHaveLength(1)
      const backfills = fake.calls.filter((call) => call.method === "backfill")
      expect(backfills.map((call) => (call.input as { confirm: boolean }).confirm)).toEqual([false, true])
    } finally {
      await app.dispose()
    }
  })

  test("a backfilling document shows progress and x cancels", async () => {
    const document = readyDocument()
    document.status = "backfilling"
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: true }) })
    try {
      await app.waitForFrame((value) => value.includes("Newest chapter"))
      fake.handlers.get("progress")?.[0]?.({
        data: { sessionID: "ses_1", phase: "backfill", processed: 3, total: 10, chapters: 2 },
      })
      const frame = await app.waitForFrame((value) => value.includes("Backfilling 3/10 messages"))
      expect(frame).toContain("█")
      expect(frame).toContain("x to cancel")

      await press(fake, "x")
      await drain()

      expect(methods(fake)).toContain("cancel")
    } finally {
      await app.dispose()
    }
  })

  test("an incremental update keeps the ready status and r coalesces", async () => {
    const document = readyDocument()
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: true }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Newest chapter"))
      expect(frame).toContain("READY")
      expect(frame).not.toContain("BACKFILLING")
      expect(frame).not.toContain("x to cancel")

      await press(fake, "r")
      await drain()

      expect(methods(fake)).toContain("refresh")
    } finally {
      await app.dispose()
    }
  })

  test("a paused backfill shows its progress and b resumes", async () => {
    const document = readyDocument()
    document.status = "paused"
    document.backfill = {
      processedMessages: 5,
      totalMessages: 10,
      startedAt: NOW,
      cancelled: true,
    }
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Backfill paused"))
      expect(frame).toContain("Backfill paused at 5/10 messages")

      await press(fake, "b")
      await drain()

      const backfill = fake.calls.find((call) => call.method === "backfill")
      expect(backfill?.input).toEqual({ sessionID: "ses_1", confirm: false })
      expect(methods(fake)).not.toContain("rebuild")
    } finally {
      await app.dispose()
    }
  })

  test("a ready document renders the header and chapters", async () => {
    const { app } = await mount({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Ship the recap plugin"))
      expect(frame).toContain("Newest chapter")
      expect(frame).toContain("Newest highlight")
      expect(frame).toContain("Recap")
    } finally {
      await app.dispose()
    }
  })

  test("a built document without chapters shows the no-milestones message", async () => {
    const document = readyDocument()
    document.chapters = []
    const { app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("No milestones found yet"))
      expect(frame).toContain("No milestones found yet")
      expect(frame).not.toContain("Build recap from this session's history")
    } finally {
      await app.dispose()
    }
  })

  test("a stale document shows the refresh badge and r refreshes", async () => {
    const document = readyDocument()
    document.status = "stale"
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("New activity"))
      expect(frame).toContain("New activity — r to refresh")

      await press(fake, "r")
      await drain()

      expect(methods(fake)).toContain("refresh")
    } finally {
      await app.dispose()
    }
  })

  test("an hourly-cap notice renders and r refreshes", async () => {
    const document = readyDocument()
    document.status = "stale"
    document.meta.notice = { kind: "hourly-cap", message: "Hourly update limit reached.", at: NOW }
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Hourly update limit reached."))
      expect(frame).toContain("Hourly update limit reached.")

      await press(fake, "r")
      await drain()

      expect(methods(fake)).toContain("refresh")
    } finally {
      await app.dispose()
    }
  })

  test("a history-changed notice blocks refresh and b rebuilds", async () => {
    const document = readyDocument()
    document.status = "stale"
    document.meta.notice = { kind: "history-changed", message: "History changed; rebuild required.", at: NOW }
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("History changed"))
      expect(frame).toContain("History changed; rebuild required.")

      await press(fake, "r")
      await drain()
      expect(fake.uiCalls.toasts).toEqual([{ message: "Rebuild required; press b", variant: "warning" }])
      expect(methods(fake)).not.toContain("refresh")

      await press(fake, "b")
      await drain()
      const rebuild = fake.calls.find((call) => call.method === "rebuild")
      expect(rebuild?.input).toEqual({ sessionID: "ses_1", confirm: false })
      expect(methods(fake)).not.toContain("backfill")
    } finally {
      await app.dispose()
    }
  })

  test("an error document shows its message and r retries", async () => {
    const document = readyDocument()
    document.status = "error"
    document.meta.lastError = errorOf("Model failed")
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Model failed"))
      expect(frame).toContain("b to resume/rebuild")
      expect(frame).toContain("r to retry")

      await press(fake, "r")
      await drain()

      expect(methods(fake)).toContain("refresh")
    } finally {
      await app.dispose()
    }
  })

  test("a transport error keeps a renderable timeline and shows a banner", async () => {
    let calls = 0
    const { fake, app } = await mount({
      ensure: async () => {
        calls += 1
        if (calls > 1) throw new Error("transport exploded")
        return { document: readyDocument(), busy: false }
      },
    })
    try {
      await app.waitForFrame((value) => value.includes("Newest chapter"))
      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_1" } })

      const frame = await app.waitForFrame((value) => value.includes("transport exploded"))
      expect(frame).toContain("Newest chapter")
      expect(frame).toContain("transport exploded")

      await press(fake, "r")
      await drain()
      expect(methods(fake)).toContain("refresh")
    } finally {
      await app.dispose()
    }
  })

  test("a transport error with nothing renderable replaces the body", async () => {
    const { app } = await mount({
      ensure: async () => {
        throw new Error("transport exploded")
      },
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("transport exploded"))
      expect(frame).toContain("r to retry")
      expect(frame).not.toContain("Newest chapter")
    } finally {
      await app.dispose()
    }
  })

  test("an RPC error event refetches ensure and never sets a transport error", async () => {
    const document = readyDocument()
    document.status = "error"
    const { fake, app } = await mount({
      ensure: async () => ({
        document,
        busy: false,
        error: errorOf("Background model failed"),
      }),
    })
    try {
      await app.waitForFrame((value) => value.includes("Background model failed"))
      fake.handlers.get("error")?.[0]?.({ data: { sessionID: "ses_1" } })

      const frame = await app.waitForFrame((value) => value.includes("Background model failed"))
      expect(frame).toContain("Background model failed")
      // The document body (header included) survives: the error came through the
      // envelope, not a failed transport call.
      expect(frame).toContain("Recap")
      expect(frame).toContain("b to resume/rebuild")
      expect(fake.calls.filter((call) => call.method === "ensure").length).toBeGreaterThan(1)
    } finally {
      await app.dispose()
    }
  })

  test("a disabled engine shows the reason and config snippet without other calls", async () => {
    const { fake, app } = await mount({
      ensure: async () => ({ document: null, busy: false, disabledReason: "Recap is disabled." }),
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Recap is disabled."))
      expect(frame).toContain("opencode-nexusnv-recap")
      expect(methods(fake)).toEqual(["ensure"])
    } finally {
      await app.dispose()
    }
  })

  test("a child session renders the root-only message and never calls ensure", async () => {
    const { fake, app } = await mount({}, { session: { parentID: "ses_parent" } })
    try {
      const frame = await app.waitForFrame((value) => value.includes("root sessions"))
      expect(frame).toContain("Recap is available for root sessions.")
      expect(fake.calls).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })
})

describe("TimelinePanel keymap", () => {
  test("j and k move the selection and clamp at the first row", async () => {
    const { fake, app } = await mount({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      await app.waitForFrame((value) => value.includes("Newest highlight"))

      // k moves from the newest chapter to the first chapter.
      await press(fake, "k")
      await press(fake, "enter")
      const expanded = await app.waitForFrame((value) => value.includes("First highlight"))
      expect(expanded).toContain("First highlight")

      // k again must stay on the first row, so enter collapses it.
      await press(fake, "k")
      await press(fake, "enter")
      const collapsed = await app.waitForFrame((value) => !value.includes("First highlight"))
      expect(collapsed).not.toContain("First highlight")
      expect(collapsed).toContain("Newest highlight")
    } finally {
      await app.dispose()
    }
  })

  test("j moves from a chapter onto its highlight and enter opens the excerpt", async () => {
    const { fake, app } = await mount({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      await app.waitForFrame((value) => value.includes("Newest highlight"))

      await press(fake, "k")
      await press(fake, "enter")
      await app.waitForFrame((value) => value.includes("First highlight"))

      await press(fake, "j")
      await press(fake, "enter")

      expect(fake.uiCalls.dialogs).toBe(1)
      expect(fake.uiCalls.dialogSet).toEqual([{ size: "large", centered: true }])
    } finally {
      await app.dispose()
    }
  })

  test("g and shift+g jump to the first and last rows", async () => {
    const { fake, app } = await mount({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      await app.waitForFrame((value) => value.includes("Newest highlight"))

      await press(fake, "g")
      await press(fake, "enter")
      await app.waitForFrame((value) => value.includes("First highlight"))

      await press(fake, "shift+g")
      await press(fake, "enter")
      expect(fake.uiCalls.dialogs).toBe(1)
    } finally {
      await app.dispose()
    }
  })

  test("r during a backfill shows a toast instead of refreshing", async () => {
    const document = readyDocument()
    document.status = "backfilling"
    const { fake, app } = await mount({ ensure: async () => ({ document, busy: true }) })
    try {
      await app.waitForFrame((value) => value.includes("Newest chapter"))
      await press(fake, "r")
      await drain()

      expect(fake.uiCalls.toasts).toEqual([{ message: "Backfill in progress", variant: "info" }])
      expect(methods(fake)).not.toContain("refresh")
    } finally {
      await app.dispose()
    }
  })

  test("b on a completed timeline rebuilds instead of backfilling", async () => {
    const { fake, app } = await mount({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      await app.waitForFrame((value) => value.includes("Newest chapter"))
      await press(fake, "b")
      await drain()

      expect(methods(fake)).toContain("rebuild")
      expect(methods(fake)).not.toContain("backfill")
    } finally {
      await app.dispose()
    }
  })
})
