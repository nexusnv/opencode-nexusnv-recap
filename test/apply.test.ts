import { describe, expect, test } from "bun:test"
import type { DigestAlias } from "../src/server/digest"
import { applyOutput, type ApplyInput } from "../src/server/apply"
import {
  parseModelOutput,
  type ValidatedChapter,
  type ValidatedHighlight,
  type ValidatedOutput,
  type ValidatedTask,
} from "../src/server/output"
import { createDocument } from "../src/shared/document"
import type {
  TimelineChapter,
  TimelineCoverage,
  TimelineDocument,
  TimelineHighlight,
  TimelineModelRef,
  TimelineTask,
} from "../src/shared/types"

const DOC_TIME = "2026-10-29T10:00:00.000Z"
const EARLIER = "2026-10-29T09:00:00.000Z"
const LATER = "2026-10-29T11:00:00.000Z"
const NOW = "2026-10-29T12:00:00.000Z"
const MODEL: TimelineModelRef = { providerID: "openai", modelID: "gpt-5-mini" }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface DocumentOverrides {
  goal?: string | null
  tasks?: TimelineTask[]
  chapters?: TimelineChapter[]
  coverage?: TimelineCoverage
}

function documentWith(overrides: DocumentOverrides = {}): TimelineDocument {
  const document = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test session",
    model: MODEL,
    promptVersion: 1,
    now: DOC_TIME,
  })
  if (overrides.goal !== undefined) document.goal = overrides.goal
  if (overrides.tasks !== undefined) document.tasks = overrides.tasks
  if (overrides.chapters !== undefined) document.chapters = overrides.chapters
  if (overrides.coverage !== undefined) document.coverage = overrides.coverage
  return document
}

function task(overrides: Partial<TimelineTask> = {}): TimelineTask {
  return {
    key: "build-rpc",
    title: "Build the RPC layer",
    status: "open",
    anchorMessageID: "msg_1",
    updatedAt: EARLIER,
    ...overrides,
  }
}

function highlight(overrides: Partial<TimelineHighlight> = {}): TimelineHighlight {
  return {
    id: "hl_1",
    kind: "implementation",
    text: "Implemented the change",
    at: DOC_TIME,
    anchorMessageID: "msg_1",
    ...overrides,
  }
}

function chapter(overrides: Partial<TimelineChapter> = {}): TimelineChapter {
  return {
    id: "ch_1",
    title: "Current chapter",
    summary: "Current summary",
    startedAt: DOC_TIME,
    endedAt: "2026-10-29T10:10:00.000Z",
    highlights: [],
    createdAt: DOC_TIME,
    updatedAt: "2026-10-29T10:10:00.000Z",
    ...overrides,
  }
}

function validatedTask(overrides: Partial<ValidatedTask> = {}): ValidatedTask {
  return {
    key: "build-rpc",
    title: "Build the RPC layer",
    status: "open",
    ...overrides,
  }
}

function validatedHighlight(overrides: Partial<ValidatedHighlight> = {}): ValidatedHighlight {
  return {
    kind: "implementation",
    text: "Implemented the change",
    at: DOC_TIME,
    anchorMessageID: "msg_1",
    ...overrides,
  }
}

function validatedChapter(overrides: Partial<ValidatedChapter> = {}): ValidatedChapter {
  return {
    mode: "new",
    title: "Chapter",
    summary: "Summary",
    highlights: [validatedHighlight()],
    ...overrides,
  }
}

function output(overrides: Partial<ValidatedOutput> = {}): ValidatedOutput {
  return {
    goal: null,
    tasks: null,
    chapters: [],
    ...overrides,
  }
}

function apply(document: TimelineDocument, validated: ValidatedOutput, overrides: Partial<ApplyInput> = {}): void {
  applyOutput(document, {
    output: validated,
    now: NOW,
    coveragePartial: false,
    model: MODEL,
    promptVersion: 2,
    ...overrides,
  })
}

function chapterAt(document: TimelineDocument, index: number): TimelineChapter {
  const value = document.chapters[index]
  if (!value) throw new Error(`expected a chapter at index ${index}`)
  return value
}

