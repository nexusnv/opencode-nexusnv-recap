import { describe, expect, test } from "bun:test"
import type { DigestAlias } from "../src/server/digest"
import { parseModelOutput, type ParseResult, type ValidatedOutput } from "../src/server/output"

const ALIASES: ReadonlyMap<string, DigestAlias> = new Map([
  ["m1", { alias: "m1", messageID: "msg_1", createdAt: "2026-10-29T10:00:00.000Z" }],
  ["m2", { alias: "m2", messageID: "msg_2", createdAt: "2026-10-29T10:01:00.000Z" }],
  ["m3", { alias: "m3", messageID: "msg_3", createdAt: "2026-10-29T10:02:00.000Z" }],
  ["m4", { alias: "m4", messageID: "msg_4", createdAt: "2026-10-29T10:03:00.000Z" }],
  ["m5", { alias: "m5", messageID: "msg_5", createdAt: "2026-10-29T10:04:00.000Z" }],
  ["m6", { alias: "m6", messageID: "msg_6", createdAt: "2026-10-29T10:05:00.000Z" }],
  ["m7", { alias: "m7", messageID: "msg_7", createdAt: "2026-10-29T10:06:00.000Z" }],
])

function parse(value: unknown): ParseResult {
  return parseModelOutput(JSON.stringify(value), ALIASES)
}

function expectOutput(result: ParseResult): ValidatedOutput {
  if (!result.ok) throw new Error(`expected a valid parse, got: ${result.error}`)
  return result.output
}

function expectError(result: ParseResult): string {
  if (result.ok) throw new Error("expected the parse to fail")
  return result.error
}

function highlight(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "implementation", text: "Implemented the change", anchor: "m1", ...overrides }
}

function chapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: "new", title: "Chapter", summary: "Chapter summary", highlights: [highlight()], ...overrides }
}

function noOp(): Record<string, unknown> {
  return { goal: "", tasks: null, chapters: [] }
}

describe("parseModelOutput top-level validation", () => {
  test("parses a valid output with a goal, tasks, and one new chapter", () => {
    const output = expectOutput(
      parse({
        goal: "Ship the recap timeline",
        tasks: [{ key: "Build the RPC layer!", title: "Build the RPC layer", status: "done", anchor: "m1" }],
        chapters: [
          {
            mode: "new",
            title: "RPC layer",
            summary: "Built the RPC layer and opened a PR.",
            highlights: [
              {
                kind: "pr",
                text: "Opened PR #42 for the RPC layer.",
                anchor: "m2",
                artifact: { type: "pr", url: "https://github.com/acme/repo/pull/42", state: "opened" },
              },
            ],
          },
        ],
      }),
    )

    expect(output).toStrictEqual({
      goal: "Ship the recap timeline",
      tasks: [{ key: "build-the-rpc-layer", title: "Build the RPC layer", status: "done", anchorMessageID: "msg_1" }],
      chapters: [
        {
          mode: "new",
          title: "RPC layer",
          summary: "Built the RPC layer and opened a PR.",
          highlights: [
            {
              kind: "pr",
              text: "Opened PR #42 for the RPC layer.",
              at: "2026-10-29T10:01:00.000Z",
              anchorMessageID: "msg_2",
              artifact: { type: "pr", url: "https://github.com/acme/repo/pull/42", state: "opened" },
            },
          ],
        },
      ],
    })
  })

  test("parses a no-op output", () => {
    expect(expectOutput(parse(noOp()))).toStrictEqual({ goal: null, tasks: null, chapters: [] })
  })

  test("keeps the chapter ID for an extend targeting the current chapter", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [chapter({ mode: "extend", chapterID: "ch_existing", title: "Extended" })],
      }),
    )

    expect(output.chapters).toHaveLength(1)
    expect(output.chapters[0]?.mode).toBe("extend")
    expect(output.chapters[0]?.chapterID).toBe("ch_existing")
    expect(output.chapters[0]?.title).toBe("Extended")
  })

  test("omits a null chapter ID", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [chapter({ mode: "extend", chapterID: null })],
      }),
    )

    expect(output.chapters[0]?.mode).toBe("extend")
    expect(output.chapters[0]).not.toHaveProperty("chapterID")
  })

  test("unwraps JSON inside a code fence", () => {
    const raw = `\`\`\`json\n${JSON.stringify(noOp())}\n\`\`\``
    expect(expectOutput(parseModelOutput(raw, ALIASES))).toStrictEqual({ goal: null, tasks: null, chapters: [] })
  })

  test("unwraps a fenced JSON block embedded in prose", () => {
    const raw = `Here is the JSON:\n\`\`\`json\n${JSON.stringify(noOp())}\n\`\`\`\nDone.`
    expect(expectOutput(parseModelOutput(raw, ALIASES))).toStrictEqual({ goal: null, tasks: null, chapters: [] })
  })

  test("returns the JSON parser message for invalid JSON", () => {
    const raw = '{"goal": "timeline",'
    let message = ""
    try {
      JSON.parse(raw)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(expectError(parseModelOutput(raw, ALIASES))).toBe(`Invalid JSON: ${message}`)
  })

  test("rejects unknown top-level keys", () => {
    expect(expectError(parse({ ...noOp(), extra: true }))).toContain("extra")
  })

  test("rejects a non-object top-level value", () => {
    expect(expectError(parse([]))).not.toBe("")
  })

  test("rejects output missing goal, tasks, or chapters", () => {
    const full = noOp()
    for (const field of ["goal", "tasks", "chapters"] as const) {
      const partial = Object.fromEntries(Object.entries(full).filter(([key]) => key !== field))
      expect(expectError(parse(partial))).toContain(field)
    }
  })

  test("reports multiple top-level validation issues", () => {
    const error = expectError(parse({}))

    expect(error).toContain("goal")
    expect(error).toContain("tasks")
    expect(error).toContain("chapters")
    expect(error.split("; ").length).toBeGreaterThanOrEqual(3)
  })
})

