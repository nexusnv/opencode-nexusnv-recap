import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import type { TimelineConfig } from "../config.js"
import { clip, isRecord, redactSecrets, safeString } from "./text.js"

// Test/lint/typecheck/build commands for the spec's evidence `Checks` line.
// Heuristic on common runner names; a shipped plugin cannot know every runner.
const CHECK_COMMANDS =
  /\b(tests?|vitest|pytest|jest|mocha|phpunit|spec|lint|eslint|oxlint|biome|prettier|phpstan|psalm|typecheck|tsc|coverage|clippy|golangci|build)\b/

const PULL_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g
const COMMIT_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/commit\/[0-9a-fA-F]{7,40}/g
const GH_PR = /\bgh\s+pr\s+[a-z-]+[^\n]*/gi
const GIT_COMMIT = /\bgit\s+commit\b[^\n]*/gi

function isCheckCommand(command: unknown): boolean {
  const value = safeString(command)
  return value !== undefined && CHECK_COMMANDS.test(value)
}

export function buildEvidence(messages: readonly SessionMessageInfo[], config: TimelineConfig): string {
  const lines: string[] = []
  const files = new Set<string>()
  const commands = new Set<string>()
  const checks = new Map<string, "passed" | "failed">()
  const refs = new Set<string>()
  const todos: string[] = []

  for (const message of messages) {
    if (message.type === "shell") {
      commands.add(clip(message.command, 160))
      collectRefs(message.command, refs)
      // A running shell has no outcome yet. Recording it as failed would be
      // wrong, and recording it as passed would be premature.
      if (message.status !== "running" && isCheckCommand(message.command)) {
        const passed = message.status === "exited" && message.exit === 0
        checks.set(clip(message.command, 120), passed ? "passed" : "failed")
      }
      if (message.output) collectRefs(message.output.output, refs)
      continue
    }
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      const input = isRecord(part.state.input) ? part.state.input : {}
      const name = part.name
      if (name === "edit" || name === "write" || name === "patch") {
        const path = pathOf(input)
        if (path) files.add(path)
      }
      if (name === "shell" || name === "bash") {
        const command = safeString(input.command)
        if (command) {
          commands.add(clip(command, 160))
          collectRefs(command, refs)
        }
        const settled = part.state.status !== "running" && part.state.status !== "streaming"
        if (command && settled && isCheckCommand(command)) {
          checks.set(clip(command, 120), part.state.status === "error" ? "failed" : "passed")
        }
      }
      if (name === "todowrite" && Array.isArray(input.todos)) {
        for (const todo of input.todos.slice(0, 20)) {
          if (isRecord(todo) && typeof todo.content === "string") todos.push(clip(todo.content, 120))
        }
      }
      const text = toolText(part)
      if (text) collectRefs(text, refs)
    }
  }

  if (files.size) lines.push(`Files touched: ${[...files].slice(0, 20).join(", ")}`)
  if (commands.size) lines.push(`Commands: ${[...commands].slice(0, 20).join(" | ")}`)
  if (checks.size) {
    lines.push(
      `Checks: ${[...checks]
        .slice(0, 10)
        .map(([command, status]) => `${command} ${status}`)
        .join(" | ")}`,
    )
  }
  if (todos.length) lines.push(`Todos: ${todos.slice(0, 12).join(" | ")}`)
  if (refs.size) lines.push(`References: ${[...refs].slice(0, 20).join(" | ")}`)
  const text = lines.join("\n")
  return clip(config.digest.redact ? redactSecrets(text) : text, 2_000)
}

function collectRefs(text: string, refs: Set<string>): void {
  for (const pattern of [PULL_URL, COMMIT_URL, GH_PR, GIT_COMMIT]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const value = match[0]?.trim()
      if (value) refs.add(value)
    }
  }
}

function toolText(part: SessionMessageAssistantTool): string {
  if (part.state.status === "streaming" || part.state.status === "running") {
    return ""
  }
  const content = "content" in part.state && part.state.content ? part.state.content : []
  const text = content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n")
  if (part.state.status === "error") return `${text}\n${part.state.error.message}`.trim()
  return text
}

function pathOf(input: Record<string, unknown>): string | undefined {
  return (
    safeString(input.filePath) ??
    safeString(input.file_path) ??
    safeString(input.path) ??
    safeString(input.target) ??
    undefined
  )
}