function highlightAt(value: TimelineChapter, index: number): TimelineHighlight {
  const entry = value.highlights[index]
  if (!entry) throw new Error(`expected a highlight at index ${index}`)
  return entry
}

describe("applyOutput goal", () => {
  test("keeps the existing goal when the output goal is null", () => {
    const document = documentWith({ goal: "Existing goal" })

    apply(document, output({ goal: null }))

    expect(document.goal).toBe("Existing goal")
  })

  test("replaces the goal when the output goal is non-empty", () => {
    const document = documentWith({ goal: "Existing goal" })

    apply(document, output({ goal: "Ship the recap timeline" }))

    expect(document.goal).toBe("Ship the recap timeline")
  })

  test("keeps the existing goal when the output goal is empty", () => {
    const document = documentWith({ goal: "Existing goal" })

    apply(document, output({ goal: "" }))

    expect(document.goal).toBe("Existing goal")
  })
})

describe("applyOutput tasks", () => {
  test("leaves the ledger untouched when tasks is null", () => {
    const existing = [task(), task({ key: "ship-rpc", title: "Ship the RPC layer" })]
    const document = documentWith({ tasks: existing })

    apply(document, output({ tasks: null }))

    expect(document.tasks).toStrictEqual(existing)
  })

  test("clears the ledger when tasks is an empty array", () => {
    const document = documentWith({ tasks: [task()] })

    apply(document, output({ tasks: [] }))

    expect(document.tasks).toStrictEqual([])
  })

  test("preserves updatedAt for an unchanged task", () => {
    const existing = task({ anchorMessageID: "msg_1", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(document, output({ tasks: [validatedTask({ anchorMessageID: "msg_1" })] }))

    expect(document.tasks).toStrictEqual([existing])
  })

  test("sets updatedAt to now when a task status changes", () => {
    const existing = task({ anchorMessageID: "msg_1", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(document, output({ tasks: [validatedTask({ anchorMessageID: "msg_1", status: "done" })] }))

    expect(document.tasks).toStrictEqual([{ ...existing, status: "done", updatedAt: NOW }])
  })

  test("sets updatedAt to now when a task title changes", () => {
    const existing = task({ anchorMessageID: "msg_1", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(document, output({ tasks: [validatedTask({ anchorMessageID: "msg_1", title: "Build the RPC transport" })] }))

    expect(document.tasks).toStrictEqual([{ ...existing, title: "Build the RPC transport", updatedAt: NOW }])
  })

  test("sets updatedAt to now when a task anchor changes", () => {
    const existing = task({ anchorMessageID: "msg_1", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(document, output({ tasks: [validatedTask({ anchorMessageID: "msg_2" })] }))

    expect(document.tasks).toStrictEqual([{ ...existing, anchorMessageID: "msg_2", updatedAt: NOW }])
  })

  test("preserves the previous anchor and updatedAt when the anchor is omitted", () => {
    const existing = task({ anchorMessageID: "msg_1", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(document, output({ tasks: [validatedTask()] }))

    expect(document.tasks).toStrictEqual([existing])
  })

  test("clears the anchor and refreshes updatedAt when the anchor is unknown", () => {
    const existing = task({ anchorMessageID: "msg_1", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(document, output({ tasks: [validatedTask({ anchorMessageID: null })] }))

    expect(document.tasks).toStrictEqual([{ ...existing, anchorMessageID: null, updatedAt: NOW }])
  })

  test("keeps the existing key when a task is matched by title", () => {
    const existing = task({ key: "build-rpc", title: "Build the RPC layer", updatedAt: EARLIER })
    const document = documentWith({ tasks: [existing] })

    apply(
      document,
      output({
        tasks: [validatedTask({ key: "rpc-layer", title: "Build the RPC layer", anchorMessageID: "msg_1" })],
      }),
    )

    expect(document.tasks).toStrictEqual([existing])
  })

  test("replaces the ledger with the returned task list", () => {
    const kept = task({ key: "build-rpc", updatedAt: EARLIER })
    const removed = task({ key: "old-task", title: "Old task", updatedAt: EARLIER })
    const document = documentWith({ tasks: [kept, removed] })

    apply(
      document,
      output({
        tasks: [
          validatedTask({ key: "ship-rpc", title: "Ship the RPC layer", anchorMessageID: "msg_2" }),
          validatedTask({ key: "build-rpc", anchorMessageID: "msg_1" }),
        ],
      }),
    )

    expect(document.tasks).toStrictEqual([
      { key: "ship-rpc", title: "Ship the RPC layer", status: "open", anchorMessageID: "msg_2", updatedAt: NOW },
      kept,
    ])
  })
})

describe("applyOutput chapters", () => {
  test("appends a new chapter with generated IDs and timestamps from the highlights", () => {
    const document = documentWith()

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            title: "New chapter",
            summary: "New summary",
            highlights: [
              validatedHighlight({ text: "Late highlight", at: LATER, anchorMessageID: "msg_2" }),
              validatedHighlight({ text: "Early highlight", at: DOC_TIME, anchorMessageID: "msg_1" }),
            ],
          }),
        ],
      }),
    )

    expect(document.chapters).toHaveLength(1)
    const added = chapterAt(document, 0)
    expect(added.id.startsWith("ch_")).toBe(true)
    expect(UUID.test(added.id.slice(3))).toBe(true)
    expect(added.title).toBe("New chapter")
    expect(added.summary).toBe("New summary")
    expect(added.createdAt).toBe(NOW)
    expect(added.updatedAt).toBe(NOW)
    expect(added.startedAt).toBe(DOC_TIME)
    expect(added.endedAt).toBe(LATER)
    expect(added.highlights.map((entry) => entry.text)).toStrictEqual(["Late highlight", "Early highlight"])
    expect(added.highlights.map((entry) => entry.at)).toStrictEqual([LATER, DOC_TIME])
    for (const entry of added.highlights) {
      expect(entry.id.startsWith("hl_")).toBe(true)
      expect(UUID.test(entry.id.slice(3))).toBe(true)
    }
  })

  test("extends the current chapter and updates its title and summary", () => {
    const existing = chapter({
      id: "ch_1",
      title: "Old title",
      summary: "Old summary",
      startedAt: DOC_TIME,
      endedAt: "2026-10-29T10:10:00.000Z",
      highlights: [highlight({ id: "hl_old", text: "Old highlight", at: "2026-10-29T10:05:00.000Z" })],
      createdAt: DOC_TIME,
      updatedAt: "2026-10-29T10:10:00.000Z",
    })
    const document = documentWith({ chapters: [existing] })
    const messages: string[] = []

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_1",
            title: "Updated title",
            summary: "Updated summary",
            highlights: [validatedHighlight({ text: "New highlight", at: LATER })],
          }),
        ],
      }),
      {
        log: (message) => {
          messages.push(message)
        },
      },
    )

    expect(document.chapters).toHaveLength(1)
    const extended = chapterAt(document, 0)
    expect(extended.id).toBe("ch_1")
    expect(extended.title).toBe("Updated title")
    expect(extended.summary).toBe("Updated summary")
    expect(extended.startedAt).toBe(DOC_TIME)
    expect(extended.endedAt).toBe(LATER)
    expect(extended.createdAt).toBe(DOC_TIME)
    expect(extended.updatedAt).toBe(NOW)
    expect(extended.highlights.map((entry) => entry.text)).toStrictEqual(["Old highlight", "New highlight"])
    expect(messages).toStrictEqual([])
  })

  test("keeps the current title and summary when the extend returns empty strings", () => {
    const existing = chapter({ id: "ch_1", title: "Old title", summary: "Old summary" })
    const document = documentWith({ chapters: [existing] })

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_1",
            title: "",
            summary: "",
            highlights: [validatedHighlight({ text: "New highlight", at: LATER })],
          }),
        ],
      }),
    )

    const extended = chapterAt(document, 0)
    expect(extended.title).toBe("Old title")
    expect(extended.summary).toBe("Old summary")
  })

  test("treats a stale extend as a new chapter and logs only IDs", () => {
    const existing = chapter({ id: "ch_current" })
    const document = documentWith({ chapters: [existing] })
    const logs: Array<{ message: string; data?: Record<string, unknown> }> = []

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_stale",
            title: "Stale extend",
            highlights: [validatedHighlight({ text: "New work", at: LATER })],
          }),
        ],
      }),
      {
        log: (message, data) => {
          logs.push({ message, ...(data ? { data } : {}) })
        },
      },
    )

    expect(document.chapters).toHaveLength(2)
    expect(chapterAt(document, 0)).toStrictEqual(existing)
    const added = chapterAt(document, 1)
    expect(added.id).not.toBe("ch_stale")
    expect(UUID.test(added.id.slice(3))).toBe(true)
    expect(added.title).toBe("Stale extend")
    expect(logs).toHaveLength(1)
    expect(logs[0]?.message).toContain("non-current")
    expect(logs[0]?.data).toStrictEqual({
      sessionID: "ses_1",
      requestedChapterID: "ch_stale",
      currentChapterID: "ch_current",
    })
    expect(JSON.stringify(logs)).not.toContain("New work")
  })

  test("never logs a malformed model-controlled chapter ID", () => {
    const existing = chapter({ id: "ch_current" })
    const document = documentWith({ chapters: [existing] })
    const logs: Array<{ message: string; data?: Record<string, unknown> }> = []
    const malformed = `ch_secret\nTOKEN\n${"x".repeat(500)}`

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: malformed,
            title: "Malformed extend",
            highlights: [validatedHighlight({ text: "New work", at: LATER })],
          }),
        ],
      }),
      {
        log: (message, data) => {
          logs.push({ message, ...(data ? { data } : {}) })
        },
      },
    )

    expect(document.chapters).toHaveLength(2)
    const added = chapterAt(document, 1)
    expect(added.id).not.toBe(malformed)
    expect(UUID.test(added.id.slice(3))).toBe(true)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.data).toStrictEqual({
      sessionID: "ses_1",
      requestedChapterIDMalformed: true,
      currentChapterID: "ch_current",
    })
    expect(JSON.stringify(logs)).not.toContain("secret")
    expect(JSON.stringify(logs)).not.toContain("TOKEN")
    expect(JSON.stringify(logs)).not.toContain("x".repeat(65))
  })

  test("treats an extend as a new chapter when the document has no chapters", () => {
    const document = documentWith()
    const messages: string[] = []

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_missing",
            title: "Extend without history",
            highlights: [validatedHighlight({ text: "First highlight", at: DOC_TIME })],
          }),
          validatedChapter({
            title: "Second chapter",
            highlights: [validatedHighlight({ text: "Second highlight", at: LATER, anchorMessageID: "msg_2" })],
          }),
        ],
      }),
      {
        log: (message) => {
          messages.push(message)
        },
      },
    )

    expect(document.chapters).toHaveLength(2)
    expect(chapterAt(document, 0).title).toBe("Extend without history")
    expect(chapterAt(document, 0).id).not.toBe("ch_missing")
    expect(UUID.test(chapterAt(document, 0).id.slice(3))).toBe(true)
    expect(chapterAt(document, 1).title).toBe("Second chapter")
    expect(messages).toStrictEqual([])
  })

  test("never moves startedAt backward and keeps the latest endedAt", () => {
    const existing = chapter({
      id: "ch_1",
      startedAt: DOC_TIME,
      endedAt: "2026-10-29T10:10:00.000Z",
      highlights: [highlight({ text: "Existing highlight", at: "2026-10-29T10:05:00.000Z" })],
    })
    const document = documentWith({ chapters: [existing] })

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_1",
            highlights: [
              validatedHighlight({ text: "Older highlight", at: EARLIER }),
              validatedHighlight({ text: "Newer highlight", at: LATER }),
            ],
          }),
        ],
      }),
    )

    const extended = chapterAt(document, 0)
    expect(extended.startedAt).toBe(DOC_TIME)
    expect(extended.endedAt).toBe(LATER)
  })

  test("does not move endedAt backward when the current chapter ends after every appended highlight", () => {
    const existingEnd = "2026-10-29T12:30:00.000Z"
    const existing = chapter({
      id: "ch_1",
      startedAt: DOC_TIME,
      endedAt: existingEnd,
      highlights: [highlight({ text: "Existing highlight", at: "2026-10-29T10:05:00.000Z" })],
    })
    const document = documentWith({ chapters: [existing] })

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_1",
            highlights: [
              validatedHighlight({ text: "Older highlight", at: EARLIER }),
              validatedHighlight({ text: "Newer highlight", at: LATER }),
            ],
          }),
        ],
      }),
    )

    const extended = chapterAt(document, 0)
    expect(extended.startedAt).toBe(DOC_TIME)
    expect(extended.endedAt).toBe(existingEnd)
  })

  test("drops a highlight with an unparsable timestamp and keeps its valid siblings", () => {
    const existing = chapter({
      id: "ch_1",
      endedAt: "2026-10-29T10:10:00.000Z",
      highlights: [highlight({ text: "Existing highlight", at: "2026-10-29T10:05:00.000Z" })],
    })
    const document = documentWith({ chapters: [existing] })

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_1",
            highlights: [
              validatedHighlight({ text: "Not a date", at: "not-a-date" }),
              validatedHighlight({ text: "Valid highlight", at: LATER }),
            ],
          }),
        ],
      }),
    )

    const extended = chapterAt(document, 0)
    expect(extended.highlights.map((entry) => entry.text)).toStrictEqual(["Existing highlight", "Valid highlight"])
    expect(extended.highlights.map((entry) => entry.at)).toStrictEqual(["2026-10-29T10:05:00.000Z", LATER])
    expect(extended.endedAt).toBe(LATER)
  })

  test("drops duplicate normalized highlight text within an extended chapter", () => {
    const existing = chapter({
      id: "ch_1",
      highlights: [highlight({ text: "Implemented the RPC layer", at: "2026-10-29T10:05:00.000Z" })],
    })
    const document = documentWith({ chapters: [existing] })

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            mode: "extend",
            chapterID: "ch_1",
            highlights: [validatedHighlight({ text: "  implemented   THE rpc layer ", at: LATER })],
          }),
        ],
      }),
    )

    expect(chapterAt(document, 0).highlights).toHaveLength(1)
  })

  test("drops duplicate normalized highlight text within a new chapter", () => {
    const document = documentWith()

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            highlights: [
              validatedHighlight({ text: "Same text", at: DOC_TIME }),
              validatedHighlight({ text: " same   TEXT ", at: LATER }),
            ],
          }),
        ],
      }),
    )

    const added = chapterAt(document, 0)
    expect(added.highlights).toHaveLength(1)
    expect(highlightAt(added, 0).text).toBe("Same text")
    expect(added.endedAt).toBe(DOC_TIME)
  })

  test("takes highlight timestamps from the resolved anchor, not from the model", () => {
    const aliases: ReadonlyMap<string, DigestAlias> = new Map([
      ["m1", { alias: "m1", messageID: "msg_anchor", createdAt: DOC_TIME }],
    ])
    const parsed = parseModelOutput(
      JSON.stringify({
        goal: "",
        tasks: null,
        chapters: [
          {
            mode: "new",
            title: "Chapter",
            summary: "Summary",
            highlights: [
              { kind: "implementation", text: "Anchored highlight", anchor: "m1", at: "1999-01-01T00:00:00.000Z" },
            ],
          },
        ],
      }),
      aliases,
    )
    if (!parsed.ok) throw new Error(`expected a valid parse, got: ${parsed.error}`)

    const document = documentWith()

    apply(document, parsed.output)

    const added = chapterAt(document, 0)
    expect(highlightAt(added, 0).at).toBe(DOC_TIME)
    expect(highlightAt(added, 0).anchorMessageID).toBe("msg_anchor")
    expect(added.startedAt).toBe(DOC_TIME)
    expect(added.endedAt).toBe(DOC_TIME)
    expect(added.createdAt).toBe(NOW)
  })

  test("drops state from directly built commit artifacts and keeps it for PRs", () => {
    const document = documentWith()

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            highlights: [
              validatedHighlight({
                text: "Merged a commit",
                artifact: {
                  type: "commit",
                  url: "https://github.com/acme/repo/commit/abc123",
                  state: "merged",
                },
              }),
              validatedHighlight({
                text: "Merged a PR",
                artifact: { type: "pr", url: "https://github.com/acme/repo/pull/42", state: "merged" },
              }),
            ],
          }),
        ],
      }),
    )

    const added = chapterAt(document, 0)
    expect(highlightAt(added, 0).artifact).toStrictEqual({
      type: "commit",
      url: "https://github.com/acme/repo/commit/abc123",
    })
    expect(highlightAt(added, 1).artifact).toStrictEqual({
      type: "pr",
      url: "https://github.com/acme/repo/pull/42",
      state: "merged",
    })
  })
})

