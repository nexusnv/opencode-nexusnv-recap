import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"
import { TEST_MODEL, TEST_PROJECT_ID, TEST_SESSION_ID, FakeStorage } from "./helpers/engine"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

interface HarnessOptions {
  config?: Record<string, unknown>
  session?: Partial<SessionInfo>
  sessionError?: unknown
  messages?: SessionMessageInfo[]
  contextError?: unknown
}

interface ErrorCall {
  type: string
  message: string
  data?: unknown
}

function fakeCall() {
  const errors: ErrorCall[] = []
  const call = {
    signal: new AbortController().signal,
    error(type: string, message: string, data?: unknown) {
      errors.push({ type, message, data })
      return { type, message, data }
    },
  }
  return { call, errors }
}

async function setupPlugin(options: HarnessOptions = {}) {
  const storage = new FakeStorage()
  const handlers: Record<string, (input: unknown, call: unknown) => Promise<unknown>> = {}
  const emitted: Array<{ name: string; data: unknown }> = []
  let sessionGets = 0
  let disposed = 0

  const session = {
    id: TEST_SESSION_ID,
    projectID: TEST_PROJECT_ID,
    title: "Test session",
    cost: 0,
    tokens: {},
    time: { created: BASE_TIME, updated: BASE_TIME },
    location: { directory: "/tmp" },
    ...options.session,
  } as unknown as SessionInfo

  const ctx = {
    options: options.config ?? { model: TEST_MODEL },
    session: {
      async get() {
        sessionGets += 1
        if (options.sessionError !== undefined) throw options.sessionError
        return session
      },
      async context() {
        if (options.contextError !== undefined) throw options.contextError
        return options.messages ?? []
      },
    },
    model: {
      async list() {
        return { data: [{ ...TEST_MODEL, enabled: true }] }
      },
    },
    storage,
    event: {
      async *subscribe() {},
    },
    generate: {
      async text() {
        return { text: '{"goal":"","tasks":null,"chapters":[]}' }
      },
    },
    experimental: {},
    location: {
      directory: "/tmp",
      project: { id: TEST_PROJECT_ID, directory: "/tmp", canonical: "/tmp" },
    },
    rpc: {
      async register(_definition: unknown, registered: typeof handlers) {
        Object.assign(handlers, registered)
        return {
          events: {
            async emit(name: string, data: unknown) {
              emitted.push({ name, data })
            },
          },
          async dispose() {
            disposed += 1
          },
        }
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await plugin.setup(ctx)
  return {
    handlers,
    emitted,
    sessionGets,
    disposed: () => disposed,
    cleanup: async () => {
      await cleanup?.()
    },
  }
}

function user(text: string): SessionMessageInfo {
  return { id: `msg_${Math.random().toString(36).slice(2)}`, time: { created: BASE_TIME }, type: "user", text }
}

describe("timeline RPC handlers", () => {
  test("maps a missing session to session_not_found with its id", async () => {
    const harness = await setupPlugin({ sessionError: { status: 404 } })
    const { call, errors } = fakeCall()

    await harness.handlers.get?.({ sessionID: TEST_SESSION_ID }, call)
    await harness.cleanup()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ type: "session_not_found", data: { sessionID: TEST_SESSION_ID } })
  })

  test("maps a disabled config to disabled with the reason", async () => {
    const harness = await setupPlugin({ config: { enabled: false } })
    const { call, errors } = fakeCall()

    await harness.handlers.backfill?.({ sessionID: TEST_SESSION_ID, confirm: false }, call)
    await harness.cleanup()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe("disabled")
    expect(errors[0]?.data).toEqual({ reason: "Recap is disabled." })
  })

  test("maps an unconfirmed large backfill to confirmation_required with the estimate", async () => {
    const harness = await setupPlugin({
      config: {
        model: TEST_MODEL,
        backfill: { confirmOverCalls: 1 },
        digest: { maxChars: 2_000, maxUserChars: 100_000 },
      },
      messages: [user("x".repeat(1_500)), user("y".repeat(1_500))],
    })
    const { call, errors } = fakeCall()

    await harness.handlers.backfill?.({ sessionID: TEST_SESSION_ID, confirm: false }, call)
    await harness.cleanup()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe("confirmation_required")
    const data = errors[0]?.data as { approxCalls?: number } | undefined
    expect(typeof data?.approxCalls).toBe("number")
    expect(data?.approxCalls).toBeGreaterThan(1)
  })

  test("maps an unknown error to internal with a sanitized message", async () => {
    const harness = await setupPlugin({
      contextError: new Error("read failed with sk-abcdefghijklmnopqrstuvwxyz123456"),
    })
    const { call, errors } = fakeCall()

    await harness.handlers.excerpt?.({ sessionID: TEST_SESSION_ID, messageID: "msg_1" }, call)
    await harness.cleanup()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe("internal")
    expect(errors[0]?.message).toContain("read failed with")
    expect(errors[0]?.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
  })

  test("rejects unknown input keys before touching the engine", async () => {
    const harness = await setupPlugin()
    const { call, errors } = fakeCall()

    await harness.handlers.get?.({ sessionID: TEST_SESSION_ID, extra: true }, call)
    await harness.cleanup()

    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe("invalid_request")
    expect(harness.sessionGets).toBe(0)
  })

  test("emits engine updates through the registration sink", async () => {
    const harness = await setupPlugin()
    const { call } = fakeCall()

    await harness.handlers.ensure?.({ sessionID: TEST_SESSION_ID }, call)
    await harness.cleanup()

    const updated = harness.emitted.find((event) => event.name === "updated")
    expect(updated).toBeDefined()
    expect(updated?.data).toMatchObject({ sessionID: TEST_SESSION_ID, status: "empty" })
  })

  test("disposes the registration on cleanup", async () => {
    const harness = await setupPlugin()
    await harness.cleanup()

    expect(harness.disposed()).toBe(1)
  })
})
