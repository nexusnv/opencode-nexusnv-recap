import { z } from "zod"
import type { TimelineHighlightKind } from "../shared/types.js"
import type { DigestAlias } from "./digest.js"
import { normalizeText, slugify } from "./text.js"

export interface ValidatedTask {
  key: string
  title: string
  status: "open" | "done" | "blocked"
  /**
   * `undefined` means the model omitted the anchor (preserve the previous one);
   * `null` means the model cited an alias that is not in this digest (clear it).
   */
  anchorMessageID?: string | null | undefined
}

export interface ValidatedHighlight {
  kind: TimelineHighlightKind
  text: string
  at: string
  anchorMessageID: string
  task?: { key: string; status: "open" | "done" | "blocked" } | undefined
  artifact?:
    { type: "pr" | "commit"; url?: string | undefined; state?: "opened" | "merged" | "closed" | undefined } | undefined
}

export interface ValidatedChapter {
  mode: "extend" | "new"
  chapterID?: string | undefined
  title: string
  summary: string
  highlights: ValidatedHighlight[]
}

export interface ValidatedOutput {
  goal: string | null
  tasks: ValidatedTask[] | null
  chapters: ValidatedChapter[]
}

export type ParseResult = { ok: true; output: ValidatedOutput } | { ok: false; error: string }

const topSchema = z.strictObject({
  goal: z.string(),
  tasks: z.array(z.unknown()).nullable(),
  chapters: z.array(z.unknown()),
})

const taskSchema = z.strictObject({
  key: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["open", "done", "blocked"]),
  anchor: z.string().min(1).optional(),
})

const artifactSchema = z.strictObject({
  type: z.enum(["pr", "commit"]),
  url: z.string().optional(),
  state: z.enum(["opened", "merged", "closed"]).optional(),
})

const highlightSchema = z.strictObject({
  kind: z.enum(["decision", "implementation", "task", "pr", "commit", "issue", "note"]),
  text: z.string().min(1),
  anchor: z.string().min(1),
  artifact: artifactSchema.optional(),
})

const chapterSchema = z.strictObject({
  mode: z.enum(["extend", "new"]),
  chapterID: z.string().min(1).optional(),
  title: z.string(),
  summary: z.string(),
  highlights: z.array(z.unknown()),
})

export function parseModelOutput(raw: string, aliases: ReadonlyMap<string, DigestAlias>): ParseResult {
  const json = unwrapFence(raw)
  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${messageOf(error)}` }
  }

  const top = topSchema.safeParse(decoded)
  if (!top.success) return { ok: false, error: formatZod(top.error) }

  const goal = top.data.goal.trim() || null
  const tasks = top.data.tasks === null ? null : parseTasks(top.data.tasks, aliases)
  const chapters = parseChapters(top.data.chapters, aliases)

  return { ok: true, output: { goal, tasks, chapters } }
}

function parseTasks(values: readonly unknown[], aliases: ReadonlyMap<string, DigestAlias>): ValidatedTask[] {
  const byKey = new Map<string, ValidatedTask>()
  for (const value of values.slice(0, 100)) {
    const parsed = taskSchema.safeParse(value)
    if (!parsed.success) continue
    const key = slugify(parsed.data.key)
    const anchor = parsed.data.anchor ? aliases.get(parsed.data.anchor) : undefined
    byKey.set(key, {
      key,
      title: parsed.data.title.trim().slice(0, 60),
      status: parsed.data.status,
      ...(parsed.data.anchor ? { anchorMessageID: anchor?.messageID ?? null } : {}),
    })
  }
  return [...byKey.values()]
}

function parseChapters(values: readonly unknown[], aliases: ReadonlyMap<string, DigestAlias>): ValidatedChapter[] {
  const chapters: ValidatedChapter[] = []
  for (const value of values.slice(0, 2)) {
    const parsed = chapterSchema.safeParse(value)
    if (!parsed.success) continue
    const highlights = parseHighlights(parsed.data.highlights, aliases)
    if (highlights.length === 0) continue
    chapters.push({
      mode: parsed.data.mode,
      ...(parsed.data.chapterID ? { chapterID: parsed.data.chapterID } : {}),
      title: parsed.data.title.trim().slice(0, 60),
      summary: parsed.data.summary.trim().slice(0, 180),
      highlights,
    })
  }
  return chapters
}

function parseHighlights(values: readonly unknown[], aliases: ReadonlyMap<string, DigestAlias>): ValidatedHighlight[] {
  const seen = new Set<string>()
  const highlights: ValidatedHighlight[] = []
  for (const value of values.slice(0, 5)) {
    const parsed = highlightSchema.safeParse(value)
    if (!parsed.success) continue
    const alias = aliases.get(parsed.data.anchor)
    if (!alias) continue
    const text = parsed.data.text.trim().slice(0, 160)
    if (!text) continue
    const key = normalizeText(text)
    if (seen.has(key)) continue
    seen.add(key)
    const artifact = parsed.data.artifact ? sanitizeArtifact(parsed.data.artifact) : undefined
    highlights.push({
      kind: parsed.data.kind,
      text,
      at: alias.createdAt,
      anchorMessageID: alias.messageID,
      ...(artifact ? { artifact } : {}),
    })
  }
  return highlights
}

function sanitizeArtifact(artifact: {
  type: "pr" | "commit"
  url?: string | undefined
  state?: "opened" | "merged" | "closed" | undefined
}): ValidatedHighlight["artifact"] {
  // Spec §7.4: a URL that is not http(s) is dropped together with the artifact;
  // the highlight itself is still kept.
  if (artifact.url !== undefined && !isHttpUrl(artifact.url)) return undefined
  const url = artifact.url
  if (artifact.type === "commit") return { type: "commit", ...(url ? { url } : {}) }
  return {
    type: "pr",
    ...(url ? { url } : {}),
    ...(artifact.state ? { state: artifact.state } : {}),
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function unwrapFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

function formatZod(error: z.ZodError): string {
  const first = error.issues[0]
  return first ? `${first.path.join(".") || "output"}: ${first.message}` : "invalid output"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
