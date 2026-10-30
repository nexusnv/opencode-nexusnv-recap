import { describe, expect, test } from "bun:test"
import { isNotFound, sanitizeError } from "../src/server/errors"

describe("sanitizeError", () => {
  test("uses the message of an Error", () => {
    expect(sanitizeError(new Error("model failed"))).toBe("model failed")
  })

  test("falls back to the name when the host error has no message", () => {
    const error = new Error("")
    error.name = "Session.NotFoundError"

    expect(sanitizeError(error)).toBe("Session.NotFoundError")
  })

  test("uses the message of a plain tagged error", () => {
    expect(sanitizeError({ _tag: "SessionNotFoundError", message: "Session not found: ses_1" })).toBe(
      "Session not found: ses_1",
    )
  })

  test("collapses whitespace and redacts secrets", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    expect(sanitizeError(new Error(`failed   with ${secret}\nretry`))).not.toContain(secret)
    expect(sanitizeError(new Error("failed \n  hard"))).toBe("failed hard")
  })

  test("returns a stable fallback for an empty value", () => {
    expect(sanitizeError("")).toBe("Unknown error")
    expect(sanitizeError(undefined)).toBe("Unknown error")
  })
})

describe("isNotFound", () => {
  test("recognizes the host's Session.NotFoundError shape", () => {
    const error = new Error("")
    error.name = "Session.NotFoundError"
    Object.assign(error, { _tag: "Session.NotFoundError", sessionID: "ses_1" })

    expect(isNotFound(error)).toBe(true)
  })

  test("recognizes a plain tagged not-found error", () => {
    expect(isNotFound({ _tag: "SessionNotFoundError", message: "Session not found" })).toBe(true)
  })

  test("recognizes 404 status and nested status", () => {
    expect(isNotFound({ status: 404 })).toBe(true)
    expect(isNotFound({ data: { statusCode: 404 } })).toBe(true)
  })

  test("recognizes a not-found message", () => {
    expect(isNotFound(new Error("Session not found: ses_1"))).toBe(true)
    expect(isNotFound(new Error("request failed with 404"))).toBe(true)
  })

  test("does not classify transport or unrelated failures as missing", () => {
    expect(isNotFound(new Error("connect ECONNREFUSED"))).toBe(false)
    expect(isNotFound(new Error("model failed"))).toBe(false)
    expect(isNotFound({ status: 500, message: "server error" })).toBe(false)
  })
})
