import type { Context } from "@opencode/plugin/tui/context"
import type { TimelineHighlightKind, TimelineStatus } from "../shared/types.js"

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

export function chapterRange(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "unknown"
  const startTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`
  const endTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`
  if (start.toDateString() === end.toDateString()) return `${startTime}–${endTime}`
  return `${start.toLocaleDateString()} ${startTime}–${end.toLocaleDateString()} ${endTime}`
}

export function statusLabel(status: TimelineStatus, disabled: boolean, busy: boolean): string {
  if (disabled) return "DISABLED"
  if (busy) return "BACKFILLING"
  switch (status) {
    case "empty":
      return "EMPTY"
    case "backfilling":
      return "BACKFILLING"
    case "paused":
      return "PAUSED"
    case "ready":
      return "READY"
    case "stale":
      return "STALE"
    case "error":
      return "ERROR"
  }
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

export function artifactSummary(artifacts: Array<{ label: string; state?: string | undefined }>): string {
  if (artifacts.length === 0) return "None"
  return artifacts
    .map((artifact) => (artifact.state ? `${artifact.label} ${artifact.state}` : artifact.label))
    .join("; ")
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}
