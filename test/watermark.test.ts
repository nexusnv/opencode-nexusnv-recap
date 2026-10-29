import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { TimelineWatermark } from "../src/shared/types"
import { sliceAfterWatermark } from "../src/server/watermark"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

let sequence = 0

function message(created: number, type: "user" | "idle" = "user"): SessionMessageInfo {
  sequence += 1
  const id = `msg_${sequence}`
  return type === "idle"
    ? { id, time: { created }, type: "idle", outcome: "succeeded" }
    : { id, time: { created }, type: "user", text: `message ${sequence}` }
}

function watermark(messageID: string, createdAt: number): TimelineWatermark {
  return { messageID, createdAt: new Date(createdAt).toISOString(), messageCount: 1 }
}

describe("sliceAfterWatermark", () => {
  test("returns messages after a matching watermark, including ignored messages", () => {
    const first = message(BASE_TIME)
    const ignored = message(BASE_TIME + 10, "idle")
    const last = message(BASE_TIME + 20)

    const slice = sliceAfterWatermark([first, ignored, last], watermark(first.id, BASE_TIME))

    expect(slice).toEqual({ kind: "new", messages: [ignored, last] })
  })

  test("falls back to messages newer than the watermark timestamp", () => {
    const before = message(BASE_TIME)
    const atWatermark = message(BASE_TIME + 10)
    const after = message(BASE_TIME + 20)

    const slice = sliceAfterWatermark([before, atWatermark, after], watermark("missing", BASE_TIME + 10))

    expect(slice).toEqual({ kind: "new", messages: [after] })
  })

  test("reports history-changed when the watermark and later messages are missing", () => {
    const slice = sliceAfterWatermark([message(BASE_TIME)], watermark("missing", BASE_TIME + 10))

    expect(slice).toEqual({ kind: "history-changed" })
  })

  test("returns empty for an empty transcript", () => {
    expect(sliceAfterWatermark([], watermark("missing", BASE_TIME))).toEqual({ kind: "empty" })
    expect(sliceAfterWatermark([], null)).toEqual({ kind: "empty" })
  })

  test("returns empty when the watermark is the last message", () => {
    const first = message(BASE_TIME)
    const last = message(BASE_TIME + 10)

    const slice = sliceAfterWatermark([first, last], watermark(last.id, BASE_TIME + 10))

    expect(slice).toEqual({ kind: "empty" })
  })

  test("excludes equal timestamps in the time fallback", () => {
    const equalFirst = message(BASE_TIME)
    const equalSecond = message(BASE_TIME)
    const later = message(BASE_TIME + 10)

    const slice = sliceAfterWatermark([equalFirst, equalSecond, later], watermark("missing", BASE_TIME))

    expect(slice).toEqual({ kind: "new", messages: [later] })
  })

  test("returns a new array without mutating the input", () => {
    const first = message(BASE_TIME)
    const second = message(BASE_TIME + 10)
    const messages = [first, second]

    const slice = sliceAfterWatermark(messages, watermark(first.id, BASE_TIME))

    expect(slice.kind).toBe("new")
    if (slice.kind === "new") {
      expect(slice.messages).toEqual([second])
      expect(slice.messages).not.toBe(messages)
    }
    expect(messages).toEqual([first, second])
  })
})
