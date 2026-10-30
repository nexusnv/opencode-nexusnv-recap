import { expect, test } from "bun:test"
import { file } from "bun"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const HOST_RUNTIME = /^(?:solid-js(?:\/store)?|@opentui\/(?:core|solid)(?:\/.*)?|@opencode\/plugin\/tui(?:\/.*)?)$/
const FROM = /(?:^|\W)(?:import|export)\s+(?!type\b)[^"'`]*?\bfrom\s*["']([^"']+)["']/
const SIDE_EFFECT = /^\s*import\s*["']([^"']+)["']/
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/

function hostRuntimeImport(line: string): string | undefined {
  for (const pattern of [FROM, SIDE_EFFECT, DYNAMIC]) {
    const specifier = pattern.exec(line)?.[1]
    if (specifier && HOST_RUNTIME.test(specifier)) return specifier
  }
  return undefined
}

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [entryPath] : []
  })
}

test("TUI state uses .tsx so the host Solid transform applies", async () => {
  expect(await file("src/tui/state.ts").exists()).toBe(false)
  expect(await file("src/tui/state.tsx").exists()).toBe(true)
})

test("host runtime matcher allows type-only imports", () => {
  expect(hostRuntimeImport('import type { Context } from "@opencode/plugin/tui/context"')).toBeUndefined()
  expect(hostRuntimeImport('import { createSignal } from "solid-js"')).toBe("solid-js")
})

test("host runtime imports appear only in .tsx sources", () => {
  const violations: string[] = []
  // Root-level entry files join the scan: `index.ts` exists from Task 1, and
  // `rpc.ts` arrives in Task 20 — scan both so the rule keeps covering them.
  const paths = [sourceFiles(resolve(root, "src")), resolve(root, "index.ts"), resolve(root, "rpc.ts")].flat()
  for (const path of paths) {
    if (!existsSync(path)) continue
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      const specifier = hostRuntimeImport(line)
      if (specifier) violations.push(`${relative(root, path)}:${index + 1}: ${specifier}`)
    }
  }
  expect(violations).toEqual([])
})
