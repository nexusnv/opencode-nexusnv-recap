import { z } from "zod"
import type { TimelineDocument, TimelineHeader, TimelineHighlight, TimelineModelRef } from "./types.js"

const statusSchema = z.enum(["empty", "backfilling", "paused", "ready", "stale", "error"])
const taskStatusSchema = z.enum(["open", "done", "blocked"])
const kindSchema = z.enum(["decision", "implementation", "task", "pr", "commit", "issue", "note", "plan"])
const artifactSchema = z.strictObject({
  type: z.enum(["pr", "commit"]),
  url: z.string().optional(),
  state: z.enum(["opened", "merged", "closed"]).optional(),
})
const highlightSchema = z.strictObject({
  id: z.string().min(1),
  kind: kindSchema,
  text: z.string().min(1),
  at: z.string().min(1),
  anchorMessageID: z.string().min(1),
  task: z.strictObject({ key: z.string().min(1), status: taskStatusSchema }).optional(),
  artifact: artifactSchema.optional(),
})
const chapterSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  highlights: z.array(highlightSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
const watermarkSchema = z.strictObject({
  messageID: z.string().min(1),
  createdAt: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
})
const backfillSchema = z.strictObject({
  processedMessages: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  cancelled: z.boolean().optional(),
  error: z.string().optional(),
})
const errorSchema = z.strictObject({
  message: z.string(),
  at: z.string(),
  retryable: z.boolean(),
  kind: z.enum(["model", "config", "storage", "invalid-output", "unknown"]),
})
const noticeSchema = z.strictObject({
  kind: z.enum(["history-changed", "hourly-cap"]),
  message: z.string(),
  at: z.string(),
})
const metaSchema = z.strictObject({
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastCheckedAt: z.string().min(1),
  model: z.strictObject({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    variant: z.string().optional(),
  }),
  promptVersion: z.number().int().nonnegative(),
  callCount: z.number().int().nonnegative(),
  recentAutoCalls: z.array(z.string()),
  estimatedInputChars: z.number().int().nonnegative(),
  lastError: errorSchema.optional(),
  notice: noticeSchema.optional(),
})

export const timelineDocumentSchema: z.ZodType<TimelineDocument> = z.strictObject({
  version: z.literal(1),
  sessionID: z.string().min(1),
  sessionTitle: z.string().nullable(),
  goal: z.string().nullable(),
  status: statusSchema,
  coverage: z.strictObject({
    partial: z.boolean(),
    reason: z.enum(["compacted-history", "pagination-limit"]).optional(),
  }),
  tasks: z.array(
    z.strictObject({
      key: z.string().min(1),
      title: z.string(),
      status: taskStatusSchema,
      anchorMessageID: z.string().nullable(),
      updatedAt: z.string().min(1),
    }),
  ),
  chapters: z.array(chapterSchema),
  watermark: watermarkSchema.nullable(),
  backfill: backfillSchema.nullable(),
  meta: metaSchema,
})

export interface CreateDocumentInput {
  sessionID: string
  sessionTitle: string | null
  model: TimelineModelRef
  promptVersion: number
  now: string
}

export function createDocument(input: CreateDocumentInput): TimelineDocument {
  return {
    version: 1,
    sessionID: input.sessionID,
    sessionTitle: input.sessionTitle,
    goal: null,
    status: "empty",
    coverage: { partial: false },
    tasks: [],
    chapters: [],
    watermark: null,
    backfill: null,
    meta: {
      createdAt: input.now,
      updatedAt: input.now,
      lastCheckedAt: input.now,
      model: input.model,
      promptVersion: input.promptVersion,
      callCount: 0,
      recentAutoCalls: [],
      estimatedInputChars: 0,
    },
  }
}

export function parseDocument(value: unknown): TimelineDocument | undefined {
  const result = timelineDocumentSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

export function artifactKey(highlight: TimelineHighlight): string | undefined {
  const artifact = highlight.artifact
  if (!artifact) return undefined
  const url = artifact.url ?? ""
  const commit = /\/commit\/([0-9a-f]{7,40})/i.exec(url)
  if (commit?.[1]) return `commit:${commit[1].toLowerCase()}`
  if (url) return `url:${url}`
  return `text:${normalizeText(highlight.text)}`
}

function artifactLabel(highlight: TimelineHighlight): string {
  const artifact = highlight.artifact
  const url = artifact?.url ?? ""
  const pr = /\/pull\/(\d+)/.exec(url)
  if (pr?.[1]) return `PR #${pr[1]}`
  const commit = /\/commit\/([0-9a-f]{7,40})/i.exec(url)
  if (commit?.[1]) return `commit ${commit[1].slice(0, 7)}`
  return highlight.text
}

export function deriveHeader(document: TimelineDocument): TimelineHeader {
  const decisions: TimelineHeader["decisions"] = []
  const seenDecisions = new Set<string>()
  const artifacts: TimelineHeader["artifacts"] = []
  const seenArtifacts = new Map<string, number>()

  for (let c = document.chapters.length - 1; c >= 0; c -= 1) {
    const chapter = document.chapters[c]
    if (!chapter) continue
    for (let h = chapter.highlights.length - 1; h >= 0; h -= 1) {
      const highlight = chapter.highlights[h]
      if (!highlight) continue
      if (highlight.kind === "decision") {
        const key = normalizeText(highlight.text)
        if (!seenDecisions.has(key)) {
          seenDecisions.add(key)
          decisions.push({ id: highlight.id, chapterID: chapter.id, text: highlight.text, at: highlight.at })
        }
      }
      const key = artifactKey(highlight)
      if (key && highlight.artifact) {
        const existing = seenArtifacts.get(key)
        if (existing === undefined) {
          seenArtifacts.set(key, artifacts.length)
          artifacts.push({
            id: highlight.id,
            chapterID: chapter.id,
            type: highlight.artifact.type,
            label: artifactLabel(highlight),
            url: highlight.artifact.url,
            ...(highlight.artifact.type === "pr" && highlight.artifact.state
              ? { state: highlight.artifact.state }
              : {}),
            at: highlight.at,
          })
        } else {
          // Reverse chronological walk: the first sighting is the newest.
          // Only fill a missing state from an older PR highlight; never let an
          // older "opened" overwrite a newer "merged". Commits have no state.
          const entry = artifacts[existing]
          if (entry && entry.state === undefined && highlight.artifact.type === "pr" && highlight.artifact.state) {
            entry.state = highlight.artifact.state
          }
        }
      }
    }
  }

  const done = document.tasks.filter((task) => task.status === "done").length
  const blocked = document.tasks.filter((task) => task.status === "blocked")
  const open = document.tasks.filter((task) => task.status === "open")
  return {
    goal: document.goal,
    tasks: {
      total: document.tasks.length,
      done,
      open: open.length,
      blocked: blocked.length,
      openTitles: open.map((task) => task.title).slice(0, 4),
      blockedTitles: blocked.map((task) => task.title).slice(0, 4),
    },
    decisions: decisions.slice(0, 5),
    artifacts: artifacts.slice(0, 5),
  }
}
