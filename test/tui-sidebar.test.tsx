/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createDocument } from "../src/shared/document"
import type { TimelineChapter, TimelineDocument, TimelineHighlight } from "../src/shared/types"
import { RecapSidebar } from "../src/tui/sidebar"
import { TEST_MODEL } from "./helpers/engine"
import { fakeTui, type FakeRpc, type FakeTuiOptions } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"

function highlight(id: string, text: string, kind: TimelineHighlight["kind"] = "implementation"): TimelineHighlight {
  return { id, kind, text, at: NOW, anchorMessageID: `msg_${id}` }
}

function chapter(id: string, title: string, highlights: TimelineHighlight[]): TimelineChapter {
  return {
    id,
    title,
    summary: `Summary ${id}`,
    startedAt: NOW,
    endedAt: NOW,
    highlights,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function readyDocument(): TimelineDocument {
  const document = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 2,
    now: NOW,
  })
  document.status = "ready"
  document.watermark = { messageID: "msg_last", createdAt: NOW, messageCount: 4 }
  document.chapters = [
    chapter("c1", "First chapter", [highlight("h1", "First highlight")]),
    chapter("c2", "Newest chapter", [highlight("h2", "Built the sidebar"), highlight("p1", "Next: add tests", "plan")]),
  ]
  return document
}

async function mount(
  rpc: Partial<FakeRpc> = {},
  options: FakeTuiOptions = {},
  size: { width: number; height: number } = { width: 60, height: 10 },
) {
  const fake = fakeTui(rpc, options)
  const app = await testRender(() => <RecapSidebar context={fake.context} sessionID="ses_1" />, size)
  return { fake, app }
}

