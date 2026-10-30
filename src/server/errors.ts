import type { TimelineError } from "../shared/types.js"
import { ModelFailure } from "./model.js"
import { isRecord, redactSecrets } from "./text.js"

export type FailureCode =
  "session_not_found" | "disabled" | "confirmation_required" | "busy" | "invalid_request" | "internal"

export class TimelineFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "TimelineFailure"
  }
}

export class InvalidOutputFailure extends Error {
  constructor(readonly detail: string) {
    super(`Model output was invalid after repair: ${detail}`)
    this.name = "InvalidOutputFailure"
  }
}

export class StorageFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageFailure"
  }
}

/**
 * Carries the number of model calls and prompt characters consumed before a
 * failure so the engine can record repair attempts accurately.
 */
export class ModelCallFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly calls: number,
    readonly chars: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ModelCallFailure"
  }
}

export function sanitizeError(error: unknown): string {
  const message = errorMessage(error)
  return redactSecrets(message).replace(/\s+/g, " ").trim().slice(0, 500) || "Unknown error"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.length > 0) return error.message
    // Effect/host errors are tagged records that may omit the message.
    for (const key of ["name", "_tag"] as const) {
      const value = error[key]
      if (typeof value === "string" && value.length > 0) return value
    }
  }
  if (error === undefined || error === null) return ""
  return String(error)
}

export function isNotFound(error: unknown): boolean {
  if (isRecord(error)) {
    for (const key of ["status", "statusCode"] as const) {
      if (error[key] === 404) return true
    }
    const data = error.data
    if (isRecord(data)) {
      for (const key of ["status", "statusCode"] as const) {
        if (data[key] === 404) return true
      }
    }
  }
  // The host wraps some failures in an Error whose `message` is empty and whose
  // classification lives in `name` / `_tag` (for example `Session.NotFoundError`).
  const text = [
    error instanceof Error ? error.message : "",
    error instanceof Error ? error.name : "",
    isRecord(error) && typeof error.name === "string" ? error.name : "",
    isRecord(error) && typeof error["_tag"] === "string" ? error["_tag"] : "",
  ]
    .join(" ")
    .toLowerCase()
  return text.includes("not found") || text.includes("notfound") || text.includes("404")
}

export function sessionIDOf(event: unknown): string | undefined {
  if (!isRecord(event) || !isRecord(event.data)) return undefined
  return typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

export function toTimelineError(error: unknown, at: string): TimelineError {
  if (error instanceof ModelCallFailure) return toTimelineError(error.cause, at)
  if (error instanceof StorageFailure) {
    return { message: sanitizeError(error), at, retryable: true, kind: "storage" }
  }
  if (error instanceof InvalidOutputFailure) {
    return { message: sanitizeError(error), at, retryable: false, kind: "invalid-output" }
  }
  if (error instanceof ModelFailure) {
    const kind =
      error.kind === "auth" || error.kind === "config" ? "config" : error.kind === "aborted" ? "unknown" : "model"
    return { message: sanitizeError(error), at, retryable: error.retryable, kind }
  }
  if (error instanceof TimelineFailure) {
    return {
      message: sanitizeError(error),
      at,
      retryable: false,
      kind: error.code === "disabled" ? "config" : "unknown",
    }
  }
  return { message: sanitizeError(error), at, retryable: true, kind: "unknown" }
}
