import { rm } from "node:fs/promises"
import solid from "@opentui/solid/bun-plugin"

await rm("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  external: [
    "@opencode/plugin",
    "@opencode/plugin/*",
    "@opencode/theme",
    "@opencode/theme/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/solid",
    "@opentui/solid/*",
    "solid-js",
    "solid-js/*",
  ],
  plugins: [solid],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error("build failed")
}

console.error(`build ok: ${result.outputs.length} files in dist`)
