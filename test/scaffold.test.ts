import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { RPC_ID, SERVER_PLUGIN_ID, STORAGE_PREFIX, TUI_PLUGIN_ID } from "../src/shared/ids"

describe("scaffold", () => {
  test("ids are stable", () => {
    expect(SERVER_PLUGIN_ID).toBe("nexusnv.recap")
    expect(TUI_PLUGIN_ID).toBe("nexusnv.recap.tui")
    expect(RPC_ID).toBe("nexusnv.recap")
    expect(STORAGE_PREFIX).toBe("recap/v1/session")
  })

  test("package exports the three parts", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>
    }
    expect(pkg.exports["."]).toBe("./dist/index.js")
    expect(pkg.exports["./tui"]).toBe("./dist/tui.js")
    expect(pkg.exports["./rpc"]).toBe("./dist/rpc.js")
  })
})
