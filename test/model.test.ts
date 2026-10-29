import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import {
  DEFAULT_BACKFILL,
  DEFAULT_DIGEST,
  DEFAULT_LIMITS,
  DEFAULT_UPDATE,
  type LimitsConfig,
  type TimelineConfig,
} from "../src/config"
import { ModelFailure, createModelClient, type ModelClientOptions } from "../src/server/model"
import type { TimelineModelRef } from "../src/shared/types"

type ModelContext = Pick<Plugin.Context, "generate" | "experimental">

interface FakeCall {
  input: unknown
  options?: { signal?: AbortSignal } | undefined
}

type FakeText = (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>

interface FakeHarness {
  ctx: ModelContext
  calls: FakeCall[]
}

function fakeContext(options: { text?: FakeText; experimental?: unknown } = {}): FakeHarness {
  const calls: FakeCall[] = []
  const text: FakeText = options.text ?? (async () => ({ text: "{}" }))
  const generate = {
    text: async (input: unknown, request?: { signal?: AbortSignal }) => {
      calls.push(request === undefined ? { input } : { input, options: request })
      return text(input, request)
    },
  }
  const experimental = options.experimental ?? { terminal: {} }
  return { ctx: { generate, experimental } as unknown as ModelContext, calls }
}

const MODEL: TimelineModelRef = { providerID: "openai", modelID: "gpt-5-mini" }

function makeConfig(limits: Partial<LimitsConfig> = {}, model: TimelineModelRef | undefined = MODEL): TimelineConfig {
  return {
    enabled: true,
    model,
    update: DEFAULT_UPDATE,
    backfill: DEFAULT_BACKFILL,
    digest: DEFAULT_DIGEST,
    limits: { ...DEFAULT_LIMITS, ...limits },
  }
}

function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

interface SleepRecorder {
  delays: number[]
  options: ModelClientOptions
}

function sleepRecorder(random: () => number = () => 0): SleepRecorder {
  const delays: number[] = []
  return {
    delays,
    options: {
      async sleep(ms) {
        delays.push(ms)
      },
      random,
    },
  }
}

async function failureOf(promise: Promise<unknown>): Promise<ModelFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ModelFailure) return error
    throw error
  }
  throw new Error("Expected the model call to fail")
}

