import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDocument } from "../src/shared/document"
import type { TimelineDocument } from "../src/shared/types"
import { TimelineCommands } from "../src/tui/commands"
import { TEST_MODEL } from "./helpers/engine"
import { fakeTui, type FakeTuiOptions } from "./helpers/tui"

const NOW = "2026-10-29T10:00:00.000Z"

interface MenuOption {
  title: string
  value: string
  disabled?: boolean
}

function document(overrides: Partial<TimelineDocument> = {}): TimelineDocument {
  const value = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test session",
    model: TEST_MODEL,
    promptVersion: 2,
    now: NOW,
  })
  value.status = "ready"
  value.watermark = { messageID: "msg_last", createdAt: NOW, messageCount: 4 }
  return { ...value, ...overrides }
}

function commandFor(options: FakeTuiOptions = {}, overrides: Parameters<typeof fakeTui>[0] = {}) {
  const fake = fakeTui(overrides, options)
  createRoot((dispose) => {
    TimelineCommands({ context: fake.context })
    dispose()
  })
  const command = fake.keymapCommands().find((entry) => entry.id === "recap.actions")
  if (!command) throw new Error("recap command was not registered")
  return { fake, command }
}

function menu(fake: ReturnType<typeof fakeTui>): MenuOption[] {
  const call = fake.uiCalls.selects[0] as { options: MenuOption[] } | undefined
  if (!call) throw new Error("the action menu did not open")
  return call.options
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

describe("TimelineCommands", () => {
  test("registers the recap action menu in the palette and slash completion without a keybind", () => {
    const { command } = commandFor()

    expect(command.id).toBe("recap.actions")
    expect(command.palette).toBe(true)
    expect(command.slash).toEqual({ name: "recap" })
    expect(command.bind).toBeUndefined()
  })

  test("is enabled only on a session route", () => {
    const { command } = commandFor()
    const enabled = typeof command.enabled === "function" ? command.enabled() : command.enabled
    expect(enabled).toBe(true)

    const { command: home } = commandFor({ route: { type: "home" } })
    const homeEnabled = typeof home.enabled === "function" ? home.enabled() : home.enabled
    expect(homeEnabled).toBe(false)
  })

  test("warns on a non-session route", async () => {
    const { fake, command } = commandFor({ route: { type: "home" } })
    await command.run()

    expect(fake.uiCalls.selects).toHaveLength(0)
    expect(fake.uiCalls.toasts).toEqual([{ message: "Open a session first", variant: "warning" }])
  })

  test("warns on a child session", async () => {
    const { fake, command } = commandFor({ session: { parentID: "ses_parent" } })
    await command.run()

    expect(fake.uiCalls.selects).toHaveLength(0)
    expect(fake.uiCalls.toasts).toEqual([{ message: "Recap is available for root sessions", variant: "warning" }])
  })

  test("shows disabled actions that do not apply to a ready document", async () => {
    const { fake, command } = commandFor({}, { get: async () => ({ document: document(), busy: false }) })
    await command.run()

    expect(menu(fake).map((option) => [option.title, option.disabled === true])).toEqual([
      ["Build", true],
      ["Resume", true],
      ["Refresh", false],
      ["Rebuild", false],
      ["Cancel", true],
    ])
  })

  test("builds an unbuilt recap", async () => {
    const { fake, command } = commandFor(
      { select: (options) => (options as { options: MenuOption[] }).options[0]?.value },
      { get: async () => ({ document: null, busy: false }) },
    )
    await command.run()
    await drain()

    expect(fake.calls.find((call) => call.method === "backfill")?.input).toEqual({
      sessionID: "ses_1",
      confirm: false,
    })
  })

  test("confirms a large build and retries with confirm true", async () => {
    const estimate = { messages: 12, chars: 12_000, chunks: 12, approxCalls: 12 }
    const { fake, command } = commandFor(
      { select: (options) => (options as { options: MenuOption[] }).options[0]?.value },
      {
        get: async () => ({ document: null, busy: false }),
        backfill: async (input) => {
          if ((input as { confirm: boolean }).confirm) return { started: true, estimate }
          throw { type: "confirmation_required", message: "Needs confirmation", data: estimate }
        },
      },
    )
    await command.run()
    await drain()

    expect(fake.uiCalls.confirms).toHaveLength(1)
    expect(fake.calls.filter((call) => call.method === "backfill").map((call) => call.input)).toEqual([
      { sessionID: "ses_1", confirm: false },
      { sessionID: "ses_1", confirm: true },
    ])
  })

  test("resumes a paused backfill", async () => {
    const paused = document({
      status: "paused",
      backfill: { processedMessages: 5, totalMessages: 10, startedAt: NOW, cancelled: true },
    })
    const { fake, command } = commandFor(
      { select: (options) => (options as { options: MenuOption[] }).options[1]?.value },
      { get: async () => ({ document: paused, busy: false }) },
    )
    await command.run()
    await drain()

    expect(fake.calls.find((call) => call.method === "backfill")?.input).toEqual({
      sessionID: "ses_1",
      confirm: false,
    })
  })

  test("refreshes a ready recap", async () => {
    const { fake, command } = commandFor(
      { select: (options) => (options as { options: MenuOption[] }).options[2]?.value },
      { get: async () => ({ document: document(), busy: false }) },
    )
    await command.run()
    await drain()

    expect(fake.calls.map((call) => call.method)).toContain("refresh")
  })

  test("rebuilds a ready recap", async () => {
    const { fake, command } = commandFor(
      { select: (options) => (options as { options: MenuOption[] }).options[3]?.value },
      { get: async () => ({ document: document(), busy: false }) },
    )
    await command.run()
    await drain()

    expect(fake.calls.find((call) => call.method === "rebuild")?.input).toEqual({
      sessionID: "ses_1",
      confirm: false,
    })
  })

  test("cancels a running build", async () => {
    const running = document({ status: "backfilling" })
    const { fake, command } = commandFor(
      { select: (options) => (options as { options: MenuOption[] }).options[4]?.value },
      { get: async () => ({ document: running, busy: true }) },
    )
    await command.run()
    await drain()

    expect(fake.calls.map((call) => call.method)).toContain("cancel")
  })

  test("keeps refresh available during an incremental update", async () => {
    const { fake, command } = commandFor({}, { get: async () => ({ document: document(), busy: true }) })
    await command.run()

    expect(menu(fake).find((option) => option.title === "Refresh")?.disabled).toBe(false)
    expect(menu(fake).find((option) => option.title === "Cancel")?.disabled).toBe(false)
  })

  test("disables refresh for a history-changed notice", async () => {
    const changed = document({ status: "stale" })
    changed.meta.notice = { kind: "history-changed", message: "History changed; rebuild required.", at: NOW }
    const { fake, command } = commandFor({}, { get: async () => ({ document: changed, busy: false }) })
    await command.run()

    expect(menu(fake).find((option) => option.title === "Refresh")?.disabled).toBe(true)
    expect(menu(fake).find((option) => option.title === "Rebuild")?.disabled).toBe(false)
  })

  test("shows a disabled reason without opening the menu", async () => {
    const { fake, command } = commandFor(
      {},
      { get: async () => ({ document: null, busy: false, disabledReason: "Recap is disabled." }) },
    )
    await command.run()

    expect(fake.uiCalls.selects).toHaveLength(0)
    expect(fake.uiCalls.toasts).toEqual([{ message: "Recap is disabled.", variant: "warning" }])
  })

  test("reports a failed get", async () => {
    const { fake, command } = commandFor(
      {},
      {
        get: async () => {
          throw new Error("transport exploded")
        },
      },
    )
    await command.run()

    expect(fake.uiCalls.selects).toHaveLength(0)
    expect(fake.uiCalls.toasts).toEqual([{ message: "transport exploded", variant: "error" }])
  })
})
