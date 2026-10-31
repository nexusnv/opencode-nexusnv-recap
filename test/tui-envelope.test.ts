import { describe, expect, test } from "bun:test"
import { createDocument } from "../src/shared/document"
import { parseEnvelope } from "../src/tui/envelope"
import { TEST_MODEL } from "./helpers/engine"

const NOW = "2026-10-29T10:00:00.000Z"

function document() {
  return createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 2,
    now: NOW,
  })
}

describe("parseEnvelope", () => {
  test("accepts a document and defaults missing flags", () => {
    const loaded = document()
    const envelope = parseEnvelope({ document: loaded })

    expect(envelope.document).toEqual(loaded)
    expect(envelope.busy).toBe(false)
    expect(envelope.disabledReason).toBeUndefined()
    expect(envelope.error).toBeUndefined()
  })

  test("accepts a null document and optional metadata", () => {
    const error = { message: "boom", at: NOW, retryable: true, kind: "storage" as const }
    const envelope = parseEnvelope({
      document: null,
      busy: true,
      disabledReason: "Recap is disabled.",
      error,
    })

    expect(envelope).toEqual({
      document: null,
      busy: true,
      disabledReason: "Recap is disabled.",
      error,
    })
  })

  test("rejects a non-object envelope", () => {
    expect(() => parseEnvelope(null)).toThrow("Recap returned an invalid response")
    expect(() => parseEnvelope([])).toThrow("Recap returned an invalid response")
  })

  test("rejects a malformed document", () => {
    expect(() => parseEnvelope({ document: { version: 99 } })).toThrow("Recap returned an invalid document")
  })

  test("drops malformed optional fields", () => {
    const envelope = parseEnvelope({
      document: null,
      busy: "yes",
      disabledReason: 42,
      error: { message: "boom" },
    })

    expect(envelope.busy).toBe(false)
    expect(envelope.disabledReason).toBeUndefined()
    expect(envelope.error).toBeUndefined()
  })
})
