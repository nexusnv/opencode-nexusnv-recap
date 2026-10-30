import { afterAll, describe, expect, test } from "bun:test"
import { Host } from "@opencode/plugin/host"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const consumerRoot = mkdtempSync(join(tmpdir(), "recap-consumer-"))
const installedRoot = join(consumerRoot, "node_modules", "opencode-nexusnv-recap")
mkdirSync(join(consumerRoot, "node_modules"), { recursive: true })
symlinkSync(root, installedRoot, process.platform === "win32" ? "junction" : "dir")

const directoryEntrypoints = Host.resolve({ directory: root })
const packageEntrypoints = Host.resolve({ directory: consumerRoot, name: "opencode-nexusnv-recap" })

afterAll(() => rmSync(consumerRoot, { recursive: true, force: true }))

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} entrypoint did not resolve`)
  return value
}

interface PluginModule {
  readonly default?: {
    readonly id?: unknown
    readonly setup?: unknown
  }
}

interface RpcModule {
  readonly TimelineRpc?: {
    readonly id?: unknown
  }
}

const targets = [
  ["directory", directoryEntrypoints],
  ["package", packageEntrypoints],
] as const

describe("plugin host contract", () => {
  test("directory targets resolve the source entrypoints", () => {
    expect(directoryEntrypoints.server).toEndWith("/index.ts")
    expect(directoryEntrypoints.tui).toEndWith("/tui.tsx")
    expect(directoryEntrypoints.rpc).toEndWith("/rpc.ts")
  })

  test("package targets resolve the compiled entrypoints", () => {
    expect(packageEntrypoints.server).toEndWith("/dist/index.js")
    expect(packageEntrypoints.tui).toEndWith("/dist/tui.js")
    expect(packageEntrypoints.rpc).toEndWith("/dist/rpc.js")
  })

  for (const [label, entrypoints] of targets) {
    test(`${label} server entrypoint exports the plugin definition`, async () => {
      const module = (await Host.load(required(entrypoints.server, "server"))) as PluginModule

      expect(module.default?.id).toBe("nexusnv.recap")
      expect(typeof module.default?.setup).toBe("function")
    })

    test(`${label} TUI entrypoint exports the plugin definition`, async () => {
      const module = (await Host.load(required(entrypoints.tui, "tui"))) as PluginModule

      expect(module.default?.id).toBe("nexusnv.recap.tui")
      expect(typeof module.default?.setup).toBe("function")
    })

    test(`${label} RPC entrypoint exports the portable contract`, async () => {
      const module = (await Host.load(required(entrypoints.rpc, "rpc"))) as RpcModule

      expect(module.TimelineRpc?.id).toBe("nexusnv.recap")
    })
  }
})
