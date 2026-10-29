import { describe, expect, test } from "bun:test"
import type {
  PromptFileAttachment,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import {
  DEFAULT_BACKFILL,
  DEFAULT_DIGEST,
  DEFAULT_LIMITS,
  DEFAULT_UPDATE,
  type DigestConfig,
  type TimelineConfig,
} from "../src/config"
import { buildDigest } from "../src/server/digest"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

function makeConfig(overrides: Partial<DigestConfig> = {}): TimelineConfig {
  return {
    enabled: true,
    model: { providerID: "openai", modelID: "gpt-5-mini" },
    update: DEFAULT_UPDATE,
    backfill: DEFAULT_BACKFILL,
    digest: { ...DEFAULT_DIGEST, ...overrides },
    limits: DEFAULT_LIMITS,
  }
}

let sequence = 0

function messageID(prefix = "msg"): string {
  sequence += 1
  return `${prefix}_${sequence}`
}

function at(offset = 0): number {
  return BASE_TIME + offset
}

function user(
  text: string,
  options: { id?: string; files?: PromptFileAttachment[]; createdAt?: number } = {},
): SessionMessageInfo {
  return {
    id: options.id ?? messageID("user"),
    time: { created: options.createdAt ?? at() },
    type: "user",
    text,
    ...(options.files ? { files: options.files } : {}),
  }
}

function assistant(
  content: SessionMessageAssistant["content"],
  options: { id?: string; createdAt?: number } = {},
): SessionMessageInfo {
  return {
    id: options.id ?? messageID("assistant"),
    time: { created: options.createdAt ?? at() },
    type: "assistant",
    agent: "build",
    model: { id: "gpt-5-mini", providerID: "openai" },
    content,
  }
}

function tool(
  name: string,
  state: SessionMessageAssistantTool["state"],
  id = messageID("tool"),
): SessionMessageAssistantTool {
  return { type: "tool", id, name, state, time: { created: at() } }
}

type ToolContentInput = Array<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string }>

function completed(input: Record<string, unknown>, content: ToolContentInput): SessionMessageAssistantTool["state"] {
  return { status: "completed", input: input as never, content: content as never }
}

function textResult(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }]
}

function shell(
  command: string,
  status: "running" | "exited" | "timeout" | "killed",
  exit: number | undefined,
  output: string | undefined,
  offset = 0,
): SessionMessageInfo {
  return {
    id: messageID("shell"),
    time: { created: at(offset) },
    type: "shell",
    shellID: "sh_1",
    command,
    status,
    ...(exit !== undefined ? { exit } : {}),
    ...(output !== undefined ? { output: { output, cursor: 0, size: output.length, truncated: false } } : {}),
  }
}

function compaction(summary: string, offset = 0): SessionMessageInfo {
  return {
    id: messageID("compaction"),
    time: { created: at(offset) },
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary,
  }
}

function fileAttachment(name: string, mime: string): PromptFileAttachment {
  return { name, mime, data: "BASE64_SECRET_DATA", source: { type: "inline" } }
}

