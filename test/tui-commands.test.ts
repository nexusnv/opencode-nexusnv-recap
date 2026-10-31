import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { PANEL_NAME } from "../src/shared/ids"
import { TimelineCommands } from "../src/tui/commands"
import { fakeTui, panelInput, type FakeTuiOptions } from "./helpers/tui"

function commandFor(options: FakeTuiOptions = {}, overrides: Parameters<typeof fakeTui>[0] = {}) {
  const fake = fakeTui(overrides, options)
  createRoot((dispose) => {
    TimelineCommands({ context: fake.context })
    dispose()
  })
  const command = fake.keymapCommands().find((entry) => entry.id === "recap.panel.open")
  if (!command) throw new Error("recap command was not registered")
  return { fake, command }
}

describe("TimelineCommands", () => {
  test("registers the recap command in the palette and slash completion without a keybind", () => {
    const { command } = commandFor()

    expect(command.id).toBe("recap.panel.open")
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

  test("opens the panel on a session route", () => {
    const { fake, command } = commandFor()
    command.run()

    expect(fake.uiCalls.panelOpen).toEqual([{ name: PANEL_NAME, options: undefined }])
    expect(fake.uiCalls.toasts).toHaveLength(0)
  })

  test("closes the panel when it is already open", () => {
    const { fake, command } = commandFor({ currentPanel: panelInput({ name: PANEL_NAME }) })
    command.run()

    expect(fake.uiCalls.panelClose).toBe(1)
    expect(fake.uiCalls.panelOpen).toHaveLength(0)
  })

  test("opens the panel when it is already open on another session", () => {
    const { fake, command } = commandFor({
      currentPanel: panelInput({ name: PANEL_NAME, sessionID: "ses_2" }),
    })
    command.run()

    expect(fake.uiCalls.panelClose).toBe(0)
    expect(fake.uiCalls.panelOpen).toEqual([{ name: PANEL_NAME, options: undefined }])
  })

  test("warns on a non-session route", () => {
    const { fake, command } = commandFor({ route: { type: "home" } })
    command.run()

    expect(fake.uiCalls.panelOpen).toHaveLength(0)
    expect(fake.uiCalls.toasts).toEqual([{ message: "Open a session first", variant: "warning" }])
  })

  test("warns on a child session", () => {
    const { fake, command } = commandFor({ session: { parentID: "ses_parent" } })
    command.run()

    expect(fake.uiCalls.panelOpen).toHaveLength(0)
    expect(fake.uiCalls.toasts).toEqual([{ message: "Recap is available for root sessions", variant: "warning" }])
  })
})
