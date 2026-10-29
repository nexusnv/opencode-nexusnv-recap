import { randomUUID } from "node:crypto"
import type {
  TimelineChapter,
  TimelineDocument,
  TimelineHighlight,
  TimelineHighlightArtifact,
  TimelineModelRef,
  TimelineTask,
} from "../shared/types.js"
import type { ValidatedChapter, ValidatedHighlight, ValidatedOutput, ValidatedTask } from "./output.js"
import { normalizeText, slugify } from "./text.js"

export interface ApplyInput {
  output: ValidatedOutput
  now: string
  coveragePartial: boolean
  model: TimelineModelRef
  promptVersion: number
  /** Optional engine logger; logs IDs only, never prompt or message content. */
  log?: (message: string, data?: Record<string, unknown>) => void | undefined
}

export function applyOutput(document: TimelineDocument, input: ApplyInput): void {
  if (input.output.goal) document.goal = input.output.goal
  if (input.output.tasks !== null) document.tasks = reconcileTasks(document.tasks, input.output.tasks, input.now)

  for (const chapter of input.output.chapters) applyChapter(document, chapter, input)

  if (input.coveragePartial) {
    document.coverage.partial = true
    document.coverage.reason = "compacted-history"
  }
  document.meta.model = input.model
  document.meta.promptVersion = input.promptVersion
}

function reconcileTasks(
  existing: readonly TimelineTask[],
  incoming: readonly ValidatedTask[],
  now: string,
): TimelineTask[] {
  const byKey = new Map(existing.map((task) => [task.key, task]))
  const byTitle = new Map(existing.map((task) => [normalizeText(task.title), task]))
  const result: TimelineTask[] = []
  const seen = new Set<string>()

  for (const task of incoming) {
    const requestedKey = slugify(task.key)
    const previous = byKey.get(requestedKey) ?? byTitle.get(normalizeText(task.title))
    // If the model renamed a key but kept the title, keep the original key so
    // the ledger stays stable across updates.
    const key = previous?.key ?? requestedKey
    if (seen.has(key)) continue
    seen.add(key)
    const anchorMessageID =
      task.anchorMessageID === undefined ? (previous?.anchorMessageID ?? null) : task.anchorMessageID
    const unchanged =
      previous !== undefined &&
      previous.title === task.title &&
      previous.status === task.status &&
      previous.anchorMessageID === anchorMessageID
    result.push({
      key,
      title: task.title,
      status: task.status,
      anchorMessageID,
      updatedAt: unchanged && previous ? previous.updatedAt : now,
    })
  }
  return result
}

function applyChapter(document: TimelineDocument, incoming: ValidatedChapter, input: ApplyInput): void {
  const now = input.now
  const highlights = dedupeHighlights(
    incoming.highlights.map(toHighlight).filter((highlight): highlight is TimelineHighlight => Boolean(highlight)),
  )
  if (highlights.length === 0) return

  const last = document.chapters[document.chapters.length - 1]
  if (incoming.mode === "extend" && last && incoming.chapterID !== last.id) {
    // Spec §7.2: log the stale extend; history is never rewritten. Session and
    // chapter IDs only — never highlight text or message content.
    input.log?.("extend targeted a non-current chapter; treated as new", {
      sessionID: document.sessionID,
      requestedChapterID: incoming.chapterID,
      currentChapterID: last.id,
    })
  }
  if (incoming.mode === "extend" && last && incoming.chapterID === last.id) {
    const existingText = new Set(last.highlights.map((highlight) => normalizeText(highlight.text)))
    const appended = dedupeHighlights(highlights, existingText)
    last.highlights.push(...appended)
    if (incoming.title) last.title = incoming.title
    if (incoming.summary) last.summary = incoming.summary
    if (appended.length > 0) {
      // Chapters are append-only in time: a later update may cite an older
      // message, but it must not rewind the chapter's start.
      last.endedAt = latest(last.endedAt, ...appended.map((highlight) => highlight.at))
    }
    last.updatedAt = now
    return
  }

  const chapter: TimelineChapter = {
    id: `ch_${randomUUID()}`,
    title: incoming.title || "Untitled chapter",
    summary: incoming.summary,
    startedAt: earliest(...highlights.map((highlight) => highlight.at)),
    endedAt: latest(...highlights.map((highlight) => highlight.at)),
    highlights,
    createdAt: now,
    updatedAt: now,
  }
  document.chapters.push(chapter)
}

function dedupeHighlights(highlights: readonly TimelineHighlight[], seen = new Set<string>()): TimelineHighlight[] {
  return highlights.filter((highlight) => {
    const key = normalizeText(highlight.text)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function toHighlight(highlight: ValidatedHighlight): TimelineHighlight | undefined {
  if (!highlight.anchorMessageID || !highlight.text) return undefined
  const artifact = toArtifact(highlight.artifact)
  return {
    id: `hl_${randomUUID()}`,
    kind: highlight.kind,
    text: highlight.text,
    at: highlight.at,
    anchorMessageID: highlight.anchorMessageID,
    ...(highlight.task ? { task: highlight.task } : {}),
    ...(artifact ? { artifact } : {}),
  }
}

function toArtifact(artifact: ValidatedHighlight["artifact"]): TimelineHighlightArtifact | undefined {
  if (!artifact) return undefined
  // Commit artifacts carry no PR state. `parseModelOutput` strips it, but
  // `applyOutput` is also called with directly constructed validated output
  // and must enforce the invariant itself.
  if (artifact.type === "commit") {
    return { type: "commit", ...(artifact.url ? { url: artifact.url } : {}) }
  }
  return artifact
}

function earliest(...values: string[]): string {
  return values.reduce(
    (min, value) => (Date.parse(value) < Date.parse(min) ? value : min),
    values[0] ?? new Date(0).toISOString(),
  )
}

function latest(...values: string[]): string {
  return values.reduce(
    (max, value) => (Date.parse(value) > Date.parse(max) ? value : max),
    values[0] ?? new Date(0).toISOString(),
  )
}
