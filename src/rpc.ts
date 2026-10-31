import { Rpc } from "@opencode/plugin/rpc"
import { RPC_ID } from "./shared/ids.js"

const modelRef = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    modelID: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "modelID"],
  additionalProperties: false,
} as const

const task = {
  type: "object",
  properties: {
    key: { type: "string" },
    title: { type: "string" },
    status: { type: "string", enum: ["open", "done", "blocked"] },
    anchorMessageID: { anyOf: [{ type: "string" }, { type: "null" }] },
    updatedAt: { type: "string" },
  },
  required: ["key", "title", "status", "anchorMessageID", "updatedAt"],
  additionalProperties: false,
} as const

const artifact = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["pr", "commit"] },
    url: { type: "string" },
    state: { type: "string", enum: ["opened", "merged", "closed"] },
  },
  required: ["type"],
  additionalProperties: false,
} as const

const highlight = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["decision", "implementation", "task", "pr", "commit", "issue", "note", "plan"] },
    text: { type: "string" },
    at: { type: "string" },
    anchorMessageID: { type: "string" },
    task: {
      type: "object",
      properties: {
        key: { type: "string" },
        status: { type: "string", enum: ["open", "done", "blocked"] },
      },
      required: ["key", "status"],
      additionalProperties: false,
    },
    artifact,
  },
  required: ["id", "kind", "text", "at", "anchorMessageID"],
  additionalProperties: false,
} as const

const chapter = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    startedAt: { type: "string" },
    endedAt: { type: "string" },
    highlights: { type: "array", items: highlight },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "title", "summary", "startedAt", "endedAt", "highlights", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const

const watermark = {
  type: "object",
  properties: {
    messageID: { type: "string" },
    createdAt: { type: "string" },
    messageCount: { type: "number" },
  },
  required: ["messageID", "createdAt", "messageCount"],
  additionalProperties: false,
} as const

const backfill = {
  type: "object",
  properties: {
    processedMessages: { type: "number" },
    totalMessages: { type: "number" },
    startedAt: { type: "string" },
    completedAt: { type: "string" },
    cancelled: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["processedMessages", "totalMessages", "startedAt"],
  additionalProperties: false,
} as const

const timelineError = {
  type: "object",
  properties: {
    message: { type: "string" },
    at: { type: "string" },
    retryable: { type: "boolean" },
    kind: { type: "string", enum: ["model", "config", "storage", "invalid-output", "unknown"] },
  },
  required: ["message", "at", "retryable", "kind"],
  additionalProperties: false,
} as const

const notice = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["history-changed", "hourly-cap"] },
    message: { type: "string" },
    at: { type: "string" },
  },
  required: ["kind", "message", "at"],
  additionalProperties: false,
} as const

const meta = {
  type: "object",
  properties: {
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    lastCheckedAt: { type: "string" },
    model: modelRef,
    promptVersion: { type: "number" },
    callCount: { type: "number" },
    recentAutoCalls: { type: "array", items: { type: "string" } },
    estimatedInputChars: { type: "number" },
    lastError: timelineError,
    notice,
  },
  required: [
    "createdAt",
    "updatedAt",
    "lastCheckedAt",
    "model",
    "promptVersion",
    "callCount",
    "recentAutoCalls",
    "estimatedInputChars",
  ],
  additionalProperties: false,
} as const

const document = {
  type: "object",
  properties: {
    version: { type: "number", enum: [1] },
    sessionID: { type: "string" },
    sessionTitle: { anyOf: [{ type: "string" }, { type: "null" }] },
    goal: { anyOf: [{ type: "string" }, { type: "null" }] },
    status: { type: "string", enum: ["empty", "backfilling", "paused", "ready", "stale", "error"] },
    coverage: {
      type: "object",
      properties: {
        partial: { type: "boolean" },
        reason: { type: "string", enum: ["compacted-history", "pagination-limit"] },
      },
      required: ["partial"],
      additionalProperties: false,
    },
    tasks: { type: "array", items: task },
    chapters: { type: "array", items: chapter },
    watermark: { anyOf: [watermark, { type: "null" }] },
    backfill: { anyOf: [backfill, { type: "null" }] },
    meta,
  },
  required: [
    "version",
    "sessionID",
    "sessionTitle",
    "goal",
    "status",
    "coverage",
    "tasks",
    "chapters",
    "watermark",
    "backfill",
    "meta",
  ],
  additionalProperties: false,
} as const

