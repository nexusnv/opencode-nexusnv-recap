/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createDocument } from "../src/shared/document"
import { PANEL_NAME } from "../src/shared/ids"
import type { TimelineChapter, TimelineDocument, TimelineHighlight, TimelineTask } from "../src/shared/types"
import { TimelinePanel, TimelineSlot } from "../src/tui/panel"
import { TEST_MODEL } from "./helpers/engine"
import { fakeTui, panelInput, type FakeRpc } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"

function task(key: string, title: string, status: TimelineTask["status"]): TimelineTask {
  return { key, title, status, anchorMessageID: `msg_${key}`, updatedAt: NOW }
}

function highlight(id: string, text: string): TimelineHighlight {
  return { id, kind: "implementation", text, at: NOW, anchorMessageID: `msg_${id}` }
}

function chapter(id: string, title: string, summary: string, highlights: TimelineHighlight[]): TimelineChapter {
  return { id, title, summary, startedAt: NOW, endedAt: NOW, highlights, createdAt: NOW, updatedAt: NOW }
}

function readyDocument(): TimelineDocument {
  const document = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 1,
    now: NOW,
  })
  document.goal = "Ship the recap plugin"
  document.status = "ready"
  document.tasks = [task("t1", "Build panel", "done"), task("t2", "Publish", "blocked")]
  document.chapters = [
    chapter("c1", "First chapter", "The first summary.", [highlight("h1", "First highlight")]),
    chapter("c2", "Newest chapter", "The newest summary.", [highlight("h2", "Newest highlight")]),
  ]
  document.watermark = { messageID: "msg_last", createdAt: NOW, messageCount: 2 }
  return document
}

function renderPanel(rpc: Partial<FakeRpc>, options: Parameters<typeof fakeTui>[1] = {}, width = 100, height = 30) {
  const fake = fakeTui(rpc, options)
  return testRender(() => <TimelinePanel context={fake.context} panel={panelInput()} />, { width, height })
}

describe("TimelinePanel", () => {
  test("reloads when the panel session changes", async () => {
    const calls: string[] = []
    const fake = fakeTui({
      ensure: async (input) => {
        const sessionID = (input as { sessionID: string }).sessionID
        calls.push(sessionID)
        const document = readyDocument()
        document.sessionID = sessionID
        document.goal = sessionID === "ses_2" ? "Second session goal" : "First session goal"
        return { document, busy: false }
      },
    })
    const [sessionID, setSessionID] = createSignal("ses_1")
    const panel = {
      ...panelInput({ name: PANEL_NAME }),
      get sessionID() {
        return sessionID()
      },
    }
    const app = await testRender(() => <TimelineSlot context={fake.context} panel={panel} />, {
      width: 100,
      height: 30,
    })
    try {
      await app.waitForFrame((frame) => frame.includes("First session goal"))
      expect(calls).toEqual(["ses_1"])

      setSessionID("ses_2")
      const frame = await app.waitForFrame((value) => value.includes("Second session goal"))
      expect(frame).toContain("Second session goal")
      expect(calls).toEqual(["ses_1", "ses_2"])
    } finally {
      await app.dispose()
    }
  })

  test("renders the header, chapter, summary, and newest highlight", async () => {
    const app = await renderPanel({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Ship the recap plugin"))
      expect(frame).toContain("Ship the recap plugin")
      expect(frame).toContain("1/2 done")
      expect(frame).toContain("blocked: Publish")
      expect(frame).toContain("Newest chapter")
      expect(frame).toContain("The newest summary.")
      expect(frame).toContain("Newest highlight")
      expect(frame).toContain("Recap")
    } finally {
      await app.dispose()
    }
  })

  test("expands only the newest chapter on first render", async () => {
    const app = await renderPanel({ ensure: async () => ({ document: readyDocument(), busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Newest highlight"))
      expect(frame).toContain("Newest highlight")
      expect(frame).not.toContain("First highlight")
    } finally {
      await app.dispose()
    }
  })

  test("renders the no-milestones state for a built document without chapters", async () => {
    const document = readyDocument()
    document.chapters = []
    const app = await renderPanel({ ensure: async () => ({ document, busy: false }) })
    try {
      const frame = await app.waitForFrame((value) => value.includes("No milestones found yet"))
      expect(frame).toContain("No milestones found yet")
      expect(frame).not.toContain("Build recap from this session's history")
    } finally {
      await app.dispose()
    }
  })

  test("renders the build prompt with the estimate for a fresh document", async () => {
    const document = readyDocument()
    document.watermark = null
    document.chapters = []
    const estimate = { messages: 12, chars: 12_000, chunks: 12, approxCalls: 12 }
    const app = await renderPanel({
      ensure: async () => ({ document, busy: false, needsBackfill: true, estimate }),
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Build recap from this session's history"))
      expect(frame).toContain("~12 model calls over 12 messages")
      expect(frame).toContain("Press b to build the recap.")
    } finally {
      await app.dispose()
    }
  })

  test("renders the disabled reason and no chapter rows", async () => {
    const app = await renderPanel({
      ensure: async () => ({ document: null, busy: false, disabledReason: "Recap is disabled." }),
    })
    try {
      const frame = await app.waitForFrame((value) => value.includes("Recap is disabled."))
      expect(frame).toContain("Recap is disabled.")
      expect(frame).not.toContain("Newest chapter")
    } finally {
      await app.dispose()
    }
  })

  test("renders the child-session notice", async () => {
    const app = await renderPanel({}, { session: { parentID: "ses_parent" } })
    try {
      const frame = await app.waitForFrame((value) => value.includes("root sessions"))
      expect(frame).toContain("Recap is available for root sessions.")
    } finally {
      await app.dispose()
    }
  })

  test("renders at a narrow width without throwing", async () => {
    const app = await renderPanel({ ensure: async () => ({ document: readyDocument(), busy: false }) }, {}, 40, 12)
    try {
      await app.waitForFrame((value) => value.includes("Recap"))
    } finally {
      await app.dispose()
    }
  })
})