describe("RecapSidebar", () => {
  test("loads with get and renders the header, ticker, now, and next", async () => {
    const { fake, app } = await mount({ get: async () => ({ document: readyDocument(), busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Recap"))

      expect(frame).toContain("Recap")
      expect(frame).toContain("1/2")
      expect(frame).toContain("First chapter · ")
      expect(frame).toContain("Now")
      expect(frame).toContain("Newest chapter")
      expect(frame).toContain("Built the sidebar")
      expect(frame).toContain("Next")
      expect(frame).toContain("add tests")
      expect(frame).not.toContain("Next: add tests")
      expect(fake.calls.map((call) => call.method)).toEqual(["get"])
    } finally {
      await app.dispose()
    }
  })

  test("shows the ready position without a status word", async () => {
    const { app } = await mount({ get: async () => ({ document: readyDocument(), busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("1/2"))
      expect(frame).not.toContain("ready")
      expect(frame).not.toContain("updating")
    } finally {
      await app.dispose()
    }
  })

  test("a backfill replaces Next with live progress", async () => {
    const document = readyDocument()
    document.status = "backfilling"
    const { fake, app } = await mount({ get: async () => ({ document, busy: true }) })
    try {
      await app.waitForFrame((value) => value.includes("Now"))
      fake.handlers.get("progress")?.[0]?.({
        data: { sessionID: "ses_1", phase: "backfill", processed: 3, total: 10, chapters: 2 },
      })

      const frame = await app.waitForFrame((value) => value.includes("Building 3/10"))
      expect(frame).toContain("building")
      expect(frame).not.toContain("add tests")
    } finally {
      await app.dispose()
    }
  })

  test("a paused backfill replaces Next with the resume hint", async () => {
    const document = readyDocument()
    document.status = "paused"
    document.backfill = { processedMessages: 5, totalMessages: 10, startedAt: NOW, cancelled: true }
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Paused"))
      expect(frame).toContain("Paused at 5/10")
      expect(frame).toContain("/recap to resume")
      expect(frame).not.toContain("add tests")
    } finally {
      await app.dispose()
    }
  })

  test("an error replaces Next with its message", async () => {
    const document = readyDocument()
    document.status = "error"
    document.meta.lastError = { message: "Model failed", at: NOW, retryable: true, kind: "model" }
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Model failed"))
      expect(frame).toContain("Model failed")
      expect(frame).not.toContain("add tests")
    } finally {
      await app.dispose()
    }
  })

  test("a notice replaces Next with its message", async () => {
    const document = readyDocument()
    document.status = "stale"
    document.meta.notice = { kind: "hourly-cap", message: "Hourly update limit reached.", at: NOW }
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Hourly update limit reached."))
      expect(frame).toContain("Hourly update limit reached.")
      expect(frame).not.toContain("add tests")
    } finally {
      await app.dispose()
    }
  })

  test("marks partial coverage in the header without hiding Next", async () => {
    const document = readyDocument()
    document.coverage = { partial: true, reason: "compacted-history" }
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("partial"))
      expect(frame).toContain("partial")
      expect(frame).toContain("add tests")
    } finally {
      await app.dispose()
    }
  })

  test("a stale document keeps Next and shows a stale status word", async () => {
    const document = readyDocument()
    document.status = "stale"
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("stale"))
      expect(frame).toContain("stale")
      expect(frame).toContain("add tests")
    } finally {
      await app.dispose()
    }
  })

  test("renders a not-built state without calling ensure", async () => {
    const { fake, app } = await mount({ get: async () => ({ document: null, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Not built"))
      expect(frame).toContain("Not built")
      expect(frame).toContain("/recap to build")
      expect(fake.calls.map((call) => call.method)).toEqual(["get"])
    } finally {
      await app.dispose()
    }
  })

  test("renders a disabled reason", async () => {
    const { app } = await mount({
      get: async () => ({ document: null, busy: false, disabledReason: "Recap is disabled." }),
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Recap is disabled."))
      expect(frame).toContain("disabled")
    } finally {
      await app.dispose()
    }
  })

  test("renders a runtime envelope error without discarding the ticker", async () => {
    const error = { message: "Storage unavailable", at: NOW, retryable: true, kind: "storage" as const }
    const { app } = await mount({
      get: async () => ({ document: readyDocument(), busy: false, error }),
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Storage unavailable"))
      expect(frame).toContain("error")
      expect(frame).toContain("Built the sidebar")
      expect(frame).toContain("/recap to retry")
    } finally {
      await app.dispose()
    }
  })

  test("renders a request error and no stale data", async () => {
    const { app } = await mount({
      get: async () => {
        throw new Error("transport exploded")
      },
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("transport exploded"))
      expect(frame).toContain("transport exploded")
      expect(frame).toContain("/recap to retry")
    } finally {
      await app.dispose()
    }
  })

  test("keeps the ticker and Now line when a reload fails", async () => {
    let calls = 0
    const { fake, app } = await mount({
      get: async () => {
        calls += 1
        if (calls > 1) throw new Error("transport exploded")
        return { document: readyDocument(), busy: false }
      },
    })
    try {
      await app.waitForFrame((value) => value.includes("Built the sidebar"))
      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_1" } })

      const frame = await app.waitForFrame((value) => value.includes("transport exploded"))
      expect(frame).toContain("Built the sidebar")
      expect(frame).not.toContain("add tests")
      expect(frame).toContain("/recap to retry")
    } finally {
      await app.dispose()
    }
  })

  test("reloads on an updated event", async () => {
    let calls = 0
    const { fake, app } = await mount({
      get: async () => {
        calls += 1
        const document = readyDocument()
        if (calls > 1) document.chapters[1] = chapter("c2", "Updated chapter", [highlight("h3", "Updated highlight")])
        return { document, busy: false }
      },
    })
    try {
      await app.waitForFrame((value) => value.includes("Built the sidebar"))
      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_1" } })

      const frame = await app.waitForFrame((value) => value.includes("Updated highlight"))
      expect(frame).toContain("Updated chapter")
    } finally {
      await app.dispose()
    }
  })

  test("renders a child session as nothing and never calls get", async () => {
    const { fake, app } = await mount({}, { session: { parentID: "ses_parent" } })
    try {
      const frame = app.captureCharFrame()
      expect(frame).not.toContain("Recap")
      expect(fake.calls).toHaveLength(0)
    } finally {
      await app.dispose()
    }
  })

  test("flattens newlines from model text into one line", async () => {
    const document = readyDocument()
    document.chapters[1] = chapter("c2", "Newest\nchapter", [
      highlight("h2", "Built\nthe sidebar"),
      highlight("p1", "Next: add tests", "plan"),
    ])
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Built the sidebar"))
      expect(frame).toContain("Newest chapter")
      expect(frame).not.toContain("Newest\nchapter")
      expect(frame.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(4)
    } finally {
      await app.dispose()
    }
  })

  test("holds an overflowing ticker at its start until hovered", async () => {
    const document = readyDocument()
    document.chapters[0] = chapter("c1", "A very long chapter title that cannot fit in the sidebar at all", [
      highlight("h1", "First"),
    ])
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const before = await app.waitForFrame((value) => value.includes("A very long chapter"))
      await Bun.sleep(500)
      await app.renderOnce()
      const after = app.captureCharFrame()

      expect(before).toContain("A very long chapter")
      expect(after).toContain("A very long chapter")
      expect(after).not.toContain("…")
    } finally {
      await app.dispose()
    }
  })

  test("scrolls an overflowing ticker while hovered instead of truncating it", async () => {
    const document = readyDocument()
    document.chapters[0] = chapter("c1", "A very long chapter title that cannot fit in the sidebar at all", [
      highlight("h1", "First"),
    ])
    const { app } = await mount({ get: async () => ({ document, busy: false }) })
    try {
      const before = await app.waitForFrame((value) => value.includes("A very long chapter"))
      await app.mockMouse.moveTo(10, 1)
      await Bun.sleep(500)
      await app.renderOnce()
      const after = app.captureCharFrame()

      expect(before).toContain("A very long chapter")
      expect(after).not.toContain("A very long chapter")
      expect(after).toContain("chapter title")
      expect(after).not.toContain("…")
    } finally {
      await app.dispose()
    }
  })

  test("never renders an ellipsis at a narrow width", async () => {
    const document = readyDocument()
    document.chapters[0] = chapter("c1", "A very long chapter title that cannot fit", [highlight("h1", "First")])
    const { app } = await mount({ get: async () => ({ document, busy: false }) }, {}, { width: 20, height: 10 })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Recap"))
      expect(frame).not.toContain("...")
      expect(frame).not.toContain("…")
    } finally {
      await app.dispose()
    }
  })
})
