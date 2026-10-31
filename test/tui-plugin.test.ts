import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import plugin from "../tui"

describe("TUI plugin", () => {
  test("registers the recap sidebar and never a session panel", () => {
    const slots: Array<{ append: string }> = []
    plugin.setup({
      ui: {
        slot(input: { append: string }) {
          slots.push(input)
        },
      },
    } as unknown as Context)

    expect(plugin.id).toBe("nexusnv.recap.tui")
    expect(slots.map((slot) => slot.append)).toEqual(["sidebar.content", "app"])
  })
})