describe("buildDigest user and assistant content", () => {
  test("includes user text, attachment names and MIME types, but never attachment data", () => {
    const digest = buildDigest(
      [user("Please review", { files: [fileAttachment("notes.txt", "text/plain")] })],
      makeConfig(),
    )
    expect(digest.text).toContain("Please review")
    expect(digest.text).toContain("attachment: notes.txt (text/plain)")
    expect(digest.text).not.toContain("BASE64_SECRET_DATA")
  })

  test("includes assistant text and drops reasoning entirely", () => {
    const text = assistant([{ type: "text", text: "Implemented the panel" }])
    const reasoning = assistant([{ type: "reasoning", text: "THINKING_SECRET" }])
    const digest = buildDigest([text, reasoning], makeConfig())
    expect(digest.text).toContain("Implemented the panel")
    expect(digest.text).not.toContain("THINKING_SECRET")
    expect(digest.includedCount).toBe(1)
  })

  test("drops successful routine read tools", () => {
    const reads = assistant([
      tool("read", completed({ filePath: "src/a.ts" }, textResult("file contents"))),
      tool("grep", completed({ pattern: "x" }, textResult("matches"))),
      tool("glob", completed({ pattern: "*.ts" }, textResult("files"))),
      tool("find", completed({ path: "src" }, textResult("files"))),
      tool("list", completed({ path: "src" }, textResult("files"))),
    ])
    const digest = buildDigest([reads], makeConfig())
    expect(digest.includedCount).toBe(0)
    expect(digest.chars).toBe(0)
    expect(digest.text).toBe("")
  })

  test("includes a failed routine read because it errored", () => {
    const failed = assistant([
      tool("read", {
        status: "error",
        input: { filePath: "src/missing.ts" },
        error: { type: "not_found", message: "No such file" },
      }),
    ])
    const digest = buildDigest([failed], makeConfig())
    expect(digest.text).toContain("tool read error")
    expect(digest.text).toContain("No such file")
  })

  test("includes side-effecting and external tools", () => {
    const tools = assistant([
      tool("edit", completed({ filePath: "src/a.ts", oldString: "a", newString: "b" }, textResult("ok"))),
      tool("write", completed({ filePath: "src/b.ts", content: "x" }, textResult("ok"))),
      tool("patch", completed({ filePath: "src/c.ts", patchText: "@@" }, textResult("ok"))),
      tool("shell", completed({ command: "bun test" }, textResult("ok"))),
      tool("bash", completed({ command: "ls" }, textResult("ok"))),
      tool("task", completed({ description: "search" }, textResult("done"))),
      tool("todowrite", completed({ todos: [{ content: "write tests" }] }, textResult("ok"))),
      tool("webfetch", completed({ url: "https://example.com" }, textResult("page"))),
      tool("websearch", completed({ query: "opencode" }, textResult("results"))),
    ])
    const digest = buildDigest([tools], makeConfig())
    for (const name of ["edit", "write", "patch", "shell", "bash", "task", "todowrite", "webfetch", "websearch"]) {
      expect(digest.text).toContain(`tool ${name} completed`)
    }
  })

  test("edit input includes path and line counts, never old or new content", () => {
    const message = assistant([
      tool(
        "edit",
        completed(
          {
            filePath: "src/a.ts",
            oldString: "OLD_SECRET_CONTENT\nline2",
            newString: "NEW_SECRET_CONTENT\nline2\nline3",
          },
          textResult("ok"),
        ),
      ),
    ])
    const digest = buildDigest([message], makeConfig())
    expect(digest.text).toContain("path=src/a.ts")
    expect(digest.text).toContain("oldLines=2")
    expect(digest.text).toContain("newLines=3")
    expect(digest.text).not.toContain("OLD_SECRET_CONTENT")
    expect(digest.text).not.toContain("NEW_SECRET_CONTENT")
    expect(digest.text).not.toContain("oldString=")
    expect(digest.text).not.toContain("newString=")
  })

  test("write input includes path and line count, never content", () => {
    const message = assistant([
      tool(
        "write",
        completed({ filePath: "src/b.ts", content: "WRITE_SECRET_ONE\nWRITE_SECRET_TWO" }, textResult("ok")),
      ),
    ])
    const digest = buildDigest([message], makeConfig())
    expect(digest.text).toContain("path=src/b.ts")
    expect(digest.text).toContain("lines=2")
    expect(digest.text).not.toContain("WRITE_SECRET_ONE")
    expect(digest.text).not.toContain("content=")
  })

  test("caps tool results and drops file content parts", () => {
    const message = assistant([
      tool(
        "edit",
        completed({ filePath: "src/a.ts", oldString: "", newString: "x" }, [
          { type: "text", text: "x".repeat(500) },
          { type: "file", uri: "file://SECRET_FILE_URI", mime: "text/plain" },
        ]),
      ),
    ])
    const digest = buildDigest([message], makeConfig({ maxToolResultChars: 40 }))
    expect(digest.text).toContain("…[truncated]…")
    expect(digest.text).not.toContain("SECRET_FILE_URI")
  })
})

describe("buildDigest shell and compaction content", () => {
  test("includes shell command, status, and output for normal commands", () => {
    const digest = buildDigest([shell("bun test", "exited", 0, "12 tests passed")], makeConfig())
    expect(digest.text).toContain("shell exited exit=0")
    expect(digest.text).toContain("command: bun test")
    expect(digest.text).toContain("output: 12 tests passed")
  })

  test("omits output for content-dump commands", () => {
    const digest = buildDigest(
      [
        shell("cat package.json", "exited", 0, "SECRET_FILE_BODY"),
        shell("sed -n 1,20p src/a.ts", "exited", 0, "SECRET_SED_BODY"),
        shell("head -5 README.md", "exited", 0, "SECRET_HEAD_BODY"),
        shell("bun test", "exited", 0, "safe output"),
      ],
      makeConfig(),
    )
    expect(digest.text).not.toContain("SECRET_FILE_BODY")
    expect(digest.text).not.toContain("SECRET_SED_BODY")
    expect(digest.text).not.toContain("SECRET_HEAD_BODY")
    expect(digest.text).toContain("safe output")
  })

  test("includes a completed compaction summary capped and redacted", () => {
    const digest = buildDigest(
      [compaction(`Summary api_key=supersecret123 ${"x".repeat(500)}`)],
      makeConfig({ maxCompactionChars: 80 }),
    )
    expect(digest.text).toContain("compaction summary")
    expect(digest.text).toContain("api_key=[REDACTED]")
    expect(digest.text).toContain("…[truncated]…")
    expect(digest.text).not.toContain("supersecret123")
  })
})