describe("parseModelOutput limits", () => {
  test("keeps only the first two chapters", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [chapter({ title: "One" }), chapter({ title: "Two" }), chapter({ title: "Three" })],
      }),
    )

    expect(output.chapters.map((entry) => entry.title)).toEqual(["One", "Two"])
  })

  test("keeps only the first five highlights in a chapter", () => {
    const highlights = Array.from({ length: 7 }, (_, index) => highlight({ text: `highlight ${index}` }))
    const output = expectOutput(parse({ goal: "", tasks: null, chapters: [chapter({ highlights })] }))

    expect(output.chapters[0]?.highlights.map((entry) => entry.text)).toEqual([
      "highlight 0",
      "highlight 1",
      "highlight 2",
      "highlight 3",
      "highlight 4",
    ])
  })

  test("keeps only the first one hundred tasks", () => {
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      key: `task-${index}`,
      title: `Task ${index}`,
      status: "open",
    }))
    const output = expectOutput(parse({ goal: "", tasks, chapters: [] }))

    expect(output.tasks).toHaveLength(100)
    expect(output.tasks?.[0]?.key).toBe("task-0")
    expect(output.tasks?.[99]?.key).toBe("task-99")
  })

  test("truncates chapter titles, summaries, and highlight text", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            title: "t".repeat(80),
            summary: "s".repeat(200),
            highlights: [highlight({ text: "h".repeat(200) })],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.title).toHaveLength(60)
    expect(output.chapters[0]?.summary).toHaveLength(180)
    expect(output.chapters[0]?.highlights[0]?.text).toHaveLength(160)
  })

  test("truncates task titles to sixty characters", () => {
    const output = expectOutput(
      parse({ goal: "", tasks: [{ key: "long", title: "t".repeat(80), status: "open" }], chapters: [] }),
    )

    expect(output.tasks?.[0]?.title).toHaveLength(60)
  })

  test("truncates at code point boundaries without splitting surrogate pairs", () => {
    const emoji = "😀"
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [{ key: "emoji", title: `${"a".repeat(59)}${emoji}`, status: "open" }],
        chapters: [
          chapter({
            title: `${"t".repeat(59)}${emoji}`,
            summary: `${"s".repeat(179)}${emoji}`,
            highlights: [highlight({ text: `${"h".repeat(159)}${emoji}` })],
          }),
        ],
      }),
    )

    const taskTitle = output.tasks?.[0]?.title ?? ""
    const chapterTitle = output.chapters[0]?.title ?? ""
    const summary = output.chapters[0]?.summary ?? ""
    const text = output.chapters[0]?.highlights[0]?.text ?? ""

    for (const [value, length] of [
      [taskTitle, 60],
      [chapterTitle, 60],
      [summary, 180],
      [text, 160],
    ] as const) {
      expect(Array.from(value)).toHaveLength(length)
      expect(value.endsWith(emoji)).toBe(true)
      expect(value.isWellFormed()).toBe(true)
    }
  })
})

