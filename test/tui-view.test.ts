import { describe, expect, test } from "bun:test"
import { createDocument, deriveHeader } from "../src/shared/document"
import type { TimelineChapter, TimelineHighlight } from "../src/shared/types"
import { clampSelection, flattenRows, headerModel, newestChapterID } from "../src/tui/view"
import { TEST_MODEL } from "./helpers/engine"

const NOW = "2026-10-29T10:00:00.000Z"

function highlight(id: string, text: string): TimelineHighlight {
  return {
    id,
    kind: "implementation",
    text,
    at: NOW,
    anchorMessageID: `msg_${id}`,
  }
}

function chapter(id: string, highlights: TimelineHighlight[]): TimelineChapter {
  return {
    id,
    title: `Chapter ${id}`,
    summary: `Summary ${id}`,
    startedAt: NOW,
    endedAt: NOW,
    highlights,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function documentWith(chapters: TimelineChapter[]) {
  const document = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test",
    model: TEST_MODEL,
    promptVersion: 1,
    now: NOW,
  })
  document.chapters = chapters
  return document
}

describe("flattenRows", () => {
  test("collapsed chapters produce one row each", () => {
    const document = documentWith([chapter("c1", [highlight("h1", "one")]), chapter("c2", [highlight("h2", "two")])])
    const rows = flattenRows(document, new Set())

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.kind)).toEqual(["chapter", "chapter"])
    expect(rows.map((row) => row.kind === "chapter" && row.expanded)).toEqual([false, false])
  })

  test("expanded chapters produce the chapter followed by its highlights", () => {
    const document = documentWith([
      chapter("c1", [highlight("h1", "one"), highlight("h2", "two")]),
      chapter("c2", [highlight("h3", "three")]),
    ])
    const rows = flattenRows(document, new Set(["c1"]))

    expect(rows.map((row) => row.kind)).toEqual(["chapter", "highlight", "highlight", "chapter"])
    expect(rows.map((row) => row.ordinal)).toEqual([0, 1, 2, 3])
    expect(rows[1]?.kind === "highlight" && rows[1].highlight.id).toBe("h1")
    expect(rows[2]?.kind === "highlight" && rows[2].highlight.id).toBe("h2")
  })

  test("ordinals are contiguous across mixed expansion", () => {
    const document = documentWith([
      chapter("c1", [highlight("h1", "one")]),
      chapter("c2", [highlight("h2", "two"), highlight("h3", "three")]),
    ])
    const rows = flattenRows(document, new Set(["c2"]))

    expect(rows.map((row) => row.ordinal)).toEqual([0, 1, 2, 3])
  })
})

describe("clampSelection", () => {
  test("handles an empty list", () => {
    expect(clampSelection(5, [])).toBe(0)
  })

  test("clamps negative and out-of-range indexes", () => {
    const document = documentWith([chapter("c1", [])])
    const rows = flattenRows(document, new Set())
    expect(clampSelection(-3, rows)).toBe(0)
    expect(clampSelection(99, rows)).toBe(0)
  })

  test("keeps an in-range index", () => {
    const document = documentWith([chapter("c1", []), chapter("c2", [])])
    const rows = flattenRows(document, new Set())
    expect(clampSelection(1, rows)).toBe(1)
  })
})

describe("document helpers", () => {
  test("headerModel delegates to deriveHeader", () => {
    const document = documentWith([chapter("c1", [])])
    expect(headerModel(document)).toEqual(deriveHeader(document))
  })

  test("newestChapterID returns the last chapter", () => {
    const document = documentWith([chapter("c1", []), chapter("c2", [])])
    expect(newestChapterID(document)).toBe("c2")
    expect(newestChapterID(documentWith([]))).toBeUndefined()
  })
})
