import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDocument } from "../src/shared/document"
import type { ExcerptItem, TimelineError } from "../src/shared/types"
import { createTimelineState, type TimelineState } from "../src/tui/state"
import { TEST_MODEL } from "./helpers/engine"
import { fakeTui, type FakeRpc } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"

function document(sessionID = "ses_1") {
  return createDocument({
    sessionID,
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 1,
    now: NOW,
  })
}

function runState<T>(
  rpc: Partial<FakeRpc>,
  run: (state: TimelineState, fake: ReturnType<typeof fakeTui>) => Promise<T>,
) {
  const fake = fakeTui(rpc)
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        try {
          const state = createTimelineState(fake.context, "ses_1")
          resolve(await run(state, fake))
        } catch (error) {
          reject(error)
        } finally {
          dispose()
        }
      })()
    })
  })
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

describe("createTimelineState", () => {
  test("load calls ensure with the location and applies a valid document", async () => {
    const loaded = document()
    await runState({ ensure: async () => ({ document: loaded, busy: true }) }, async (state, fake) => {
      await state.load()

      expect(state.document()).toEqual(loaded)
      expect(state.busy()).toBe(true)
      expect(state.loading()).toBe(false)
      expect(fake.calls[0]).toMatchObject({
        method: "ensure",
        input: { sessionID: "ses_1" },
        options: { location: { directory: "/repo" } },
      })
    })
  })

  test("surfaces a missing document, a backfill need, and its estimate", async () => {
    const estimate = { messages: 4, chars: 400, chunks: 2, approxCalls: 2 }
    await runState(
      { ensure: async () => ({ document: null, busy: false, needsBackfill: true, estimate }) },
      async (state) => {
        await state.load()

        expect(state.document()).toBeNull()
        expect(state.needsBackfill()).toBe(true)
        expect(state.estimate()).toEqual(estimate)
      },
    )
  })

  test("surfaces a disabled reason and a document error", async () => {
    const error: TimelineError = { message: "boom", at: NOW, retryable: true, kind: "storage" }
    await runState(
      { ensure: async () => ({ document: null, busy: false, disabledReason: "Recap is disabled.", error }) },
      async (state) => {
        await state.load()

        expect(state.disabledReason()).toBe("Recap is disabled.")
        expect(state.error()).toEqual(error)
      },
    )
  })

  test("turns a malformed document into a request error", async () => {
    await runState({ ensure: async () => ({ document: { version: 99 }, busy: false }) }, async (state) => {
      await state.load()

      expect(state.document()).toBeNull()
      expect(state.requestError()).toBe("Recap returned an invalid document")
    })
  })

  test("refresh calls refresh and then ensure", async () => {
    await runState({}, async (state, fake) => {
      await state.refresh()

      expect(fake.calls.map((call) => call.method)).toEqual(["refresh", "ensure"])
    })
  })

  test("backfill returns the confirmation estimate without starting", async () => {
    const estimate = { messages: 12, chars: 12_000, chunks: 12, approxCalls: 12 }
    await runState(
      {
        backfill: async () => {
          throw { type: "confirmation_required", message: "This backfill needs confirmation.", data: estimate }
        },
      },
      async (state) => {
        const result = await state.backfill(false)

        expect(result).toEqual({ kind: "confirmation_required", estimate })
        expect(state.estimate()).toEqual(estimate)
      },
    )
  })

  test("a confirmed backfill starts and reloads", async () => {
    await runState({}, async (state, fake) => {
      const result = await state.backfill(true)
      await drain()

      expect(result).toEqual({ kind: "started" })
      expect(fake.calls.map((call) => call.method)).toEqual(["backfill", "ensure"])
      expect(fake.calls[0]?.input).toEqual({ sessionID: "ses_1", confirm: true })
    })
  })

  test("cancel calls the cancel method", async () => {
    await runState({}, async (state, fake) => {
      await state.cancel()

      expect(fake.calls.map((call) => call.method)).toEqual(["cancel", "ensure"])
    })
  })

  test("an updated event for this session reloads, other sessions do not", async () => {
    await runState({}, async (state, fake) => {
      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_other" } })
      await drain()
      expect(fake.calls).toHaveLength(0)

      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_1" } })
      await drain()
      expect(fake.calls.map((call) => call.method)).toEqual(["ensure"])
      expect(state.requestError()).toBeUndefined()
    })
  })

  test("an error event refetches ensure instead of setting requestError", async () => {
    await runState({}, async (state, fake) => {
      fake.handlers.get("error")?.[0]?.({ data: { sessionID: "ses_1" } })
      await drain()

      expect(fake.calls.map((call) => call.method)).toEqual(["ensure"])
      expect(state.requestError()).toBeUndefined()
    })
  })

  test("a progress event updates progress and refetches on a chapter-count change", async () => {
    await runState({}, async (state, fake) => {
      fake.handlers.get("progress")?.[0]?.({
        data: { sessionID: "ses_1", phase: "backfill", processed: 3, total: 10, chapters: 2 },
      })
      await drain()

      expect(state.progress()).toEqual({ phase: "backfill", processed: 3, total: 10, chapters: 2 })
      expect(fake.calls).toHaveLength(0)

      fake.handlers.get("progress")?.[0]?.({
        data: { sessionID: "ses_1", phase: "backfill", processed: 6, total: 10, chapters: 3 },
      })
      await drain()

      expect(state.progress()).toEqual({ phase: "backfill", processed: 6, total: 10, chapters: 3 })
      expect(fake.calls.map((call) => call.method)).toEqual(["ensure"])
    })
  })

  test("excerpt filters malformed items", async () => {
    const valid: ExcerptItem = {
      role: "user",
      at: NOW,
      text: "hello",
      messageID: "msg_1",
      isAnchor: true,
    }
    await runState(
      {
        excerpt: async () => ({
          items: [valid, { role: "user", at: NOW, text: "missing fields" }],
        }),
      },
      async (state) => {
        await expect(state.excerpt("msg_1")).resolves.toEqual([valid])
      },
    )
  })
})
