import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { DEFAULT_BACKFILL, DEFAULT_DIGEST, DEFAULT_LIMITS, DEFAULT_UPDATE, type TimelineConfig } from "../src/config"
import { buildExcerpt } from "../src/server/excerpt"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

const CONFIG: TimelineConfig = {
  enabled: true,
  model: { providerID: "openai", modelID: "gpt-5-mini" },
  update: DEFAULT_UPDATE,
  backfill: DEFAULT_BACKFILL,
  digest: DEFAULT_DIGEST,
  limits: DEFAULT_LIMITS,
}

let sequence = 0

function nextID(prefix: string): string {
  sequence += 1
  return `${prefix}_${sequence}`
}

function user(text: string, createdAt = BASE_TIME): SessionMessageInfo {
  return { id: nextID("user"), time: { created: createdAt }, type: "user", text }
}

function assistant(content: SessionMessageAssistant["content"], createdAt = BASE_TIME): SessionMessageInfo {
  return {
    id: nextID("assistant"),
    time: { created: createdAt },
    type: "assistant",
    agent: "build",
    model: { id: "gpt-5-mini", providerID: "openai" },
    content,
  }
}

function shell(
  command: string,
  status: "running" | "exited",
  output?: string,
  createdAt = BASE_TIME,
): SessionMessageInfo {
  return {
    id: nextID("shell"),
    time: { created: createdAt },
    type: "shell",
    shellID: "sh_1",
    command,
    status,
    ...(output === undefined ? {} : { output: { output, cursor: 0, size: output.length, truncated: false } }),
  }
}

function compaction(summary: string, createdAt = BASE_TIME): SessionMessageInfo {
  return {
    id: nextID("compaction"),
    time: { created: createdAt },
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary,
  }
}

function tool(
  name: string,
  state: SessionMessageAssistantTool["state"],
  id = nextID("tool"),
): SessionMessageAssistantTool {
  return { type: "tool", id, name, state, time: { created: BASE_TIME } }
}

type ToolContentInput = Array<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string }>

function completed(input: Record<string, unknown>, content: ToolContentInput): SessionMessageAssistantTool["state"] {
  return { status: "completed", input: input as never, content: content as never }
}

function textPart(value: string): { type: "text"; text: string } {
  return { type: "text", text: value }
}

