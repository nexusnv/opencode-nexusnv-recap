import { describe, expect, test } from "bun:test"
import {
  CONFIG_SNIPPET,
  DEFAULT_BACKFILL,
  DEFAULT_DIGEST,
  DEFAULT_LIMITS,
  DEFAULT_UPDATE,
  disabledConfigSnippet,
  disabledReasonFor,
  parseConfig,
} from "../src/config"

const model = { providerID: "openai", modelID: "gpt-5-mini" }

describe("parseConfig", () => {
  test("uses documented defaults for empty options", () => {
    const { config, problem } = parseConfig(undefined)
    expect(problem).toContain("model")
    expect(config.enabled).toBe(true)
    expect(config.update).toEqual(DEFAULT_UPDATE)
    expect(config.update).toEqual({
      debounceMs: 15_000,
      minNewUserTurns: 2,
      minNewMessages: 6,
      forceAfterMinutes: 10,
      openRefreshAfterMinutes: 2,
    })
    expect(config.backfill).toEqual({ confirmOverCalls: 10 })
    expect(config.digest).toEqual({
      maxChars: 28_000,
      maxUserChars: 4_000,
      maxAssistantChars: 2_000,
      maxToolResultChars: 600,
      maxCompactionChars: 4_000,
      redact: true,
    })
    expect(config.limits).toEqual({
      maxConcurrentCalls: 2,
      maxUpdatesPerHour: 30,
      modelTimeoutMs: 60_000,
      retries: 2,
    })
    expect(DEFAULT_BACKFILL).toEqual({ confirmOverCalls: 10 })
    expect(DEFAULT_DIGEST).toEqual(config.digest)
    expect(DEFAULT_LIMITS).toEqual(config.limits)
  })

  test("accepts enabled false without a model", () => {
    const { config, problem } = parseConfig({ enabled: false })
    expect(problem).toBeUndefined()
    expect(config.enabled).toBe(false)
    expect(config.model).toBeUndefined()
  })

  test("requires a model when enabled", () => {
    const { config, problem } = parseConfig({})
    expect(problem).toContain("model")
    expect(problem).toContain(CONFIG_SNIPPET)
    // The parsed defaults are still returned so the sidebar can show shared values.
    expect(config.enabled).toBe(true)
  })

  test("rejects unknown top-level keys", () => {
    const parsed = parseConfig({ model, unknown: true })
    expect(parsed.problem).toContain("unknown")
    expect(parsed.config.enabled).toBe(false)
  })

  test("rejects unknown update, digest, and limits keys", () => {
    const update = parseConfig({ model, update: { nope: 1 } }).problem
    const digest = parseConfig({ model, digest: { nope: 1 } }).problem
    const limits = parseConfig({ model, limits: { nope: 1 } }).problem
    expect(update).toContain("update")
    expect(update).toContain("nope")
    expect(digest).toContain("digest")
    expect(digest).toContain("nope")
    expect(limits).toContain("limits")
    expect(limits).toContain("nope")
  })

  test("rejects non-integers, negative values, and out-of-range values", () => {
    expect(parseConfig({ model, update: { debounceMs: 1.5 } }).problem).toContain("debounceMs")
    expect(parseConfig({ model, update: { minNewUserTurns: -1 } }).problem).toContain("minNewUserTurns")
    expect(parseConfig({ model, digest: { maxChars: 1_000 } }).problem).toContain("maxChars")
    expect(parseConfig({ model, limits: { retries: 100 } }).problem).toContain("retries")
  })

  test("preserves a valid model variant", () => {
    const parsed = parseConfig({ model: { ...model, variant: "high" } })
    expect(parsed.problem).toBeUndefined()
    expect(parsed.config.model).toEqual({ ...model, variant: "high" })
  })

  test("allows a single nested override without restating the section", () => {
    const parsed = parseConfig({ model, update: { debounceMs: 5_000 } })
    expect(parsed.problem).toBeUndefined()
    expect(parsed.config.update).toEqual({ ...DEFAULT_UPDATE, debounceMs: 5_000 })
  })
})

describe("disabledReasonFor", () => {
  test("returns problems, disabled, and missing models", () => {
    expect(disabledReasonFor(parseConfig({ model }))).toBeUndefined()
    expect(
      disabledReasonFor({
        config: {
          enabled: true,
          update: DEFAULT_UPDATE,
          backfill: DEFAULT_BACKFILL,
          digest: DEFAULT_DIGEST,
          limits: DEFAULT_LIMITS,
        },
        problem: "bad",
      }),
    ).toBe("bad")
    expect(disabledReasonFor(parseConfig({ enabled: false }))).toBe("Recap is disabled.")
    expect(disabledReasonFor(parseConfig({}))).toContain("model")
  })
})

describe("disabledConfigSnippet", () => {
  test("adds the snippet only when it is needed and not already present", () => {
    expect(disabledConfigSnippet(undefined)).toBeUndefined()
    expect(disabledConfigSnippet("Recap is disabled.")).toBeUndefined()
    expect(disabledConfigSnippet("Configured model is unavailable.")).toBe(CONFIG_SNIPPET)
    expect(disabledConfigSnippet(`Recap requires an explicit model.\n${CONFIG_SNIPPET}`)).toBeUndefined()
  })
})

describe("formatConfigProblem", () => {
  test("returns a human-readable message with a valid snippet", () => {
    const parsed = parseConfig({ model, digest: { maxChars: 1 } })
    expect(parsed.problem).toContain("Invalid recap configuration")
    expect(parsed.problem).toContain("digest.maxChars")
    expect(() => JSON.parse(CONFIG_SNIPPET)).not.toThrow()
    expect(JSON.parse(CONFIG_SNIPPET)).toMatchObject({
      plugins: [{ package: "opencode-nexusnv-recap" }],
    })

    const error = parseConfig({ nope: true })
    expect(error.problem).toBeDefined()
    if (error.problem) {
      expect(error.problem).toContain("options")
      expect(error.problem).toContain(CONFIG_SNIPPET)
    }
  })
})
