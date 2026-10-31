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

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).nullish(),
)

const taskSchema = z.object({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  status: z.enum(["open", "done", "blocked"]),
  anchor: optionalTrimmedString,
})

const artifactSchema = z.object({
  type: z.enum(["pr", "commit"]),
  url: z.string().trim().nullish(),
  state: z.string().trim().nullish(),
})

const highlightSchema = z.object({
  kind: z.enum(["decision", "implementation", "task", "pr", "commit", "issue", "note", "plan"]),
  text: z.string().min(1),
  anchor: z.string().min(1),
  artifact: artifactSchema.nullish(),
})

const chapterSchema = z.object({
  mode: z.enum(["extend", "new"]),
  chapterID: optionalTrimmedString,
  title: z.string(),
  summary: z.string(),
  highlights: z.array(z.unknown()),
})

type DecodeResult = { ok: true; value: unknown } | { ok: false; error: string }

export function parseModelOutput(raw: string, aliases: ReadonlyMap<string, DigestAlias>): ParseResult {
  const decoded = decodeJson(raw)
  if (!decoded.ok) return decoded

  const top = topSchema.safeParse(decoded.value)
  if (!top.success) return { ok: false, error: formatZod(top.error) }

  const goal = top.data.goal.trim() || null
  const tasks = top.data.tasks === null ? null : parseTasks(top.data.tasks, aliases)
  const chapters = parseChapters(top.data.chapters, aliases)

  return { ok: true, output: { goal, tasks, chapters } }
}

function parseTasks(values: readonly unknown[], aliases: ReadonlyMap<string, DigestAlias>): ValidatedTask[] | null {
  const byKey = new Map<string, ValidatedTask>()
  for (const value of values.slice(0, 100)) {
    const parsed = taskSchema.safeParse(value)
    if (!parsed.success) continue
    const key = slugify(parsed.data.key)
    const anchor = parsed.data.anchor ? aliases.get(parsed.data.anchor) : undefined
    byKey.set(key, {
      key,
      title: truncate(parsed.data.title, 60),
      status: parsed.data.status,
      ...(parsed.data.anchor ? { anchorMessageID: anchor?.messageID ?? null } : {}),
    })
  }
  if (values.length > 0 && byKey.size === 0) return null
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
      title: truncate(parsed.data.title.trim(), 60),
      summary: truncate(parsed.data.summary.trim(), 180),
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
    const text = truncate(parsed.data.text.trim(), 160)
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
  url?: string | null | undefined
  state?: string | null | undefined
}): ValidatedHighlight["artifact"] {
  // Spec §7.4: a URL that is not http(s) is dropped together with the artifact;
  // the highlight itself is still kept.
  const url = artifact.url?.trim() || undefined
  if (url !== undefined && !isHttpUrl(url)) return undefined
  if (artifact.type === "commit") return { type: "commit", ...(url ? { url } : {}) }
  const state = validArtifactState(artifact.state)
  return {
    type: "pr",
    ...(url ? { url } : {}),
    ...(state ? { state } : {}),
  }
}

function validArtifactState(state: string | null | undefined): "opened" | "merged" | "closed" | undefined {
  return state === "opened" || state === "merged" || state === "closed" ? state : undefined
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function decodeJson(raw: string): DecodeResult {
  const trimmed = raw.trim()
  let directError: unknown
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch (error) {
    directError = error
  }

  // A whole-response fence must capture greedily so fence pairs inside JSON
  // strings do not terminate the body early.
  const wholeFence = /^```[^\n]*\r?\n([\s\S]*)\r?\n?```$/i.exec(trimmed)
  if (wholeFence) {
    try {
      return { ok: true, value: JSON.parse(wholeFence[1]?.trim() ?? "") }
    } catch {
      // Fall through to scanning individual fenced blocks.
    }
  }

  const blocks = /```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n)?([\s\S]*?)```/g
  let fallback: { value: unknown } | undefined
  for (const match of trimmed.matchAll(blocks)) {
    const body = match[1]?.trim()
    if (!body) continue
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      continue
    }
    if (isJsonObject(value)) return { ok: true, value }
    fallback ??= { value }
  }
  if (fallback) return { ok: true, ...fallback }
  return { ok: false, error: `Invalid JSON: ${messageOf(directError)}` }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatZod(error: z.ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
  return issues.length > 0 ? issues.join("; ") : "invalid output"
}

function truncate(text: string, max: number): string {
  return [...text].slice(0, max).join("")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
