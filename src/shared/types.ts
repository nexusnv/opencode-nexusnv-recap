export type TimelineStatus = "empty" | "backfilling" | "paused" | "ready" | "stale" | "error"

export interface TimelineModelRef {
  providerID: string
  modelID: string
  variant?: string | undefined
}

export interface TimelineTask {
  key: string
  title: string
  status: "open" | "done" | "blocked"
  anchorMessageID: string | null
  updatedAt: string
}

export type TimelineHighlightKind =
  | "decision"
  | "implementation"
  | "task"
  | "pr"
  | "commit"
  | "issue"
  | "note"
  | "plan"

export interface TimelineHighlightArtifact {
  type: "pr" | "commit"
  url?: string | undefined
  state?: "opened" | "merged" | "closed" | undefined
}

export interface TimelineHighlight {
  id: string
  kind: TimelineHighlightKind
  text: string
  at: string
  anchorMessageID: string
  task?: { key: string; status: "open" | "done" | "blocked" } | undefined
  artifact?: TimelineHighlightArtifact | undefined
}

export interface TimelineChapter {
  id: string
  title: string
  summary: string
  startedAt: string
  endedAt: string
  highlights: TimelineHighlight[]
  createdAt: string
  updatedAt: string
}

export interface TimelineWatermark {
  messageID: string
  createdAt: string
  messageCount: number
}

export interface TimelineBackfill {
  processedMessages: number
  totalMessages: number
  startedAt: string
  completedAt?: string | undefined
  cancelled?: boolean | undefined
  error?: string | undefined
}

export interface TimelineError {
  message: string
  at: string
  retryable: boolean
  kind: "model" | "config" | "storage" | "invalid-output" | "unknown"
}

export interface TimelineNotice {
  kind: "history-changed" | "hourly-cap"
  message: string
  at: string
}

export interface TimelineMeta {
  createdAt: string
  updatedAt: string
  lastCheckedAt: string
  model: TimelineModelRef
  promptVersion: number
  callCount: number
  recentAutoCalls: string[]
  estimatedInputChars: number
  lastError?: TimelineError | undefined
  notice?: TimelineNotice | undefined
}

export type TimelineCoverageReason = "compacted-history" | "pagination-limit"

export interface TimelineCoverage {
  partial: boolean
  reason?: TimelineCoverageReason | undefined
}

export interface TimelineDocument {
  version: 1
  sessionID: string
  sessionTitle: string | null
  goal: string | null
  status: TimelineStatus
  coverage: TimelineCoverage
  tasks: TimelineTask[]
  chapters: TimelineChapter[]
  watermark: TimelineWatermark | null
  backfill: TimelineBackfill | null
  meta: TimelineMeta
}

export interface TimelineEstimate {
  messages: number
  chars: number
  chunks: number
  approxCalls: number
}

export interface ExcerptItem {
  role: "user" | "assistant" | "tool" | "system"
  at: string
  text: string
  messageID: string
  isAnchor: boolean
}

export interface TimelineHeader {
  goal: string | null
  tasks: {
    total: number
    done: number
    open: number
    blocked: number
    openTitles: string[]
    blockedTitles: string[]
  }
  decisions: Array<{ id: string; chapterID: string; text: string; at: string }>
  artifacts: Array<{
    id: string
    chapterID: string
    type: "pr" | "commit"
    label: string
    url?: string | undefined
    state?: "opened" | "merged" | "closed" | undefined
    at: string
  }>
}