describe("parseModelOutput per-item leniency", () => {
  test("drops a task with an invalid status but keeps the other tasks", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [
          { key: "valid", title: "Valid task", status: "open" },
          { key: "invalid", title: "Invalid task", status: "doing" },
          { key: "blocked", title: "Blocked task", status: "blocked" },
        ],
        chapters: [],
      }),
    )

    expect(output.tasks?.map((task) => task.key)).toEqual(["valid", "blocked"])
  })

  test("returns null instead of clearing the ledger when every task is invalid", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [{ key: "a", title: "A", status: "doing", anchor: null }],
        chapters: [],
      }),
    )

    expect(output.tasks).toBeNull()
  })

  test("drops tasks with whitespace-only keys or titles", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [
          { key: "   ", title: "Blank key", status: "open" },
          { key: "blank-title", title: " \t ", status: "open" },
          { key: "kept", title: "  Keep me  ", status: "open" },
        ],
        chapters: [],
      }),
    )

    expect(output.tasks).toStrictEqual([{ key: "kept", title: "Keep me", status: "open" }])
  })

  test("drops highlights with an invalid kind or a missing anchor but keeps valid ones", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({ text: "valid", anchor: "m1" }),
              highlight({ text: "bad kind", kind: "thought", anchor: "m1" }),
              highlight({ text: "missing anchor", anchor: undefined }),
              highlight({ text: "another valid", kind: "note", anchor: "m2" }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights.map((entry) => entry.text)).toEqual(["valid", "another valid"])
  })

  test("drops a chapter with no valid highlights", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [chapter({ title: "Empty", highlights: [] }), chapter({ title: "Kept", highlights: [highlight()] })],
      }),
    )

    expect(output.chapters.map((entry) => entry.title)).toEqual(["Kept"])

    const onlyInvalid = expectOutput(
      parse({ goal: "", tasks: null, chapters: [chapter({ highlights: [{ kind: "decision", text: "no anchor" }] })] }),
    )
    expect(onlyInvalid.chapters).toStrictEqual([])
  })

  test("drops highlights with unknown anchor aliases", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [highlight({ text: "known", anchor: "m1" }), highlight({ text: "unknown", anchor: "m99" })],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights.map((entry) => entry.text)).toEqual(["known"])
  })

  test("sets an unknown task anchor to null and omits an omitted anchor", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [
          { key: "unknown", title: "Unknown anchor", status: "open", anchor: "m99" },
          { key: "omitted", title: "Omitted anchor", status: "open" },
        ],
        chapters: [],
      }),
    )

    expect(output.tasks?.[0]).toStrictEqual({
      key: "unknown",
      title: "Unknown anchor",
      status: "open",
      anchorMessageID: null,
    })
    expect(output.tasks?.[1]).toStrictEqual({ key: "omitted", title: "Omitted anchor", status: "open" })
    expect(output.tasks?.[1]).not.toHaveProperty("anchorMessageID")
  })

  test("treats a null task anchor as omitted", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [{ key: "null-anchor", title: "Null anchor", status: "open", anchor: null }],
        chapters: [],
      }),
    )

    expect(output.tasks?.[0]).toStrictEqual({ key: "null-anchor", title: "Null anchor", status: "open" })
    expect(output.tasks?.[0]).not.toHaveProperty("anchorMessageID")
  })

  test("drops an artifact URL that is not http(s) but keeps the highlight", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({
                text: "unsafe artifact",
                artifact: { type: "pr", url: "javascript:alert(1)", state: "opened" },
              }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.text).toBe("unsafe artifact")
    expect(output.chapters[0]?.highlights[0]?.artifact).toBeUndefined()
  })

  test("treats a null artifact as omitted", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [chapter({ highlights: [highlight({ text: "no artifact", artifact: null })] })],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.text).toBe("no artifact")
    expect(output.chapters[0]?.highlights[0]?.artifact).toBeUndefined()
  })

  test("strips unknown artifact fields and keeps a valid URL", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({
                text: "PR with extras",
                artifact: { type: "pr", url: "https://github.com/acme/repo/pull/7", number: 7 },
              }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.artifact).toStrictEqual({
      type: "pr",
      url: "https://github.com/acme/repo/pull/7",
    })
  })

  test("omits an invalid PR state but keeps the artifact", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({
                text: "PR bad state",
                artifact: { type: "pr", url: "https://github.com/acme/repo/pull/8", state: "draft" },
              }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.artifact).toStrictEqual({
      type: "pr",
      url: "https://github.com/acme/repo/pull/8",
    })
    expect(output.chapters[0]?.highlights[0]?.artifact).not.toHaveProperty("state")
  })

  test("omits state from a commit artifact even when it is invalid", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({
                kind: "commit",
                text: "Commit bad state",
                artifact: { type: "commit", url: "https://github.com/acme/repo/commit/def456", state: "pushed" },
              }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.artifact).toStrictEqual({
      type: "commit",
      url: "https://github.com/acme/repo/commit/def456",
    })
  })

  test("treats a whitespace artifact URL as absent", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [highlight({ text: "Whitespace URL", artifact: { type: "pr", url: "   " } })],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.artifact).toStrictEqual({ type: "pr" })
    expect(output.chapters[0]?.highlights[0]?.artifact).not.toHaveProperty("url")
  })

  test("does not let an extra id field stand in for a missing chapter field", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          {
            mode: "extend",
            id: "ch_existing",
            summary: "Missing title",
            highlights: [highlight()],
          },
        ],
      }),
    )

    expect(output.chapters).toStrictEqual([])
  })

  test("removes state from a commit artifact", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({
                kind: "commit",
                text: "Committed the fix",
                artifact: { type: "commit", url: "https://github.com/acme/repo/commit/abc123", state: "merged" },
              }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights[0]?.artifact).toStrictEqual({
      type: "commit",
      url: "https://github.com/acme/repo/commit/abc123",
    })
    expect(output.chapters[0]?.highlights[0]?.artifact).not.toHaveProperty("state")
  })

  test("keeps the last task for a duplicate key", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: [
          { key: "Same Key", title: "First", status: "open" },
          { key: "same key", title: "Second", status: "done", anchor: "m2" },
        ],
        chapters: [],
      }),
    )

    expect(output.tasks).toHaveLength(1)
    expect(output.tasks?.[0]).toStrictEqual({
      key: "same-key",
      title: "Second",
      status: "done",
      anchorMessageID: "msg_2",
    })
  })

  test("keeps the first highlight for duplicate normalized text within a chapter", () => {
    const output = expectOutput(
      parse({
        goal: "",
        tasks: null,
        chapters: [
          chapter({
            highlights: [
              highlight({ kind: "decision", text: "Use   SQLite" }),
              highlight({ kind: "note", text: " use sqlite " }),
            ],
          }),
        ],
      }),
    )

    expect(output.chapters[0]?.highlights).toHaveLength(1)
    expect(output.chapters[0]?.highlights[0]?.kind).toBe("decision")
    expect(output.chapters[0]?.highlights[0]?.text).toBe("Use   SQLite")
  })

  test("accepts an empty task array as a replacement ledger", () => {
    const output = expectOutput(parse({ goal: "New goal", tasks: [], chapters: [] }))

    expect(output.goal).toBe("New goal")
    expect(output.tasks).toStrictEqual([])
  })

  test("accepts null tasks as no change", () => {
    const output = expectOutput(parse({ goal: "", tasks: null, chapters: [] }))

    expect(output.tasks).toBeNull()
  })
})
