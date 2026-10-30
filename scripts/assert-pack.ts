import { access } from "node:fs/promises"

const required = ["dist/index.js", "dist/tui.js", "dist/rpc.js"]
for (const file of required) {
  await access(file)
}

const pkg = (await Bun.file("package.json").json()) as {
  exports: Record<string, string>
  files: string[]
}
for (const [name, target] of Object.entries(pkg.exports)) {
  if (!target.startsWith("./dist/")) throw new Error(`export ${name} does not point at dist: ${target}`)
}
for (const entry of ["dist/", "src/", "index.ts", "tui.tsx", "rpc.ts", "README.md", "LICENSE"]) {
  if (!pkg.files.includes(entry)) throw new Error(`package files is missing ${entry}`)
}

console.error("pack check ok")
