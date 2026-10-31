import type { Context } from "@opencode/plugin/tui/context"
import type { TimelineHighlight, TimelineHighlightKind, TimelineStatus } from "../shared/types.js"

export function relativeTime(iso: string, now = Date.now()): string {
  const value = Date.parse(iso)
  if (!Number.isFinite(value)) return "unknown"
  const seconds = Math.max(0, Math.floor((now - value) / 1_000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function statusColor(context: Context, status: TimelineStatus, disabled: boolean, busy: boolean) {
  if (disabled) return context.theme.text.muted
  if (busy || status === "backfilling") return context.theme.text.feedback.info.base
  if (status === "error") return context.theme.text.feedback.error.base
  if (status === "stale" || status === "paused") return context.theme.text.feedback.warning.base
  if (status === "ready") return context.theme.text.feedback.success.base
  return context.theme.text.muted
}

export function glyph(kind: TimelineHighlightKind): string {
  switch (kind) {
    case "decision":
      return "◆"
    case "implementation":
      return "✦"
    case "task":
      return "✓"
    case "pr":
      return "⇗"
    case "commit":
      return "⌁"
    case "issue":
      return "◇"
    case "note":
      return "·"
    case "plan":
      return "→"
  }
}

export function taskSummary(tasks: {
  total: number
  done: number
  open: number
  blocked: number
  openTitles: string[]
  blockedTitles: string[]
}): string {
  if (tasks.total === 0) return "No tasks"
  const parts = [`${tasks.done}/${tasks.total} done`]
  if (tasks.open > 0) parts.push(`open: ${tasks.openTitles.join(", ") || tasks.open}`)
  if (tasks.blocked > 0) parts.push(`blocked: ${tasks.blockedTitles.join(", ") || tasks.blocked}`)
  return parts.join("   ")
}

export function compactChapterRange(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "unknown"
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`
  if (start.toDateString() === end.toDateString()) {
    return `${startTime}–${pad(end.getHours())}:${pad(end.getMinutes())}`
  }
  return `${start.getMonth() + 1}/${start.getDate()} ${startTime}`
}

export function statusWord(status: TimelineStatus, disabled: boolean, busy: boolean): string | undefined {
  if (disabled) return "disabled"
  if (busy) return status === "backfilling" ? "building" : "updating"
  switch (status) {
    case "ready":
      return undefined
    case "empty":
      return "not built"
    case "backfilling":
      return "building"
    case "paused":
      return "paused"
    case "stale":
      return "stale"
    case "error":
      return "error"
  }
}

export function kindColor(context: Context, highlight: TimelineHighlight) {
  switch (highlight.kind) {
    case "decision":
    case "issue":
      return context.theme.text.feedback.warning.base
    case "implementation":
    case "pr":
    case "commit":
      return context.theme.text.action.primary.base
    case "task":
      if (highlight.task?.status === "done") return context.theme.text.feedback.success.base
      if (highlight.task?.status === "blocked") return context.theme.text.feedback.error.base
      return context.theme.text.feedback.warning.base
    case "note":
      return context.theme.text.muted
    case "plan":
      return context.theme.text.feedback.info.base
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}
