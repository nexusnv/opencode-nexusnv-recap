import type { TimelineDocument, TimelineHighlight } from "../shared/types.js"

export const PHASE_DWELL_MS = 5_000
export const NEWEST_PHASE_DWELL_MS = 8_000
export const PHASE_DWELL_MAX_MS = 15_000
const DWELL_GROWTH_START_COLUMNS = 24
const DWELL_GROWTH_PER_COLUMN_MS = 150

export interface SidebarPhase {
  id: string
  title: string
  startedAt: string
  endedAt: string
  current: boolean
}

export interface SidebarNow {
  chapterID: string
  chapterTitle: string
  highlight: TimelineHighlight | null
}

export interface SidebarNext {
  chapterID: string
  highlight: TimelineHighlight
}

export interface SidebarView {
  phases: SidebarPhase[]
  now: SidebarNow | null
  next: SidebarNext | null
}

export function deriveSidebar(document: TimelineDocument): SidebarView {
  const phases = document.chapters.map((chapter, index) => ({
    id: chapter.id,
    title: chapter.title,
    startedAt: chapter.startedAt,
    endedAt: chapter.endedAt,
    current: index === document.chapters.length - 1,
  }))

  const newest = document.chapters[document.chapters.length - 1]
  const now = newest
    ? {
        chapterID: newest.id,
        chapterTitle: newest.title,
        highlight: latestWhere(newest.highlights, (highlight) => highlight.kind !== "plan"),
      }
    : null

  return { phases, now, next: newestPlan(document) }
}

export function nextPhaseID(phases: readonly SidebarPhase[], currentID: string | undefined): string | undefined {
  if (phases.length === 0) return undefined
  const index = currentID === undefined ? -1 : phases.findIndex((phase) => phase.id === currentID)
  if (index < 0) return phases[0]?.id
  return phases[(index + 1) % phases.length]?.id
}

export function phasePosition(
  phases: readonly SidebarPhase[],
  currentID: string | undefined,
): { current: number; total: number } {
  const total = phases.length
  if (currentID === undefined || total === 0) return { current: 0, total }
  const index = phases.findIndex((phase) => phase.id === currentID)
  return { current: index < 0 ? 0 : index + 1, total }
}

export function phaseDwellMs(title: string, newest: boolean): number {
  const base = newest ? NEWEST_PHASE_DWELL_MS : PHASE_DWELL_MS
  const columns = Bun.stringWidth(title.replace(/\s+/g, " "))
  const extra = Math.max(0, columns - DWELL_GROWTH_START_COLUMNS) * DWELL_GROWTH_PER_COLUMN_MS
  return Math.min(PHASE_DWELL_MAX_MS, base + extra)
}

export function normalizePlanText(text: string): string {
  return text
    .replace(/^\s*(?:next|plan|todo)\s*[:–—-]\s*/i, "")
    .replace(/^\s*→\s*/, "")
    .trim()
}

function latestWhere(
  highlights: readonly TimelineHighlight[],
  predicate: (highlight: TimelineHighlight) => boolean,
): TimelineHighlight | null {
  for (let index = highlights.length - 1; index >= 0; index -= 1) {
    const highlight = highlights[index]
    if (highlight && predicate(highlight)) return highlight
  }
  return null
}

function newestPlan(document: TimelineDocument): SidebarNext | null {
  for (let c = document.chapters.length - 1; c >= 0; c -= 1) {
    const chapter = document.chapters[c]
    if (!chapter) continue
    for (let h = chapter.highlights.length - 1; h >= 0; h -= 1) {
      const highlight = chapter.highlights[h]
      if (highlight?.kind === "plan") return { chapterID: chapter.id, highlight }
    }
  }
  return null
}