describe("buildDigest ignored messages and aliases", () => {
  test("ignores synthetic, system, skill, idle, and switch messages", () => {
    const ignored: SessionMessageInfo[] = [
      { id: messageID("synthetic"), time: { created: at(1) }, type: "synthetic", text: "synthetic" },
      { id: messageID("system"), time: { created: at(2) }, type: "system", text: "system" },
      {
        id: messageID("skill"),
        time: { created: at(3) },
        type: "skill",
        skill: "skill_1",
        name: "Skill",
        text: "skill body",
      },
      { id: messageID("idle"), time: { created: at(4) }, type: "idle", outcome: "succeeded" },
      { id: messageID("agent"), time: { created: at(5) }, type: "agent-switched", agent: "build" },
      {
        id: messageID("model"),
        time: { created: at(6) },
        type: "model-switched",
        model: { id: "gpt-5-mini", providerID: "openai" },
      },
      {
        id: messageID("location"),
        time: { created: at(7) },
        type: "location-switched",
        location: { directory: "/repo" },
      },
    ]
    const digest = buildDigest(ignored, makeConfig())
    expect(digest.includedCount).toBe(0)
    expect(digest.chars).toBe(0)
    expect(digest.text).toBe("")
    expect(digest.firstMessageID).toBe(ignored[0]?.id)
    expect(digest.lastMessageID).toBe(ignored[ignored.length - 1]?.id)
  })

  test("assigns sequential aliases with real IDs and UTC timestamps", () => {
    const first = user("first", { createdAt: Date.parse("2026-10-29T10:00:00.000Z") })
    const ignored: SessionMessageInfo = {
      id: messageID("idle"),
      time: { created: at(1) },
      type: "idle",
      outcome: "succeeded",
    }
    const second = assistant([{ type: "text", text: "second" }], {
      createdAt: Date.parse("2026-10-29T10:01:00.000Z"),
    })
    const digest = buildDigest([first, ignored, second], makeConfig())
    expect(digest.aliases).toEqual([
      { alias: "m1", messageID: first.id, createdAt: "2026-10-29T10:00:00.000Z" },
      { alias: "m2", messageID: second.id, createdAt: "2026-10-29T10:01:00.000Z" },
    ])
    expect(digest.aliasMap.get("m2")?.messageID).toBe(second.id)
    expect(digest.includedCount).toBe(2)
  })

  test("counts only messages that produced a block and keeps chars in sync", () => {
    const digest = buildDigest([user("hello"), assistant([])], makeConfig())
    expect(digest.includedCount).toBe(1)
    expect(digest.chars).toBe(digest.text.length)
    expect(digest.chars).toBeGreaterThan(0)
  })
})

describe("buildDigest privacy and evidence separation", () => {
  test("redacts user text, assistant text, tool inputs, and tool results", () => {
    const message = assistant([
      tool(
        "shell",
        completed({ command: "export api_key=supersecret123" }, textResult("token ghp_abcdefghijklmnopqrstuvwx")),
      ),
      { type: "text", text: "Assistant leaked sk-abcdefghijklmnop1234" },
    ])
    const digest = buildDigest([user("User leaked sk-abcdefghijklmnop1234"), message], makeConfig())
    expect(digest.text).toContain("[REDACTED]")
    expect(digest.text).not.toContain("supersecret123")
    expect(digest.text).not.toContain("ghp_abcdefghijklmnopqrstuvwx")
    expect(digest.text).not.toContain("sk-abcdefghijklmnop1234")
  })

  test("returns evidence separately and never duplicates it in the text", () => {
    const message = assistant([
      tool("edit", completed({ filePath: "src/a.ts", oldString: "", newString: "x" }, textResult("ok"))),
    ])
    const digest = buildDigest([message], makeConfig())
    expect(digest.evidence).toContain("Files touched: src/a.ts")
    expect(digest.text).not.toContain("Files touched")
  })

  test("an ignored-only chunk still exposes first and last IDs", () => {
    const first: SessionMessageInfo = {
      id: messageID("idle"),
      time: { created: at(0) },
      type: "idle",
      outcome: "succeeded",
    }
    const last: SessionMessageInfo = {
      id: messageID("idle"),
      time: { created: at(10) },
      type: "idle",
      outcome: "succeeded",
    }
    const digest = buildDigest([first, last], makeConfig())
    expect(digest.firstMessageID).toBe(first.id)
    expect(digest.lastMessageID).toBe(last.id)
  })
})
