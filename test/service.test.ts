import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { parseConfig } from "../src/config"
import { TimelineFailure } from "../src/server/errors"
import type { ModelClient } from "../src/server/model"
import { TimelineService } from "../src/server/service"
import { PluginTimelineStore } from "../src/server/store"
import { FakeStorage, TEST_MODEL, TEST_PROJECT_ID, TEST_SESSION_ID } from "./helpers/engine"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

interface FakeContextOptions {
  session?: Partial<SessionInfo>
  messages?: SessionMessageInfo[]
  sessionError?: unknown
  contextError?: unknown
}

function fakeContext(options: FakeContextOptions = {}) {
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

  return {
    session: {
      async get() {
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
    event: {
      async *subscribe() {},
    },
    generate: { text: async () => ({ text: "" }) },
    experimental: {},
    location: {
      directory: "/tmp",
      project: { id: TEST_PROJECT_ID, directory: "/tmp", canonical: "/tmp" },
    },
  } as unknown as Pick<
    Plugin.Context,
    "session" | "model" | "storage" | "event" | "generate" | "experimental" | "location"
  >
}

function createService(
  ctx: ReturnType<typeof fakeContext>,
  options: { enabled?: boolean; model?: ModelClient; messages?: SessionMessageInfo[] } = {},
) {
  const storage = new FakeStorage()
  const parsed = parseConfig(options.enabled === false ? { enabled: false } : { model: TEST_MODEL })
  const modelCalls: string[] = []
  const model: ModelClient = options.model ?? {
    async complete(prompt) {
      modelCalls.push(prompt)
      return '{"goal":"","tasks":null,"chapters":[]}'
    },
  }
  const service = new TimelineService(
    { ...ctx, storage: storage as unknown as Plugin.Context["storage"] },
    parsed,
    new PluginTimelineStore(storage as unknown as Plugin.Context["storage"]),
    model,
  )
  return { service, storage, modelCalls }
}

function user(text: string): SessionMessageInfo {
  return { id: `msg_${Math.random().toString(36).slice(2)}`, time: { created: BASE_TIME }, type: "user", text }
}

function assistant(content: unknown): SessionMessageInfo {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    time: { created: BASE_TIME },
    type: "assistant",
    agent: "build",
    model: { id: TEST_MODEL.modelID, providerID: TEST_MODEL.providerID },
    content,
  } as unknown as SessionMessageInfo
}

describe("TimelineService", () => {
  test("a disabled config reports the reason without calling the model", async () => {
    const { service, modelCalls } = createService(fakeContext(), { enabled: false })
    const result = await service.get(TEST_SESSION_ID)

    expect(result.disabledReason).toBe("Recap is disabled.")
    expect(modelCalls).toHaveLength(0)
  })

  test("rejects a child session with invalid_request", async () => {
    const ctx = fakeContext({ session: { parentID: "ses_parent" } })
    const { service } = createService(ctx)

    await expect(service.get(TEST_SESSION_ID)).rejects.toMatchObject({ code: "invalid_request" })
  })

  test("rejects a session from another project", async () => {
    const ctx = fakeContext({ session: { projectID: "proj_other" } })
    const { service } = createService(ctx)

    await expect(service.get(TEST_SESSION_ID)).rejects.toMatchObject({ code: "session_not_found" })
  })

  test("excerpt rejects a child session", async () => {
    const ctx = fakeContext({ session: { parentID: "ses_parent" } })
    const { service } = createService(ctx)

    await expect(service.excerpt(TEST_SESSION_ID, "msg_1")).rejects.toBeInstanceOf(TimelineFailure)
    await expect(service.excerpt(TEST_SESSION_ID, "msg_1")).rejects.toMatchObject({ code: "invalid_request" })
  })

  test("excerpt rejects a foreign session", async () => {
    const ctx = fakeContext({ session: { projectID: "proj_other" } })
    const { service } = createService(ctx)

    await expect(service.excerpt(TEST_SESSION_ID, "msg_1")).rejects.toMatchObject({
      code: "session_not_found",
    })
  })

  test("excerpt returns sanitized items without reasoning", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    const anchor = assistant([
      { type: "reasoning", text: "SECRET REASONING" },
      { type: "text", text: `implemented with ${secret}` },
    ])
    const ctx = fakeContext({ messages: [user("build it"), anchor] })
    const { service } = createService(ctx)

    const result = await service.excerpt(TEST_SESSION_ID, anchor.id)
    const text = result.items.map((item) => item.text).join("\n")

    expect(text).toContain("implemented with")
    expect(text).not.toContain(secret)
    expect(text).not.toContain("SECRET REASONING")
  })
})