const estimate = {
  type: "object",
  properties: {
    messages: { type: "number" },
    chars: { type: "number" },
    chunks: { type: "number" },
    approxCalls: { type: "number" },
  },
  required: ["messages", "chars", "chunks", "approxCalls"],
  additionalProperties: false,
} as const

const excerptItem = {
  type: "object",
  properties: {
    role: { type: "string", enum: ["user", "assistant", "tool", "system"] },
    at: { type: "string" },
    text: { type: "string" },
    messageID: { type: "string" },
    isAnchor: { type: "boolean" },
  },
  required: ["role", "at", "text", "messageID", "isAnchor"],
  additionalProperties: false,
} as const

const getOutput = {
  type: "object",
  properties: {
    document: { anyOf: [document, { type: "null" }] },
    busy: { type: "boolean" },
    disabledReason: { type: "string" },
    error: timelineError,
  },
  required: ["document", "busy"],
  additionalProperties: false,
} as const

const ensureOutput = {
  type: "object",
  properties: {
    ...getOutput.properties,
    needsBackfill: { type: "boolean" },
    estimate,
  },
  required: ["document", "busy", "needsBackfill"],
  additionalProperties: false,
} as const

const startOutput = {
  type: "object",
  properties: {
    started: { type: "boolean" },
    estimate,
  },
  required: ["started", "estimate"],
  additionalProperties: false,
} as const

const refreshOutput = {
  type: "object",
  properties: {
    started: { type: "boolean" },
    coalesced: { type: "boolean" },
  },
  required: ["started", "coalesced"],
  additionalProperties: false,
} as const

const cancelOutput = {
  type: "object",
  properties: { cancelled: { type: "boolean" } },
  required: ["cancelled"],
  additionalProperties: false,
} as const

const excerptOutput = {
  type: "object",
  properties: { items: { type: "array", items: excerptItem } },
  required: ["items"],
  additionalProperties: false,
} as const

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const backfillInput = {
  type: "object",
  properties: { sessionID: { type: "string" }, confirm: { type: "boolean" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const excerptInput = {
  type: "object",
  properties: { sessionID: { type: "string" }, messageID: { type: "string" } },
  required: ["sessionID", "messageID"],
  additionalProperties: false,
} as const

const failure = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
} as const

const errors = {
  session_not_found: {
    type: "object",
    properties: { sessionID: { type: "string" } },
    required: ["sessionID"],
    additionalProperties: false,
  },
  disabled: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
    additionalProperties: false,
  },
  confirmation_required: estimate,
  busy: {
    type: "object",
    properties: { sessionID: { type: "string" } },
    required: ["sessionID"],
    additionalProperties: false,
  },
  invalid_request: failure,
  internal: failure,
} as const

export const TimelineRpc = Rpc.define({
  id: RPC_ID,
  methods: {
    get: { input: sessionInput, output: getOutput, errors },
    ensure: { input: sessionInput, output: ensureOutput, errors },
    backfill: { input: backfillInput, output: startOutput, errors },
    refresh: { input: sessionInput, output: refreshOutput, errors },
    rebuild: { input: backfillInput, output: startOutput, errors },
    cancel: { input: sessionInput, output: cancelOutput, errors },
    excerpt: { input: excerptInput, output: excerptOutput, errors },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          status: { type: "string" },
          chapterCount: { type: "number" },
          taskCount: { type: "number" },
          updatedAt: { type: "string" },
        },
        required: ["sessionID", "status", "chapterCount", "taskCount", "updatedAt"],
        additionalProperties: false,
      },
    },
    progress: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          phase: { type: "string", enum: ["backfill", "update"] },
          processed: { type: "number" },
          total: { type: "number" },
          chapters: { type: "number" },
        },
        required: ["sessionID", "phase", "processed", "total", "chapters"],
        additionalProperties: false,
      },
    },
    error: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          kind: { type: "string" },
          message: { type: "string" },
          retryable: { type: "boolean" },
        },
        required: ["sessionID", "kind", "message", "retryable"],
        additionalProperties: false,
      },
    },
  },
})