describe("buildExcerpt", () => {
  test("includes the nearest user turn, the anchor, and a following conclusion", () => {
    const prompt = user("build the feature")
    const anchor = assistant([
      textPart("implemented it"),
      tool("edit", completed({ filePath: "src/a.ts" }, [textPart("wrote a.ts")])),
    ])
    const next = user("next request")
    const answer = assistant([textPart("answered next")])
    const items = buildExcerpt([prompt, anchor, next, answer], anchor.id, CONFIG)

    expect(items.map((item) => item.role)).toEqual(["user", "assistant", "tool"])
    expect(items.map((item) => item.text)).toEqual([
      "build the feature",
      "implemented it",
      expect.stringContaining("src/a.ts"),
    ])
    expect(items.map((item) => item.isAnchor)).toEqual([false, true, false])
    expect(items.every((item) => item.messageID === prompt.id || item.messageID === anchor.id)).toBe(true)
  })

  test("adds the assistant conclusion after a user anchor", () => {
    const first = user("first")
    const firstAnswer = assistant([textPart("first answer")])
    const anchor = user("anchor request")
    const conclusion = assistant([textPart("anchor conclusion")])
    const items = buildExcerpt([first, firstAnswer, anchor, conclusion], anchor.id, CONFIG)

    expect(items.map((item) => item.role)).toEqual(["user", "assistant"])
    expect(items[0]?.text).toBe("anchor request")
    expect(items[1]?.text).toBe("anchor conclusion")
    expect(items[0]?.isAnchor).toBe(true)
    expect(items[1]?.isAnchor).toBe(false)
  })

  test("handles an anchor that is the first message", () => {
    const anchor = user("first message")
    const answer = assistant([textPart("reply")])
    const items = buildExcerpt([anchor, answer], anchor.id, CONFIG)

    expect(items.map((item) => item.role)).toEqual(["user", "assistant"])
    expect(items[0]?.isAnchor).toBe(true)
  })

  test("handles an anchor that is the last message", () => {
    const prompt = user("prompt")
    const answer = assistant([textPart("answer")])
    const anchor = user("last message")
    const items = buildExcerpt([prompt, answer, anchor], anchor.id, CONFIG)

    expect(items).toHaveLength(1)
    expect(items[0]?.messageID).toBe(anchor.id)
    expect(items[0]?.isAnchor).toBe(true)
  })

  test("never includes assistant reasoning parts", () => {
    const anchor = assistant([{ type: "reasoning", text: "SECRET REASONING" }, textPart("visible answer")])
    const items = buildExcerpt([anchor], anchor.id, CONFIG)

    expect(items).toHaveLength(1)
    expect(items[0]?.text).toBe("visible answer")
    expect(items.some((item) => item.text.includes("SECRET REASONING"))).toBe(false)
  })

  test("shows side-effecting tools and excludes routine reads and file parts", () => {
    const anchor = assistant([
      textPart("work done"),
      tool(
        "edit",
        completed({ filePath: "src/a.ts" }, [
          textPart("changed file"),
          { type: "file", uri: "data:image/png;base64,AAA", mime: "image/png" },
        ]),
      ),
      tool("read", completed({ filePath: "src/b.ts" }, [textPart("READ_SECRET")])),
      tool("grep", completed({ pattern: "needle" }, [textPart("GREP_SECRET")])),
      tool("glob", completed({ pattern: "**/*.ts" }, [textPart("GLOB_SECRET")])),
      tool("write", {
        status: "error",
        input: { filePath: "src/c.ts" },
        error: { type: "error", message: "WRITE_ERROR" },
      }),
    ])
    const items = buildExcerpt([anchor], anchor.id, CONFIG)

    const toolItems = items.filter((item) => item.role === "tool")
    expect(toolItems).toHaveLength(2)
    expect(toolItems[0]?.text).toContain("tool edit completed src/a.ts")
    expect(toolItems[0]?.text).toContain("changed file")
    expect(toolItems[0]?.text).not.toContain("AAA")
    expect(toolItems[1]?.text).toContain("tool write error src/c.ts")
    expect(toolItems[1]?.text).toContain("WRITE_ERROR")
    expect(items.some((item) => item.text.includes("READ_SECRET"))).toBe(false)
    expect(items.some((item) => item.text.includes("GREP_SECRET"))).toBe(false)
    expect(items.some((item) => item.text.includes("GLOB_SECRET"))).toBe(false)
  })

  test("clips user and assistant text to 2000 characters", () => {
    const anchor = user("u".repeat(2_500))
    const answer = assistant([textPart("a".repeat(2_500))])
    const items = buildExcerpt([anchor, answer], anchor.id, CONFIG)

    expect(items).toHaveLength(2)
    expect(items[0]?.text).toHaveLength(2_000)
    expect(items[1]?.text).toHaveLength(2_000)
  })

  test("returns an empty list when the anchor is not in the transcript", () => {
    const only = user("hello")
    expect(buildExcerpt([only], "missing", CONFIG)).toEqual([])
  })

  test("deduplicates identical items from the same message", () => {
    const state = completed({ filePath: "src/a.ts" }, [textPart("changed")])
    const anchor = assistant([tool("edit", state, "tool_1"), tool("edit", state, "tool_2")])
    const items = buildExcerpt([anchor], anchor.id, CONFIG)

    expect(items).toHaveLength(1)
    expect(items[0]?.role).toBe("tool")
    expect(items[0]?.isAnchor).toBe(true)
  })

  test("marks only the first item of the anchor message as the anchor", () => {
    const prompt = user("prompt")
    const anchor = assistant([
      textPart("summary"),
      tool("edit", completed({ filePath: "src/a.ts" }, [textPart("changed")])),
    ])
    const items = buildExcerpt([prompt, anchor], anchor.id, CONFIG)

    expect(items.map((item) => item.isAnchor)).toEqual([false, true, false])
  })

  test("orders items by message time", () => {
    const prompt = user("prompt", BASE_TIME)
    const anchor = assistant([textPart("anchor")], BASE_TIME + 1_000)
    const conclusion = assistant([textPart("conclusion")], BASE_TIME + 2_000)
    const items = buildExcerpt([prompt, anchor, conclusion], anchor.id, CONFIG)

    expect(items.map((item) => item.at)).toEqual([
      new Date(BASE_TIME).toISOString(),
      new Date(BASE_TIME + 1_000).toISOString(),
      new Date(BASE_TIME + 2_000).toISOString(),
    ])
  })

  test("renders shell and compaction items as tool and system roles", () => {
    const prompt = user("prompt")
    const shellMessage = shell("npm test", "exited", "all green", BASE_TIME + 1_000)
    const compacted = compaction("Earlier work summary", BASE_TIME + 2_000)
    const answer = assistant([textPart("done")], BASE_TIME + 3_000)

    const shellItems = buildExcerpt([prompt, shellMessage, answer], shellMessage.id, CONFIG)
    expect(shellItems.map((item) => item.role)).toEqual(["user", "tool", "assistant"])
    expect(shellItems[1]?.text).toContain("shell exited: npm test")
    expect(shellItems[1]?.text).toContain("all green")

    const compactionItems = buildExcerpt([prompt, compacted, answer], compacted.id, CONFIG)
    expect(compactionItems.map((item) => item.role)).toEqual(["user", "system", "assistant"])
    expect(compactionItems[1]?.text).toBe("Earlier work summary")
  })

  test("redacts secrets from excerpt text", () => {
    const secret = user("use sk-abcdefghijklmnopqrstuvwxyz123456 to call")
    const items = buildExcerpt([secret], secret.id, CONFIG)

    expect(items[0]?.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(items[0]?.text).toContain("[REDACTED]")
  })
})