describe("createModelClient", () => {
  test("calls generate.text with the prompt and the configured model", async () => {
    const harness = fakeContext()
    const client = createModelClient(harness.ctx, makeConfig())

    expect(await client.complete("Summarize the session")).toBe("{}")

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.input).toEqual({
      prompt: "Summarize the session",
      model: { providerID: "openai", id: "gpt-5-mini" },
    })
  })

  test("maps the configured modelID to the API id and forwards a variant", async () => {
    const harness = fakeContext()
    const client = createModelClient(
      harness.ctx,
      makeConfig({}, { providerID: "anthropic", modelID: "claude-x", variant: "high" }),
    )

    await client.complete("p")

    const input = harness.calls[0]?.input as { model?: Record<string, unknown> } | undefined
    expect(input?.model).toEqual({ providerID: "anthropic", id: "claude-x", variant: "high" })
  })

  test("omits variant when the configuration has none", async () => {
    const harness = fakeContext()
    const client = createModelClient(harness.ctx, makeConfig())

    await client.complete("p")

    const input = harness.calls[0]?.input as { model?: Record<string, unknown> } | undefined
    expect(input?.model).toEqual({ providerID: "openai", id: "gpt-5-mini" })
    expect(input?.model && "variant" in input.model).toBe(false)
  })

  test("prefers the experimental generate API when the host exposes it", async () => {
    const baseCalls: unknown[] = []
    const experimentalCalls: unknown[] = []
    const ctx = {
      generate: {
        text: async (input: unknown) => {
          baseCalls.push(input)
          return { text: "base" }
        },
      },
      experimental: {
        generate: {
          text: async (input: unknown) => {
            experimentalCalls.push(input)
            return { text: "experimental" }
          },
        },
      },
    } as unknown as ModelContext

    const client = createModelClient(ctx, makeConfig())

    expect(await client.complete("p")).toBe("experimental")
    expect(experimentalCalls).toHaveLength(1)
    expect(baseCalls).toHaveLength(0)
  })

  test("falls back to ctx.generate.text when experimental.generate is absent", async () => {
    const harness = fakeContext({ experimental: { terminal: {} } })
    const client = createModelClient(harness.ctx, makeConfig())

    expect(await client.complete("p")).toBe("{}")
    expect(harness.calls).toHaveLength(1)
  })

  test("returns result.text verbatim", async () => {
    const text = '  {"goal":""}\n'
    const harness = fakeContext({ text: async () => ({ text }) })
    const client = createModelClient(harness.ctx, makeConfig())

    expect(await client.complete("p")).toBe(text)
  })

  test("rejects a missing, non-string, or empty result as a model failure", async () => {
    for (const result of [{ text: 42 }, { text: "" }, { text: "   " }, {}, null]) {
      const harness = fakeContext({ text: async () => result })
      const failure = await failureOf(createModelClient(harness.ctx, makeConfig()).complete("p"))

      expect(failure.kind).toBe("model")
      expect(failure.retryable).toBe(false)
      expect(harness.calls).toHaveLength(1)
    }
  })

  test("classifies 401 and 403 as non-retryable auth failures", async () => {
    for (const status of [401, 403]) {
      const harness = fakeContext({
        text: async () => {
          throw httpError(status)
        },
      })
      const failure = await failureOf(createModelClient(harness.ctx, makeConfig()).complete("p"))

      expect(failure.kind).toBe("auth")
      expect(failure.retryable).toBe(false)
      expect(failure.status).toBe(status)
      expect(harness.calls).toHaveLength(1)
    }
  })

  test("classifies 404 as a non-retryable config failure", async () => {
    const harness = fakeContext({
      text: async () => {
        throw httpError(404, "unknown model")
      },
    })
    const failure = await failureOf(createModelClient(harness.ctx, makeConfig()).complete("p"))

    expect(failure.kind).toBe("config")
    expect(failure.retryable).toBe(false)
    expect(failure.status).toBe(404)
    expect(failure.message).toBe("unknown model")
    expect(harness.calls).toHaveLength(1)
  })

  test("retries 429 and 5xx up to the configured budget with jittered backoff", async () => {
    for (const status of [429, 500, 503]) {
      const harness = fakeContext({
        text: async () => {
          throw httpError(status)
        },
      })
      const recorder = sleepRecorder()
      const client = createModelClient(harness.ctx, makeConfig({ retries: 2 }), recorder.options)
      const failure = await failureOf(client.complete("p"))

      expect(failure.kind).toBe("transient")
      expect(failure.retryable).toBe(true)
      expect(failure.status).toBe(status)
      expect(harness.calls).toHaveLength(3)
      expect(recorder.delays).toEqual([500, 1_000])
    }
  })

  test("times out as transient, retries, and aborts the forwarded request signal", async () => {
    const signals: AbortSignal[] = []
    const harness = fakeContext({
      text: (_input, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal
          if (!signal) {
            reject(new Error("missing forwarded signal"))
            return
          }
          signals.push(signal)
          if (signal.aborted) {
            reject(new Error("aborted"))
            return
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
    })
    const recorder = sleepRecorder()
    const client = createModelClient(harness.ctx, makeConfig({ retries: 1, modelTimeoutMs: 10 }), recorder.options)
    const failure = await failureOf(client.complete("p"))

    expect(failure.kind).toBe("transient")
    expect(failure.retryable).toBe(true)
    expect(harness.calls).toHaveLength(2)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(recorder.delays).toEqual([500])
  })

  test("classifies status-less network errors as retryable transient failures", async () => {
    for (const message of ["fetch failed", "socket hang up", "connect ECONNRESET 127.0.0.1"]) {
      const harness = fakeContext({
        text: async () => {
          throw new TypeError(message)
        },
      })
      const recorder = sleepRecorder()
      const client = createModelClient(harness.ctx, makeConfig({ retries: 1 }), recorder.options)
      const failure = await failureOf(client.complete("p"))

      expect(failure.kind).toBe("transient")
      expect(failure.retryable).toBe(true)
      expect(failure.status).toBeUndefined()
      expect(harness.calls).toHaveLength(2)
      expect(recorder.delays).toEqual([500])
    }
  })

  test("classifies 400 as a non-retryable model failure", async () => {
    const harness = fakeContext({
      text: async () => {
        throw httpError(400, "bad prompt")
      },
    })
    const failure = await failureOf(createModelClient(harness.ctx, makeConfig()).complete("p"))

    expect(failure.kind).toBe("model")
    expect(failure.retryable).toBe(false)
    expect(failure.status).toBe(400)
    expect(failure.message).toBe("bad prompt")
    expect(harness.calls).toHaveLength(1)
  })

  test("forwards a request signal and removes its abort listener after the call", async () => {
    const added: string[] = []
    const removed: string[] = []
    let forwarded: AbortSignal | undefined
    const signal = {
      aborted: false,
      addEventListener(type: string) {
        added.push(type)
      },
      removeEventListener(type: string) {
        removed.push(type)
      },
    } as unknown as AbortSignal
    const harness = fakeContext({
      text: async (_input, options) => {
        forwarded = options?.signal
        return { text: "ok" }
      },
    })

    expect(await createModelClient(harness.ctx, makeConfig()).complete("p", signal)).toBe("ok")

    expect(forwarded).toBeDefined()
    expect(forwarded).not.toBe(signal)
    expect(added).toEqual(["abort"])
    expect(removed).toEqual(["abort"])
  })

  test("propagates an external abort to the forwarded request signal", async () => {
    const controller = new AbortController()
    let forwarded: AbortSignal | undefined
    const harness = fakeContext({
      text: (_input, options) =>
        new Promise((_resolve, reject) => {
          forwarded = options?.signal
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
    })

    const pending = createModelClient(harness.ctx, makeConfig()).complete("p", controller.signal)
    controller.abort()
    const failure = await failureOf(pending)

    expect(failure.kind).toBe("aborted")
    expect(forwarded?.aborted).toBe(true)
  })

  test("removes the abort listener after a failure", async () => {
    let removed = 0
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        removed += 1
      },
    } as unknown as AbortSignal
    const harness = fakeContext({
      text: async () => {
        throw httpError(400, "bad prompt")
      },
    })

    await failureOf(createModelClient(harness.ctx, makeConfig()).complete("p", signal))

    expect(removed).toBe(1)
  })

  test("retries a transient failure and returns the second attempt", async () => {
    let attempts = 0
    const harness = fakeContext({
      text: async () => {
        attempts += 1
        if (attempts === 1) throw httpError(429, "rate limited")
        return { text: "recovered" }
      },
    })
    const recorder = sleepRecorder()
    const client = createModelClient(harness.ctx, makeConfig({ retries: 2 }), recorder.options)

    expect(await client.complete("p")).toBe("recovered")
    expect(attempts).toBe(2)
    expect(harness.calls).toHaveLength(2)
    expect(recorder.delays).toEqual([500])
  })

  test("throws the last failure after the retry budget is exhausted", async () => {
    let attempts = 0
    const harness = fakeContext({
      text: async () => {
        attempts += 1
        throw httpError(503, `failure ${attempts}`)
      },
    })
    const recorder = sleepRecorder()
    const client = createModelClient(harness.ctx, makeConfig({ retries: 1 }), recorder.options)

    const failure = await failureOf(client.complete("p"))

    expect(failure.message).toBe("failure 2")
    expect(failure.status).toBe(503)
    expect(failure.kind).toBe("transient")
    expect(harness.calls).toHaveLength(2)
    expect(recorder.delays).toEqual([500])
  })

  test("rejects an already-aborted signal without calling the model", async () => {
    const controller = new AbortController()
    controller.abort()
    const harness = fakeContext()
    const failure = await failureOf(createModelClient(harness.ctx, makeConfig()).complete("p", controller.signal))

    expect(failure.kind).toBe("aborted")
    expect(failure.retryable).toBe(false)
    expect(harness.calls).toHaveLength(0)
  })

  test("aborts an in-flight call without retrying", async () => {
    const controller = new AbortController()
    const harness = fakeContext({
      text: (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
    })
    const client = createModelClient(harness.ctx, makeConfig({ retries: 2 }))

    const pending = client.complete("p", controller.signal)
    controller.abort()
    const failure = await failureOf(pending)

    expect(failure.kind).toBe("aborted")
    expect(failure.retryable).toBe(false)
    expect(harness.calls).toHaveLength(1)
  })

  test("fails with a config error when no model is configured", async () => {
    const harness = fakeContext()
    const config = { ...makeConfig(), model: undefined }
    const failure = await failureOf(createModelClient(harness.ctx, config).complete("p"))

    expect(failure.kind).toBe("config")
    expect(failure.retryable).toBe(false)
    expect(harness.calls).toHaveLength(0)
  })
})
