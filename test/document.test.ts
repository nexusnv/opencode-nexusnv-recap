import { describe, expect, test } from "bun:test"
import { createDocument, deriveHeader, parseDocument, timelineDocumentSchema } from "../src/shared/document"
import type { TimelineChapter, TimelineDocument, TimelineHighlight, TimelineTask } from "../src/shared/types"

function highlight(overrides: Partial<TimelineHighlight> = {}): TimelineHighlight {
  return {
    id: "hl_1",
    kind: "note",
    text: "A note",
    at: "2026-10-29T10:00:00.000Z",
    anchorMessageID: "msg_1",
    ...overrides,
  }
}

function chapter(overrides: Partial<TimelineChapter> = {}): TimelineChapter {
  return {
    id: "ch_1",
    title: "Chapter",
    summary: "Summary",
    startedAt: "2026-10-29T10:00:00.000Z",
    endedAt: "2026-10-29T10:10:00.000Z",
    highlights: [],
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:10:00.000Z",
    ...overrides,
  }
}

function decisionText(index: number): string {
  return `Decision ${index}`
}

function documentWith(chapters: TimelineChapter[], tasks: TimelineTask[] = []): TimelineDocument {
  const doc = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test",
    model: { providerID: "openai", modelID: "gpt-5-mini" },
    promptVersion: 1,
    now: "2026-10-29T10:00:00.000Z",
  })
  doc.chapters = chapters
  doc.tasks = tasks
  return doc
}

describe("createDocument", () => {
  test("creates an empty version 1 document with zeroed counters", () => {
    const doc = createDocument({
      sessionID: "ses_1",
      sessionTitle: "Test",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      promptVersion: 1,
      now: "2026-10-29T10:00:00.000Z",
    })

    expect(doc.version).toBe(1)
    expect(doc.status).toBe("empty")
    expect(doc.watermark).toBeNull()
    expect(doc.backfill).toBeNull()
    expect(doc.goal).toBeNull()
    expect(doc.coverage).toEqual({ partial: false })
    expect(doc.meta.callCount).toBe(0)
    expect(doc.meta.recentAutoCalls).toEqual([])
    expect(doc.meta.estimatedInputChars).toBe(0)
  })
})

describe("timelineDocumentSchema", () => {
  test("accepts a created document", () => {
    const doc = createDocument({
      sessionID: "ses_1",
      sessionTitle: "Test",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      promptVersion: 1,
      now: "2026-10-29T10:00:00.000Z",
    })
    expect(timelineDocumentSchema.safeParse(doc).success).toBe(true)
    expect(parseDocument(doc)).toEqual(doc)
  })

  test("rejects an unknown top-level key", () => {
    const doc = createDocument({
      sessionID: "ses_1",
      sessionTitle: "Test",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      promptVersion: 1,
      now: "2026-10-29T10:00:00.000Z",
    })
    expect(timelineDocumentSchema.safeParse({ ...doc, extra: true }).success).toBe(false)
    expect(parseDocument({ ...doc, extra: true })).toBeUndefined()
  })

  test("rejects a bad status and a negative counter", () => {
    const doc = createDocument({
      sessionID: "ses_1",
      sessionTitle: "Test",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      promptVersion: 1,
      now: "2026-10-29T10:00:00.000Z",
    })
    expect(timelineDocumentSchema.safeParse({ ...doc, status: "disabled" }).success).toBe(false)
    expect(timelineDocumentSchema.safeParse({ ...doc, meta: { ...doc.meta, callCount: -1 } }).success).toBe(false)
  })

  test("accepts a plan highlight kind", () => {
    const doc = createDocument({
      sessionID: "ses_1",
      sessionTitle: "Test",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      promptVersion: 1,
      now: "2026-10-29T10:00:00.000Z",
    })
    doc.chapters = [
      chapter({
        highlights: [{ ...highlight(), kind: "plan" } as unknown as TimelineHighlight],
      }),
    ]

    expect(parseDocument(doc)).toEqual(doc)
  })
})

