import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { isRecord } from "./text.js"

export interface SessionRead {
  messages: SessionMessageInfo[]
  source: "full" | "context"
  partial: boolean
}

interface FullPaginator {
  list(input: { sessionID: string; order?: "asc" | "desc"; limit?: number; cursor?: string }): Promise<unknown>
}

export async function readSessionMessages(
  ctx: Pick<Plugin.Context, "session">,
  sessionID: string,
): Promise<SessionRead> {
  const paginator = (ctx.session as unknown as { message?: { list?: FullPaginator["list"] } }).message
  if (paginator?.list) {
    try {
      const page = await readAllPages(paginator.list.bind(paginator), sessionID)
      return { messages: sortMessages(page.messages), source: "full", partial: !page.complete }
    } catch {
      // Fall through to the documented context API.
    }
  }

  const messages = await ctx.session.context({ sessionID })
  const sorted = sortMessages(messages)
  return {
    messages: sorted,
    source: "context",
    partial: isCompactionStart(sorted[0]),
  }
}

async function readAllPages(
  list: FullPaginator["list"],
  sessionID: string,
): Promise<{ messages: SessionMessageInfo[]; complete: boolean }> {
  const all: SessionMessageInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < 200; page += 1) {
    const response = await list({ sessionID, order: "asc", limit: 100, ...(cursor ? { cursor } : {}) })
    const parsed = parsePage(response)
    all.push(...parsed.messages)
    if (!parsed.next) return { messages: all, complete: true }
    cursor = parsed.next
  }
  // A cursor that never terminates is a host bug; report partial coverage
  // rather than silently claiming the whole transcript was read.
  return { messages: all, complete: false }
}

function parsePage(value: unknown): { messages: SessionMessageInfo[]; next?: string } {
  if (Array.isArray(value)) return { messages: value as SessionMessageInfo[] }
  if (isRecord(value) && Array.isArray(value.data)) {
    const cursor = isRecord(value.cursor) ? value.cursor : undefined
    const next = cursor && typeof cursor.next === "string" ? cursor.next : undefined
    return { messages: value.data as SessionMessageInfo[], ...(next ? { next } : {}) }
  }
  return { messages: [] }
}

function sortMessages(messages: readonly SessionMessageInfo[]): SessionMessageInfo[] {
  return messages
    .map((message, index) => ({ message, index }))
    .toSorted((a, b) => a.message.time.created - b.message.time.created || a.index - b.index)
    .map((entry) => entry.message)
}

function isCompactionStart(message: SessionMessageInfo | undefined): boolean {
  return message?.type === "compaction" && message.status === "completed"
}
