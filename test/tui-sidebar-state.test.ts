import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDocument } from "../src/shared/document"
import type { TimelineError } from "../src/shared/types"
import { createRecapState, type RecapState } from "../src/tui/sidebar-state"
import { TEST_MODEL } from "./helpers/engine"
import { fakeTui, type FakeRpc } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"

function document(sessionID = "ses_1") {
  return createDocument({
    sessionID,
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 2,
    now: NOW,
  })
}

function runState<T>(rpc: Partial<FakeRpc>, run: (state: RecapState, fake: ReturnType<typeof fakeTui>) => Promise<T>) {
  const fake = fakeTui(rpc)
  return new Promise<T>((resolve, reject) => {
    createRoot((dispose) => {
      void (async () => {
        try {
          const state = createRecapState(fake.context, "ses_1")
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

describe("createRecapState", () => {
  test("load calls get and never ensure", async () => {
    const loaded = document()
    await runState({ get: async () => ({ document: loaded, busy: true }) }, async (state, fake) => {
      await state.load()

      expect(state.document()).toEqual(loaded)
      expect(state.busy()).toBe(true)
      expect(state.loading()).toBe(false)
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]).toMatchObject({
        method: "get",
        input: { sessionID: "ses_1" },
        options: { location: { directory: "/repo" } },
      })
    })
  })

  test("surfaces a disabled reason and a document error", async () => {
    const error: TimelineError = { message: "boom", at: NOW, retryable: true, kind: "storage" }
    await runState(
      { get: async () => ({ document: null, busy: false, disabledReason: "Recap is disabled.", error }) },
      async (state) => {
        await state.load()

        expect(state.disabledReason()).toBe("Recap is disabled.")
        expect(state.error()).toEqual(error)
      },
    )
  })

  test("turns a malformed document into a request error", async () => {
    await runState({ get: async () => ({ document: { version: 99 }, busy: false }) }, async (state) => {
      await state.load()

      expect(state.document()).toBeNull()
      expect(state.requestError()).toBe("Recap returned an invalid document")
    })
  })

  test("an updated event for this session reloads, other sessions do not", async () => {
    await runState({}, async (state, fake) => {
      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_other" } })
      await drain()
      expect(fake.calls).toHaveLength(0)

      fake.handlers.get("updated")?.[0]?.({ data: { sessionID: "ses_1" } })
      await drain()
      expect(fake.calls.map((call) => call.method)).toEqual(["get"])
      expect(state.requestError()).toBeUndefined()
    })
  })

  test("an error event refetches get instead of setting requestError", async () => {
    await runState({}, async (state, fake) => {
      fake.handlers.get("error")?.[0]?.({ data: { sessionID: "ses_1" } })
      await drain()

      expect(fake.calls.map((call) => call.method)).toEqual(["get"])
      expect(state.requestError()).toBeUndefined()
    })
  })

  test("a progress event updates progress and refetches on a chapter-count change", async () => {
    const running = document()
    running.status = "backfilling"
    await runState({ get: async () => ({ document: running, busy: true }) }, async (state, fake) => {
      fake.handlers.get("progress")?.[0]?.({
        data: { sessionID: "ses_1", phase: "backfill", processed: 3, total: 10, chapters: 2 },
      })
      await drain()

      expect(state.progress()).toEqual({ phase: "backfill", processed: 3, total: 10, chapters: 2 })
      expect(state.busy()).toBe(true)
      expect(fake.calls).toHaveLength(0)

      fake.handlers.get("progress")?.[0]?.({
        data: { sessionID: "ses_1", phase: "backfill", processed: 6, total: 10, chapters: 3 },
      })
      await drain()

      expect(state.progress()).toEqual({ phase: "backfill", processed: 6, total: 10, chapters: 3 })
      expect(fake.calls.map((call) => call.method)).toEqual(["get"])
    })
  })

  test("a completed envelope clears live progress and busy", async () => {
    const ready = document()
    ready.status = "ready"
    await runState(
      {
        get: async () => ({ document: ready, busy: false }),
      },
      async (state, fake) => {
        fake.handlers.get("progress")?.[0]?.({
          data: { sessionID: "ses_1", phase: "backfill", processed: 3, total: 10, chapters: 1 },
        })
        await drain()
        expect(state.progress()).toBeDefined()

        await state.load()

        expect(state.progress()).toBeUndefined()
        expect(state.busy()).toBe(false)
      },
    )
  })
})
