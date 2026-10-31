import { describe, expect, test } from "bun:test"
import { createDocument } from "../src/shared/document"
import type { TimelineChapter, TimelineHighlight, TimelineHighlightKind } from "../src/shared/types"
import {
  NEWEST_PHASE_DWELL_MS,
  PHASE_DWELL_MAX_MS,
  PHASE_DWELL_MS,
  deriveSidebar,
  nextPhaseID,
  normalizePlanText,
  phaseDwellMs,
  phasePosition,
} from "../src/tui/sidebar-view"
import { TEST_MODEL } from "./helpers/engine"

const NOW = "2026-10-29T10:00:00.000Z"
const LATER = "2026-10-29T10:10:00.000Z"

function highlight(
  id: string,
  kind: TimelineHighlightKind,
  text: string,
  at = NOW,
  task?: TimelineHighlight["task"],
): TimelineHighlight {
  return {
    id,
    kind,
    text,
    at,
    anchorMessageID: `msg_${id}`,
    ...(task ? { task } : {}),
  }
}

function chapter(
  id: string,
  highlights: TimelineHighlight[],
  overrides: Partial<TimelineChapter> = {},
): TimelineChapter {
  return {
    id,
    title: `Chapter ${id}`,
    summary: `Summary ${id}`,
    startedAt: NOW,
    endedAt: LATER,
    highlights,
    createdAt: NOW,
    updatedAt: LATER,
    ...overrides,
  }
}

function documentWith(chapters: TimelineChapter[]) {
  const document = createDocument({
    sessionID: "ses_1",
    sessionTitle: "Test",
    model: TEST_MODEL,
    promptVersion: 2,
    now: NOW,
  })
  document.chapters = chapters
  return document
}

describe("deriveSidebar", () => {
  test("lists chapters in order and marks only the newest as current", () => {
    const view = deriveSidebar(
      documentWith([
        chapter("c1", [highlight("h1", "implementation", "First")]),
        chapter("c2", [highlight("h2", "implementation", "Second")]),
      ]),
    )

    expect(view.phases.map((phase) => phase.id)).toEqual(["c1", "c2"])
    expect(view.phases.map((phase) => phase.current)).toEqual([false, true])
    expect(view.phases.map((phase) => phase.title)).toEqual(["Chapter c1", "Chapter c2"])
  })

  test("uses the newest chapter's latest non-plan highlight for now", () => {
    const view = deriveSidebar(
      documentWith([
        chapter("c1", [highlight("old", "implementation", "Old work")]),
        chapter("c2", [
          highlight("d1", "decision", "Use SQLite"),
          highlight("i1", "implementation", "Built the sidebar"),
          highlight("p1", "plan", "Next: add tests"),
        ]),
      ]),
    )

    expect(view.now?.chapterID).toBe("c2")
    expect(view.now?.chapterTitle).toBe("Chapter c2")
    expect(view.now?.highlight?.id).toBe("i1")
    expect(view.next?.highlight.id).toBe("p1")
  })

  test("returns the chapter title alone when the newest chapter only has plans", () => {
    const view = deriveSidebar(documentWith([chapter("c1", [highlight("p1", "plan", "Next: add tests")])]))

    expect(view.now?.chapterID).toBe("c1")
    expect(view.now?.chapterTitle).toBe("Chapter c1")
    expect(view.now?.highlight).toBeNull()
    expect(view.next?.highlight.id).toBe("p1")
  })

  test("uses the newest plan across all chapters for next", () => {
    const view = deriveSidebar(
      documentWith([
        chapter("c1", [highlight("p1", "plan", "Next: add export")]),
        chapter("c2", [highlight("i1", "implementation", "Built the export")]),
        chapter("c3", [highlight("p2", "plan", "Next: add docs")]),
      ]),
    )

    expect(view.next?.chapterID).toBe("c3")
    expect(view.next?.highlight.id).toBe("p2")
  })

  test("finds a plan in an older chapter when the newest chapter has none", () => {
    const view = deriveSidebar(
      documentWith([
        chapter("c1", [highlight("p1", "plan", "Next: add export")]),
        chapter("c2", [highlight("i1", "implementation", "Built the export")]),
      ]),
    )

    expect(view.next?.chapterID).toBe("c1")
    expect(view.next?.highlight.id).toBe("p1")
  })

  test("returns null next when no plan exists", () => {
    const view = deriveSidebar(documentWith([chapter("c1", [highlight("i1", "implementation", "Built it")])]))

    expect(view.next).toBeNull()
  })

  test("returns an empty view for a document with no chapters", () => {
    expect(deriveSidebar(documentWith([]))).toEqual({ phases: [], now: null, next: null })
  })
})

describe("nextPhaseID", () => {
  const phases = deriveSidebar(
    documentWith([
      chapter("c1", [highlight("h1", "implementation", "First")]),
      chapter("c2", [highlight("h2", "implementation", "Second")]),
      chapter("c3", [highlight("h3", "implementation", "Third")]),
    ]),
  ).phases

  test("advances to the next phase", () => {
    expect(nextPhaseID(phases, "c1")).toBe("c2")
  })

  test("loops from the newest phase to the oldest", () => {
    expect(nextPhaseID(phases, "c3")).toBe("c1")
  })

  test("falls back to the first phase for an unknown or missing id", () => {
    expect(nextPhaseID(phases, "missing")).toBe("c1")
    expect(nextPhaseID(phases, undefined)).toBe("c1")
  })

  test("returns undefined when there are no phases", () => {
    expect(nextPhaseID([], "c1")).toBeUndefined()
  })
})

describe("phaseDwellMs", () => {
  test("holds the newest phase longer than older phases", () => {
    expect(phaseDwellMs("Short", false)).toBe(PHASE_DWELL_MS)
    expect(phaseDwellMs("Short", true)).toBe(NEWEST_PHASE_DWELL_MS)
  })

  test("grows for long titles and caps at the maximum", () => {
    expect(phaseDwellMs("A".repeat(40), false)).toBeGreaterThan(PHASE_DWELL_MS)
    expect(phaseDwellMs("A".repeat(200), true)).toBe(PHASE_DWELL_MAX_MS)
  })
})

describe("normalizePlanText", () => {
  test("strips a redundant plan prefix", () => {
    expect(normalizePlanText("Next: add export")).toBe("add export")
    expect(normalizePlanText("Plan — add docs")).toBe("add docs")
    expect(normalizePlanText("TODO - add tests")).toBe("add tests")
    expect(normalizePlanText("→ ship it")).toBe("ship it")
  })

  test("leaves plain text alone", () => {
    expect(normalizePlanText("Add export")).toBe("Add export")
  })
})

describe("phasePosition", () => {
  const phases = deriveSidebar(
    documentWith([
      chapter("c1", [highlight("h1", "implementation", "First")]),
      chapter("c2", [highlight("h2", "implementation", "Second")]),
    ]),
  ).phases

  test("returns a one-based position and the total", () => {
    expect(phasePosition(phases, "c2")).toEqual({ current: 2, total: 2 })
  })

  test("returns zero for an unknown or missing id", () => {
    expect(phasePosition(phases, "missing")).toEqual({ current: 0, total: 2 })
    expect(phasePosition(phases, undefined)).toEqual({ current: 0, total: 2 })
  })

  test("returns zero for no phases", () => {
    expect(phasePosition([], "c1")).toEqual({ current: 0, total: 0 })
  })
})