describe("deriveHeader", () => {
  test("counts tasks and lists open and blocked titles", () => {
    const tasks: TimelineTask[] = [
      { key: "a", title: "Done task", status: "done", anchorMessageID: null, updatedAt: "2026-10-29T10:00:00.000Z" },
      { key: "b", title: "Open task", status: "open", anchorMessageID: null, updatedAt: "2026-10-29T10:00:00.000Z" },
      {
        key: "c",
        title: "Blocked task",
        status: "blocked",
        anchorMessageID: null,
        updatedAt: "2026-10-29T10:00:00.000Z",
      },
    ]
    const header = deriveHeader(documentWith([], tasks))
    expect(header.tasks).toEqual({
      total: 3,
      done: 1,
      open: 1,
      blocked: 1,
      openTitles: ["Open task"],
      blockedTitles: ["Blocked task"],
    })
  })

  test("deduplicates decisions by normalized text and keeps the latest five", () => {
    const chapters = [
      chapter({
        id: "ch_old",
        highlights: [
          highlight({ id: "old", kind: "decision", text: "  DECISION   0 " }),
          highlight({ id: "d1", kind: "decision", text: decisionText(1) }),
        ],
      }),
      chapter({
        id: "ch_new",
        highlights: [
          highlight({ id: "d2", kind: "decision", text: decisionText(2) }),
          highlight({ id: "d3", kind: "decision", text: decisionText(3) }),
          highlight({ id: "d4", kind: "decision", text: decisionText(4) }),
          highlight({ id: "d5", kind: "decision", text: decisionText(5) }),
          highlight({ id: "d6", kind: "decision", text: decisionText(6) }),
        ],
      }),
    ]

    const header = deriveHeader(documentWith(chapters))
    expect(header.decisions.map((decision) => decision.id)).toEqual(["d6", "d5", "d4", "d3", "d2"])
    expect(header.decisions.some((decision) => decision.id === "old")).toBe(false)
  })

  test("deduplicates artifact URLs and lets the newest PR state win", () => {
    const url = "https://github.com/acme/widgets/pull/42"
    const chapters = [
      chapter({
        id: "ch_old",
        highlights: [
          highlight({ id: "pr_old", kind: "pr", text: "Open PR", artifact: { type: "pr", url, state: "opened" } }),
        ],
      }),
      chapter({
        id: "ch_new",
        highlights: [
          highlight({ id: "pr_new", kind: "pr", text: "Merge PR", artifact: { type: "pr", url, state: "merged" } }),
        ],
      }),
    ]

    const header = deriveHeader(documentWith(chapters))
    expect(header.artifacts).toHaveLength(1)
    expect(header.artifacts[0]).toMatchObject({
      id: "pr_new",
      chapterID: "ch_new",
      type: "pr",
      label: "PR #42",
      url,
      state: "merged",
    })
  })

  test("deduplicates commit URLs by SHA and keeps no PR state", () => {
    const url = "https://github.com/acme/widgets/commit/abcdef1234567890"
    const chapters = [
      chapter({
        id: "ch_1",
        highlights: [
          highlight({
            id: "commit_1",
            kind: "commit",
            text: "Commit first",
            artifact: { type: "commit", url },
          }),
          highlight({
            id: "commit_2",
            kind: "commit",
            text: "Commit again",
            artifact: { type: "commit", url: url.toUpperCase(), state: "merged" },
          }),
        ],
      }),
    ]

    const header = deriveHeader(documentWith(chapters))
    expect(header.artifacts).toHaveLength(1)
    expect(header.artifacts[0]).toMatchObject({
      id: "commit_2",
      type: "commit",
      label: "commit ABCDEF1",
      url: url.toUpperCase(),
    })
    expect(header.artifacts[0]?.state).toBeUndefined()
  })

  test("a PR artifact with merged state shows merged", () => {
    const chapters = [
      chapter({
        highlights: [
          highlight({
            id: "pr",
            kind: "pr",
            text: "Merged",
            artifact: { type: "pr", url: "https://github.com/acme/widgets/pull/7", state: "merged" },
          }),
        ],
      }),
    ]
    expect(deriveHeader(documentWith(chapters)).artifacts[0]?.state).toBe("merged")
  })

  test("an empty document has no tasks, decisions, or artifacts", () => {
    const header = deriveHeader(documentWith([]))
    expect(header.tasks).toEqual({
      total: 0,
      done: 0,
      open: 0,
      blocked: 0,
      openTitles: [],
      blockedTitles: [],
    })
    expect(header.decisions).toEqual([])
    expect(header.artifacts).toEqual([])
  })
})
