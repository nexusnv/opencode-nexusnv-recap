import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { readSessionMessages } from "../src/server/read"

type ReaderContext = Pick<Plugin.Context, "session">

interface PaginatorInput {
  sessionID: string
  order?: "asc" | "desc"
  limit?: number
  cursor?: string
}

interface FakePaginator {
  calls: PaginatorInput[]
  list: (input: PaginatorInput) => Promise<unknown>
}

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

let sequence = 0

function nextID(prefix: string): string {
  sequence += 1
  return `${prefix}_${sequence}`
}

function user(created: number): SessionMessageInfo {
  return { id: nextID("user"), time: { created }, type: "user", text: "hello" }
}

function idle(created: number): SessionMessageInfo {
  return { id: nextID("idle"), time: { created }, type: "idle", outcome: "succeeded" }
}

function compaction(created: number, summary: string): SessionMessageInfo {
  return {
    id: nextID("compaction"),
    time: { created },
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary,
  }
}

function paginator(pages: unknown[]): FakePaginator {
  const calls: PaginatorInput[] = []
  let index = 0
  return {
    calls,
    async list(input) {
      calls.push(input)
      const page = pages[index]
      index += 1
      if (page === undefined) throw new Error("unexpected page request")
      return page
    },
  }
}

interface Harness {
  ctx: ReaderContext
  contextCalls: () => number
}

function harness(options: { messages?: SessionMessageInfo[]; list?: FakePaginator["list"] } = {}): Harness {
  let calls = 0
  const session: Record<string, unknown> = {
    context: async () => {
      calls += 1
      return options.messages ?? []
    },
  }
  if (options.list) session.message = { list: options.list }
  return { ctx: { session } as unknown as ReaderContext, contextCalls: () => calls }
}

describe("readSessionMessages", () => {
  test("prefers the full paginator when the session exposes one", async () => {
    const full = user(BASE_TIME + 20)
    const fake = paginator([{ data: [full], cursor: {} }])
    const h = harness({ messages: [user(BASE_TIME + 10)], list: fake.list })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(read.source).toBe("full")
    expect(read.messages).toEqual([full])
    expect(h.contextCalls()).toBe(0)
  })

  test("paginates ascending and concatenates pages", async () => {
    const first = user(BASE_TIME + 10)
    const second = user(BASE_TIME + 20)
    const fake = paginator([
      { data: [first], cursor: { next: "page-2" } },
      { data: [second], cursor: {} },
    ])
    const h = harness({ list: fake.list })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(fake.calls).toEqual([
      { sessionID: "ses_1", order: "asc", limit: 100 },
      { sessionID: "ses_1", order: "asc", limit: 100, cursor: "page-2" },
    ])
    expect(read.messages).toEqual([first, second])
  })

  test("falls back to context when pagination throws", async () => {
    const fallback = user(BASE_TIME + 10)
    const calls: PaginatorInput[] = []
    const list = async (input: PaginatorInput): Promise<unknown> => {
      calls.push(input)
      throw new Error("paginator unavailable")
    }
    const h = harness({ messages: [fallback], list })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(read.source).toBe("context")
    expect(read.messages).toEqual([fallback])
    expect(h.contextCalls()).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test("sorts context messages ascending with stable ties", async () => {
    const late = user(BASE_TIME + 30)
    const tieFirst = user(BASE_TIME + 10)
    const early = user(BASE_TIME)
    const tieSecond = user(BASE_TIME + 10)
    const h = harness({ messages: [late, tieFirst, early, tieSecond] })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(read.messages.map((message) => message.id)).toEqual([early.id, tieFirst.id, tieSecond.id, late.id])
  })

  test("marks context reads partial when they start at a completed compaction", async () => {
    const summary = compaction(BASE_TIME + 10, "Earlier decisions")
    const after = user(BASE_TIME + 20)
    const h = harness({ messages: [after, summary] })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(read.source).toBe("context")
    expect(read.partial).toBe(true)
    expect(read.partialReason).toBe("compacted-history")
    expect(read.messages.map((message) => message.id)).toEqual([summary.id, after.id])
  })

  test("is not partial when full pagination terminates", async () => {
    const fake = paginator([{ data: [user(BASE_TIME)], cursor: {} }])
    const h = harness({ list: fake.list })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(read.source).toBe("full")
    expect(read.partial).toBe(false)
    expect(read.partialReason).toBeUndefined()
  })

  test("reports pagination truncation when the 200-page safety cap is hit", async () => {
    let calls = 0
    const list = async (): Promise<unknown> => {
      calls += 1
      return { data: [user(BASE_TIME + calls)], cursor: { next: `cursor-${calls}` } }
    }
    const h = harness({ list })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(calls).toBe(200)
    expect(read.source).toBe("full")
    expect(read.partial).toBe(true)
    expect(read.partialReason).toBe("pagination-limit")
    expect(read.messages).toHaveLength(200)
  })

  test("retains the compaction summary so the digest can use it", async () => {
    const summary = compaction(BASE_TIME, "Earlier decisions and code changes")
    const h = harness({ messages: [summary] })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(
      read.messages.map((message) =>
        message.type === "compaction" && message.status === "completed" ? message.summary : undefined,
      ),
    ).toEqual(["Earlier decisions and code changes"])
  })

  test("does not mutate the array returned by context", async () => {
    const late = user(BASE_TIME + 20)
    const middle = idle(BASE_TIME + 10)
    const early = user(BASE_TIME)
    const messages = [late, middle, early]
    const h = harness({ messages })

    const read = await readSessionMessages(h.ctx, "ses_1")

    expect(messages).toEqual([late, middle, early])
    expect(read.messages.map((message) => message.id)).toEqual([early.id, middle.id, late.id])
  })
})
