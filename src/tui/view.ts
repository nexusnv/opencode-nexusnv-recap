import { deriveHeader } from "../shared/document.js"
import type { TimelineChapter, TimelineDocument, TimelineHeader, TimelineHighlight } from "../shared/types.js"

export type TimelineRow =
  | { kind: "chapter"; chapterID: string; chapter: TimelineChapter; expanded: boolean; ordinal: number }
  | {
      kind: "highlight"
      chapterID: string
      chapter: TimelineChapter
      highlight: TimelineHighlight
      ordinal: number
    }

export function headerModel(document: TimelineDocument): TimelineHeader {
  return deriveHeader(document)
}

export function flattenRows(document: TimelineDocument, expanded: ReadonlySet<string>): TimelineRow[] {
  const rows: TimelineRow[] = []
  let ordinal = 0
  for (const chapter of document.chapters) {
    const isExpanded = expanded.has(chapter.id)
    rows.push({ kind: "chapter", chapterID: chapter.id, chapter, expanded: isExpanded, ordinal })
    ordinal += 1
    if (!isExpanded) continue
    for (const highlight of chapter.highlights) {
      rows.push({ kind: "highlight", chapterID: chapter.id, chapter, highlight, ordinal })
      ordinal += 1
    }
  }
  return rows
}

export function clampSelection(index: number, rows: readonly TimelineRow[]): number {
  if (rows.length === 0) return 0
  return Math.max(0, Math.min(index, rows.length - 1))
}

export function newestChapterID(document: TimelineDocument): string | undefined {
  return document.chapters[document.chapters.length - 1]?.id
}
