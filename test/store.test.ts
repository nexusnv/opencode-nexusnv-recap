import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createDocument } from "../src/shared/document"
import type { TimelineDocument } from "../src/shared/types"
import { PluginTimelineStore } from "../src/server/store"

type StorageDomain = Plugin.Context["storage"]

class FakeStorage {
  readonly values = new Map<string, unknown>()
  failNextSet = false

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key)
    return value === undefined ? undefined : clone(value)
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error("disk full")
    }
    this.values.set(key, clone(value))
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key)
  }

  async scan(): Promise<never> {
    throw new Error("not used")
  }
}

function clone(value: unknown): unknown {
  return structuredClone(value)
}

function makeDocument(sessionID = "ses_1"): TimelineDocument {
  return createDocument({
    sessionID,
    sessionTitle: "Test",
    model: { providerID: "openai", modelID: "gpt-5-mini" },
    promptVersion: 1,
    now: "2026-10-29T10:00:00.000Z",
  })
}

function makeStore(): { storage: FakeStorage; store: PluginTimelineStore } {
  const storage = new FakeStorage()
  return { storage, store: new PluginTimelineStore(storage as unknown as StorageDomain) }
}

describe("PluginTimelineStore", () => {
  test("save then load round-trips a document", async () => {
    const { store } = makeStore()
    const doc = makeDocument()
    doc.goal = "Ship recap"
    await store.save(doc, "2026-10-29T10:01:00.000Z")

    const loaded = await store.load("ses_1")
    expect(loaded).toEqual(doc)
    expect(loaded?.goal).toBe("Ship recap")
  })

  test("uses the documented storage key", async () => {
    const { storage, store } = makeStore()
    await store.save(makeDocument(), "2026-10-29T10:01:00.000Z")
    expect([...storage.values.keys()]).toEqual(["recap/v1/session/ses_1"])
  })

  test("returns undefined for a missing key", async () => {
    const { store } = makeStore()
    expect(await store.load("ses_missing")).toBeUndefined()
  })

  test("returns undefined for corrupt documents", async () => {
    const { storage, store } = makeStore()
    const good = makeDocument()
    storage.values.set("recap/v1/session/wrong-version", { ...good, version: 2 })
    storage.values.set("recap/v1/session/unknown-key", { ...good, surprise: true })
    storage.values.set("recap/v1/session/bad-status", { ...good, status: "disabled" })

    expect(await store.load("wrong-version")).toBeUndefined()
    expect(await store.load("unknown-key")).toBeUndefined()
    expect(await store.load("bad-status")).toBeUndefined()
  })

  test("parses a JSON string value", async () => {
    const { storage, store } = makeStore()
    const doc = makeDocument()
    storage.values.set("recap/v1/session/ses_1", JSON.stringify(doc))
    expect(await store.load("ses_1")).toEqual(doc)
  })

  test("returns undefined for a malformed JSON string value", async () => {
    const { storage, store } = makeStore()
    storage.values.set("recap/v1/session/ses_1", "{not json")
    expect(await store.load("ses_1")).toBeUndefined()
  })

  test("save rejects when storage.set rejects and the previous value remains", async () => {
    const { storage, store } = makeStore()
    const doc = makeDocument()
    doc.goal = "first"
    await store.save(doc, "2026-10-29T10:01:00.000Z")

    doc.goal = "second"
    storage.failNextSet = true
    await expect(store.save(doc, "2026-10-29T10:02:00.000Z")).rejects.toThrow("disk full")

    const loaded = await store.load("ses_1")
    expect(loaded?.goal).toBe("first")
    expect(loaded?.meta.updatedAt).toBe("2026-10-29T10:01:00.000Z")
  })

  test("remove deletes the key", async () => {
    const { storage, store } = makeStore()
    await store.save(makeDocument(), "2026-10-29T10:01:00.000Z")
    await store.remove("ses_1")
    expect(storage.values.has("recap/v1/session/ses_1")).toBe(false)
    expect(await store.load("ses_1")).toBeUndefined()
  })

  test("save sets meta.updatedAt to the supplied now", async () => {
    const { store } = makeStore()
    const doc = makeDocument()
    await store.save(doc, "2026-10-29T12:34:56.000Z")
    expect(doc.meta.updatedAt).toBe("2026-10-29T12:34:56.000Z")
  })
})
