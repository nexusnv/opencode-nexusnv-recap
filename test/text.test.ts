import { describe, expect, test } from "bun:test"
import { clip, isRecord, iso, normalizeText, redactSecrets, safeString, slugify } from "../src/server/text"

describe("clip", () => {
  test("keeps a head and tail with a truncation marker within max", () => {
    const result = clip("abcdefghijklmnopqrstuvwxyz", 20)
    expect(result.length).toBeLessThanOrEqual(20)
    expect(result).toContain("…[truncated]…")
    expect(result.startsWith("abcd")).toBe(true)
    expect(result.endsWith("z")).toBe(true)
  })

  test("returns the input unchanged when it fits", () => {
    expect(clip("short", 20)).toBe("short")
    expect(clip("exact", 5)).toBe("exact")
  })

  test("falls back to a plain head slice when the marker cannot fit", () => {
    expect(clip("abcdefghij", 5)).toBe("abcde")
    expect(clip("abcdefghij", 0)).toBe("")
    expect(clip("abcdefghij", -1)).toBe("")
  })
})

describe("redactSecrets", () => {
  test("redacts common token shapes", () => {
    expect(redactSecrets("sk-abcdefghijklmnop1234")).toBe("[REDACTED]")
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwx")).toBe("[REDACTED]")
    expect(redactSecrets("github_pat_abcdefghijklmnopqrstuvwx")).toBe("[REDACTED]")
    expect(redactSecrets("AKIAABCDEFGHIJKLMNOP")).toBe("[REDACTED]")
    expect(redactSecrets("Authorization: Bearer abc.def.ghi-012")).toBe("Authorization: Bearer [REDACTED]")
    expect(redactSecrets("api_key=supersecret123")).toBe("api_key=[REDACTED]")
    expect(redactSecrets('password: "hunter2hunter2"')).toBe("password=[REDACTED]")
  })

  test("redacts a private key block", () => {
    const text = "before\n-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\nafter"
    expect(redactSecrets(text)).toBe("before\n[REDACTED]\nafter")
  })

  test("does not touch short strings or the word token", () => {
    expect(redactSecrets("sk-123")).toBe("sk-123")
    expect(redactSecrets("the token is here")).toBe("the token is here")
    expect(redactSecrets("tokenizer")).toBe("tokenizer")
  })
})

describe("normalizeText", () => {
  test("trims, collapses whitespace, and lowercases", () => {
    expect(normalizeText("  Hello   WORLD \n next ")).toBe("hello world next")
  })
})

describe("slugify", () => {
  test("produces stable kebab-case keys", () => {
    expect(slugify("Build the RPC Layer!")).toBe("build-the-rpc-layer")
    expect(slugify("Build the RPC Layer!")).toBe(slugify("  build   the rpc layer  "))
    expect(slugify("a".repeat(100))).toHaveLength(48)
  })

  test("keeps letters from non-Latin scripts distinct", () => {
    expect(slugify("مرحبا بالعالم")).toBe("مرحبا-بالعالم")
    expect(slugify("日本語")).toBe("日本語")
  })

  test("falls back to task for empty input", () => {
    expect(slugify("")).toBe("task")
    expect(slugify("   ... !!!   ")).toBe("task")
  })
})

describe("iso", () => {
  test("formats the epoch", () => {
    expect(iso(0)).toBe("1970-01-01T00:00:00.000Z")
  })
})

describe("small guards", () => {
  test("safeString accepts only strings", () => {
    expect(safeString("x")).toBe("x")
    expect(safeString(1)).toBeUndefined()
    expect(safeString(undefined)).toBeUndefined()
  })

  test("isRecord rejects arrays and null", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
  })
})
