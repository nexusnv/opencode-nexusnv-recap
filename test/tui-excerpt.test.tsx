/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ExcerptItem } from "../src/shared/types"
import { ExcerptDialog, openExcerpt } from "../src/tui/excerpt"
import type { TimelineState } from "../src/tui/state"
import { fakeTui } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"

function fakeState(items: ExcerptItem[] | Error): TimelineState {
  return {
    async excerpt() {
      if (items instanceof Error) throw items
      return items
    },
  } as unknown as TimelineState
}

function renderExcerpt(items: ExcerptItem[] | Error, width = 100, height = 30) {
  const fake = fakeTui()
  return testRender(() => <ExcerptDialog context={fake.context} state={fakeState(items)} messageID="msg_anchor" />, {
    width,
    height,
  })
}

describe("ExcerptDialog", () => {
  test("renders the role, relative time, and text of every item", async () => {
    const items: ExcerptItem[] = [
      { role: "user", at: NOW, text: "Please build the panel", messageID: "msg_1", isAnchor: false },
      { role: "assistant", at: NOW, text: "Implemented the panel", messageID: "msg_2", isAnchor: true },
    ]
    const app = await renderExcerpt(items)
    try {
      const frame = await app.waitForFrame((value) => value.includes("Implemented the panel"))
      expect(frame).toContain("Excerpt")
      expect(frame).toContain("Please build the panel")
      expect(frame).toContain("user ·")
      expect(frame).toContain("assistant ·")
      expect(frame).toContain("esc close")
    } finally {
      await app.dispose()
    }
  })

  test("marks only the anchor item with the arrow", async () => {
    const items: ExcerptItem[] = [
      { role: "user", at: NOW, text: "Earlier context", messageID: "msg_1", isAnchor: false },
      { role: "assistant", at: NOW, text: "The anchor", messageID: "msg_2", isAnchor: true },
    ]
    const app = await renderExcerpt(items)
    try {
      const frame = await app.waitForFrame((value) => value.includes("The anchor"))
      expect(frame).toContain("→ assistant")
      expect(frame).toContain("  user")
    } finally {
      await app.dispose()
    }
  })

  test("reports a compacted original when the server returns no items", async () => {
    const app = await renderExcerpt([])
    try {
      const frame = await app.waitForFrame((value) => value.includes("Original message not available"))
      expect(frame).toContain("Original message not available (compacted).")
    } finally {
      await app.dispose()
    }
  })

  test("renders the failure message when the excerpt request rejects", async () => {
    const app = await renderExcerpt(new Error("Could not load the excerpt from the server"))
    try {
      const frame = await app.waitForFrame((value) => value.includes("Could not load the excerpt"))
      expect(frame).toContain("Could not load the excerpt from the server")
    } finally {
      await app.dispose()
    }
  })

  test("renders exactly the server-provided text and never synthesizes reasoning", async () => {
    const items: ExcerptItem[] = [
      { role: "assistant", at: NOW, text: "sanitized output only", messageID: "msg_1", isAnchor: true },
    ]
    const app = await renderExcerpt(items)
    try {
      const frame = await app.waitForFrame((value) => value.includes("sanitized output only"))
      expect(frame).toContain("sanitized output only")
      expect(frame).not.toContain("reasoning")
      expect(frame).not.toContain("thinking")
    } finally {
      await app.dispose()
    }
  })

  test("renders inside a narrow dialog without throwing", async () => {
    const items: ExcerptItem[] = [
      { role: "tool", at: NOW, text: "a long tool result that needs wrapping", messageID: "msg_1", isAnchor: true },
    ]
    const app = await renderExcerpt(items, 30, 10)
    try {
      await app.waitForFrame((value) => value.includes("Excerpt"))
    } finally {
      await app.dispose()
    }
  })
})

describe("openExcerpt", () => {
  test("shows a large centered dialog", () => {
    const fake = fakeTui()
    openExcerpt(fake.context, fakeState([]), "msg_anchor")

    expect(fake.uiCalls.dialogs).toBe(1)
    expect(fake.uiCalls.dialogSet).toEqual([{ size: "large", centered: true }])
  })
})
