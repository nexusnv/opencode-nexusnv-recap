import { parseDocument } from "../shared/document.js"
import type { TimelineDocument, TimelineError, TimelineEstimate } from "../shared/types.js"

export interface RecapEnvelope {
  document: TimelineDocument | null
  busy: boolean
  disabledReason?: string | undefined
  error?: TimelineError | undefined
}

export interface RpcFailure {
  type?: string
  message: string
  data?: unknown
}

export function parseEnvelope(value: unknown): RecapEnvelope {
  if (!isRecord(value)) throw new TypeError("Recap returned an invalid response")
  const rawDocument = value.document
  let document: TimelineDocument | null
  if (rawDocument === null) {
    document = null
  } else {
    const candidate = parseDocument(rawDocument)
    if (!candidate) throw new TypeError("Recap returned an invalid document")
    document = candidate
  }
  return {
    document,
    busy: value.busy === true,
    ...(typeof value.disabledReason === "string" ? { disabledReason: value.disabledReason } : {}),
    ...(isTimelineError(value.error) ? { error: value.error } : {}),
  }
}

export function rpcFailure(cause: unknown): RpcFailure {
  if (isRecord(cause)) {
    return {
      ...(typeof cause.type === "string" ? { type: cause.type } : {}),
      message: messageOf(cause),
      data: cause.data,
    }
  }
  return { message: messageOf(cause) }
}

export function isEstimate(value: unknown): value is TimelineEstimate {
  return (
    isRecord(value) &&
    typeof value.messages === "number" &&
    typeof value.chars === "number" &&
    typeof value.chunks === "number" &&
    typeof value.approxCalls === "number"
  )
}

export function isTimelineError(value: unknown): value is TimelineError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.kind === "string"
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message
  // Host RPC errors are tagged records rather than native Errors.
  if (isRecord(cause) && typeof cause.message === "string" && cause.message.length > 0) return cause.message
  return "Recap request failed"
}
