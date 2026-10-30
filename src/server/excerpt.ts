import type { SessionMessageInfo } from "@opencode/client"
import type { TimelineConfig } from "../config.js"
import type { ExcerptItem } from "../shared/types.js"
import { clip, isRecord, redactSecrets, safeString } from "./text.js"

const EXCERPT_TEXT_LIMIT = 2_000
const EXCERPT_TOOL_LIMIT = 400
const ROUTINE_READ_TOOLS = new Set(["read", "grep", "glob", "find", "list", "ls"])
const SIDE_EFFECT_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "shell",
  "bash",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
])

type ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string }

type ToolPart = {
  type: "tool"
  name: string
  state:
    | { status: "streaming" | "running"; input: unknown }
    | { status: "completed"; input: unknown; content: ToolContent[] }
    | { status: "error"; input: unknown; error: { message: string } }
}

export function buildExcerpt(
  messages: readonly SessionMessageInfo[],
  anchorMessageID: string,
  _config: TimelineConfig,
): ExcerptItem[] {
  const index = messages.findIndex((message) => message.id === anchorMessageID)
  if (index < 0) return []

  const anchor = messages[index]
  if (!anchor) return []

  const before = new Map<number, ExcerptItem[]>()
  const anchorItems = new Map<number, ExcerptItem[]>()
  const after = new Map<number, ExcerptItem[]>()

  // If the anchor itself is a user message, do not add the previous user turn:
  // the anchor already supplies the instruction context.
  if (anchor.type !== "user") {
    const userIndex = findUserBefore(messages, index)
    if (userIndex >= 0) addItems(before, messages, userIndex, false)
  }

  addItems(anchorItems, messages, index, true)

  const conclusionIndex = findAssistantAfter(messages, index)
  if (conclusionIndex >= 0) addItems(after, messages, conclusionIndex, false)

  const beforeItems = flatten(before)
  const middleItems = flatten(anchorItems)
  const afterItems = flatten(after)

  // Reserve one slot for the conclusion so a tool-heavy anchor cannot push the
  // outcome out of the excerpt. The anchor's own first item always survives.
  const reserve = afterItems.length > 0 ? 1 : 0
  const middleBudget = Math.max(1, 5 - beforeItems.length - reserve)
  const items = [...beforeItems, ...middleItems.slice(0, middleBudget), ...afterItems]
  return dedupe(items).slice(0, 5)
}

function flatten(selected: Map<number, ExcerptItem[]>): ExcerptItem[] {
  return [...selected.entries()].toSorted((a, b) => a[0] - b[0]).flatMap(([, entries]) => entries)
}

function dedupe(items: readonly ExcerptItem[]): ExcerptItem[] {
  const seen = new Set<string>()
  const result: ExcerptItem[] = []
  for (const item of items) {
    const key = `${item.messageID}:${item.role}:${item.text}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function findUserBefore(messages: readonly SessionMessageInfo[], index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]?.type === "user") return cursor
  }
  return -1
}

function findAssistantAfter(messages: readonly SessionMessageInfo[], index: number): number {
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const message = messages[cursor]
    // Do not cross into the next user turn: that assistant message answers a
    // different instruction and is not this anchor's conclusion.
    if (message?.type === "user") return -1
    if (message?.type === "assistant" && message.content.some((part) => part.type === "text" && part.text.trim())) {
      return cursor
    }
  }
  return -1
}

function addItems(
  selected: Map<number, ExcerptItem[]>,
  messages: readonly SessionMessageInfo[],
  index: number,
  anchor: boolean,
): void {
  const message = messages[index]
  if (!message) return
  const items = selected.get(index) ?? []
  const at = new Date(message.time.created).toISOString()

  if (message.type === "user") {
    items.push({
      role: "user",
      at,
      text: redactSecrets(clip(message.text, EXCERPT_TEXT_LIMIT)),
      messageID: message.id,
      isAnchor: anchor,
    })
  } else if (message.type === "assistant") {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) {
      items.push({
        role: "assistant",
        at,
        text: redactSecrets(clip(text, EXCERPT_TEXT_LIMIT)),
        messageID: message.id,
        isAnchor: anchor,
      })
    }
    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (!includeTool(part)) continue
      items.push({
        role: "tool",
        at,
        text: redactSecrets(clip(toolText(part), EXCERPT_TEXT_LIMIT)),
        messageID: message.id,
        isAnchor: anchor && items.length === 0,
      })
    }
  } else if (message.type === "shell") {
    const output =
      message.output && !/^(cat|head|tail|less|sed\s+-n)\b/.test(message.command)
        ? `\n${clip(message.output.output, EXCERPT_TOOL_LIMIT)}`
        : ""
    items.push({
      role: "tool",
      at,
      text: redactSecrets(`shell ${message.status}: ${message.command}${output}`),
      messageID: message.id,
      isAnchor: anchor,
    })
  } else if (message.type === "compaction" && message.status === "completed") {
    items.push({
      role: "system",
      at,
      text: redactSecrets(clip(message.summary, EXCERPT_TEXT_LIMIT)),
      messageID: message.id,
      isAnchor: anchor,
    })
  }

  if (items.length > 0) selected.set(index, items)
}

function includeTool(part: ToolPart): boolean {
  if (part.state.status === "error") return true
  if (part.state.status === "running" || part.state.status === "streaming") return true
  return SIDE_EFFECT_TOOLS.has(part.name) || !ROUTINE_READ_TOOLS.has(part.name)
}

function toolText(part: ToolPart): string {
  const input = isRecord(part.state.input) ? part.state.input : {}
  const path = safeString(input.filePath) ?? safeString(input.path) ?? safeString(input.file_path)
  const command = safeString(input.command)
  const summary = path ? ` ${path}` : command ? ` ${clip(command, 120)}` : ""
  const output =
    part.state.status === "completed"
      ? part.state.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n")
      : part.state.status === "error"
        ? part.state.error.message
        : ""
  return `tool ${part.name} ${part.state.status}${summary}\n${clip(output, EXCERPT_TOOL_LIMIT)}`.trim()
}
