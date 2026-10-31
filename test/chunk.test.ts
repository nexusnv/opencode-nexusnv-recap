import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { DEFAULT_BACKFILL, DEFAULT_DIGEST, DEFAULT_LIMITS, DEFAULT_UPDATE, type TimelineConfig } from "../src/config"
import { buildDigest } from "../src/server/digest"
import { chunkMessages, estimateBackfill, estimateMessageChars } from "../src/server/chunk"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

function config(maxChars = 2_000): TimelineConfig {
  return {
    enabled: true,
    model: { providerID: "openai", modelID: "gpt-5-mini" },
    update: DEFAULT_UPDATE,
    backfill: DEFAULT_BACKFILL,
    digest: { ...DEFAULT_DIGEST, maxChars },
    limits: DEFAULT_LIMITS,
  }
}

let sequence = 0

function user(text: string): SessionMessageInfo {
  sequence += 1
  return { id: `user_${sequence}`, time: { created: BASE_TIME + sequence }, type: "user", text }
}

function idle(): SessionMessageInfo {
  sequence += 1
  return { id: `idle_${sequence}`, time: { created: BASE_TIME + sequence }, type: "idle", outcome: "succeeded" }
}

describe("estimateMessageChars", () => {
  test("returns zero for ignored messages", () => {
    expect(estimateMessageChars(idle(), config())).toBe(0)
  })

  test("returns the digest size for included messages", () => {
    const message = user("hello")
    expect(estimateMessageChars(message, config())).toBe(buildDigest([message], config()).chars)
  })
})

describe("chunkMessages", () => {
  test("keeps message order and splits when the combined estimate exceeds the budget", () => {
    const first = user("a".repeat(1_000))
    const second = user("b".repeat(1_000))
    const chunks = chunkMessages([first, second], config())

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.[0]?.id).toBe(first.id)
    expect(chunks[1]?.[0]?.id).toBe(second.id)
    for (const chunk of chunks) {
      expect(buildDigest(chunk, config()).chars).toBeLessThanOrEqual(config().digest.maxChars)
    }
  })

  test("keeps a single oversized message in its own chunk", () => {
    const oversized = user("x".repeat(2_500))
    const next = user("small")
    const chunks = chunkMessages([oversized, next], config())
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual([oversized])
    expect(chunks[1]).toEqual([next])
    expect(buildDigest(chunks[0] ?? [], config()).chars).toBe(config().digest.maxChars)
  })

  test("caps the digest of a single oversized message at maxChars", () => {
    const oversized = user("x".repeat(2_500))
    const digest = buildDigest([oversized], config())

    expect(digest.chars).toBe(config().digest.maxChars)
    expect(digest.text.length).toBe(config().digest.maxChars)
  })

  test("retains a chunk of ignored messages so the watermark can advance", () => {
    const ignored = idle()
    const chunks = chunkMessages([ignored], config())
    expect(chunks).toEqual([[ignored]])
    expect(buildDigest(chunks[0] ?? [], config()).includedCount).toBe(0)
  })

  test("returns no chunks for an empty list", () => {
    expect(chunkMessages([], config())).toEqual([])
  })
})

describe("estimateBackfill", () => {
  test("returns messages, chars, chunks, and approxCalls", () => {
    const messages = [user("a".repeat(1_000)), user("b".repeat(1_000)), idle()]
    const estimate = estimateBackfill(messages, config())
    expect(estimate.messages).toBe(3)
    expect(estimate.chunks).toBe(2)
    expect(estimate.approxCalls).toBe(estimate.chunks)
    expect(estimate.chars).toBeGreaterThan(0)
  })

  test("returns zeroes for empty input", () => {
    expect(estimateBackfill([], config())).toEqual({ messages: 0, chars: 0, chunks: 0, approxCalls: 0 })
  })

  test("uses the same chunking as the engine", () => {
    const messages = [user("one"), user("two"), user("three")]
    expect(estimateBackfill(messages, config()).chunks).toBe(chunkMessages(messages, config()).length)
  })
})