describe("applyOutput coverage and meta", () => {
  test("sets coverage.partial and the reason when the source is partial", () => {
    const document = documentWith()

    apply(document, output(), { coveragePartial: true })

    expect(document.coverage).toStrictEqual({ partial: true, reason: "compacted-history" })
  })

  test("never clears coverage.partial", () => {
    const document = documentWith({ coverage: { partial: true, reason: "compacted-history" } })

    apply(document, output(), { coveragePartial: false })

    expect(document.coverage).toStrictEqual({ partial: true, reason: "compacted-history" })
  })

  test("updates meta.model and meta.promptVersion", () => {
    const document = documentWith()
    const model: TimelineModelRef = { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" }

    apply(document, output(), { model, promptVersion: 3 })

    expect(document.meta.model).toStrictEqual(model)
    expect(document.meta.promptVersion).toBe(3)
  })

  test("leaves the watermark to the engine on a non-empty apply", () => {
    const watermark = { messageID: "msg_9", createdAt: DOC_TIME, messageCount: 9 }
    const document = documentWith()
    document.watermark = watermark

    apply(
      document,
      output({ chapters: [validatedChapter({ highlights: [validatedHighlight({ text: "New work" })] })] }),
    )

    expect(document.chapters).toHaveLength(1)
    expect(document.watermark).toStrictEqual(watermark)
  })
})

describe("applyOutput document ownership", () => {
  test("copies caller-owned model, artifact, and task objects into the document", () => {
    const document = documentWith()
    const model: TimelineModelRef = { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" }
    const artifact: NonNullable<ValidatedHighlight["artifact"]> = {
      type: "pr",
      url: "https://github.com/acme/repo/pull/42",
      state: "merged",
    }
    const taskRef: NonNullable<ValidatedHighlight["task"]> = { key: "build-rpc", status: "open" }

    apply(
      document,
      output({
        chapters: [
          validatedChapter({
            highlights: [validatedHighlight({ text: "Merged a PR", artifact, task: taskRef })],
          }),
        ],
      }),
      { model },
    )

    const added = chapterAt(document, 0)
    const stored = highlightAt(added, 0)
    expect(document.meta.model).toStrictEqual(model)
    expect(document.meta.model).not.toBe(model)
    expect(stored.artifact).toStrictEqual(artifact)
    expect(stored.artifact).not.toBe(artifact)
    expect(stored.task).toStrictEqual(taskRef)
    expect(stored.task).not.toBe(taskRef)

    model.variant = "low"
    artifact.state = "closed"
    taskRef.status = "done"

    expect(document.meta.model).toStrictEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      variant: "high",
    })
    expect(stored.artifact).toStrictEqual({
      type: "pr",
      url: "https://github.com/acme/repo/pull/42",
      state: "merged",
    })
    expect(stored.task).toStrictEqual({ key: "build-rpc", status: "open" })
  })
})

describe("applyOutput empty output", () => {
  test("is a no-op when there is nothing to apply", () => {
    const document = documentWith({
      goal: "Existing goal",
      tasks: [task()],
      chapters: [chapter({ highlights: [highlight()] })],
      coverage: { partial: true, reason: "compacted-history" },
    })
    document.watermark = { messageID: "msg_9", createdAt: DOC_TIME, messageCount: 9 }
    const before = structuredClone(document)

    apply(document, output(), { model: document.meta.model, promptVersion: document.meta.promptVersion })

    expect(document).toStrictEqual(before)
  })
})
