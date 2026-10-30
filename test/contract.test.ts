import { describe, expect, test } from "bun:test"
import { TimelineRpc } from "../src/rpc"
import { parseBackfillInput, parseExcerptInput, parseSessionInput } from "../src/shared/contract"

describe("contract parsers", () => {
  test("parseSessionInput accepts a session id", () => {
    expect(parseSessionInput({ sessionID: "ses_1" })).toEqual({ sessionID: "ses_1" })
  })

  test("parseSessionInput rejects missing, empty, and non-string ids", () => {
    expect(() => parseSessionInput({})).toThrow(TypeError)
    expect(() => parseSessionInput({ sessionID: "" })).toThrow(TypeError)
    expect(() => parseSessionInput({ sessionID: 42 })).toThrow(TypeError)
    expect(() => parseSessionInput(null)).toThrow(TypeError)
  })

  test("parseSessionInput rejects unknown keys", () => {
    expect(() => parseSessionInput({ sessionID: "ses_1", extra: true })).toThrow(/unknown input key: extra/)
  })

  test("parseBackfillInput defaults confirm to false", () => {
    expect(parseBackfillInput({ sessionID: "ses_1" })).toEqual({ sessionID: "ses_1", confirm: false })
  })

  test("parseBackfillInput accepts an explicit confirmation", () => {
    expect(parseBackfillInput({ sessionID: "ses_1", confirm: true })).toEqual({
      sessionID: "ses_1",
      confirm: true,
    })
  })

  test("parseBackfillInput rejects a non-boolean confirm", () => {
    expect(() => parseBackfillInput({ sessionID: "ses_1", confirm: "yes" })).toThrow(TypeError)
  })

  test("parseExcerptInput requires both strings", () => {
    expect(parseExcerptInput({ sessionID: "ses_1", messageID: "msg_1" })).toEqual({
      sessionID: "ses_1",
      messageID: "msg_1",
    })
    expect(() => parseExcerptInput({ sessionID: "ses_1" })).toThrow(TypeError)
    expect(() => parseExcerptInput({ sessionID: "ses_1", messageID: "" })).toThrow(TypeError)
    expect(() => parseExcerptInput({ sessionID: "ses_1", messageID: "msg_1", extra: 1 })).toThrow(TypeError)
  })
})

describe("TimelineRpc", () => {
  test("exposes exactly the timeline methods", () => {
    expect(Object.keys(TimelineRpc.methods).toSorted()).toEqual([
      "backfill",
      "cancel",
      "ensure",
      "excerpt",
      "get",
      "rebuild",
      "refresh",
    ])
  })

  test("exposes the timeline events", () => {
    expect(Object.keys(TimelineRpc.events).toSorted()).toEqual(["error", "progress", "updated"])
  })
})
