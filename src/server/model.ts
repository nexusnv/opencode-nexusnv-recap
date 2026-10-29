import type { Plugin } from "@opencode/plugin"
import type { TimelineConfig } from "../config.js"
import type { TimelineModelRef } from "../shared/types.js"
import { isRecord } from "./text.js"

type GenerateLike = {
  text(
    input: {
      prompt: string
      model?: { providerID: string; id: string; variant?: string }
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string }>
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export interface ModelClient {
  complete(prompt: string, signal?: AbortSignal): Promise<string>
}

export type ModelFailureKind = "auth" | "config" | "transient" | "model" | "aborted"

export class ModelFailure extends Error {
  constructor(
    message: string,
    readonly kind: ModelFailureKind,
    readonly retryable: boolean,
    readonly status?: number | undefined,
  ) {
    super(message)
    this.name = "ModelFailure"
  }
}

export interface ModelClientOptions {
  readonly sleep?: Sleep
  readonly random?: () => number
}

export function createModelClient(
  ctx: Pick<Plugin.Context, "generate" | "experimental">,
  config: TimelineConfig,
  options: ModelClientOptions = {},
): ModelClient {
  const model = config.model
  if (!model) {
    return {
      async complete() {
        throw new ModelFailure("No model configured", "config", false)
      },
    }
  }

  const sleep: Sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const generate = resolveGenerate(ctx)

  return {
    async complete(prompt, signal) {
      if (signal?.aborted) throw abortFailure()
      for (let attempt = 0; attempt <= config.limits.retries; attempt += 1) {
        try {
          return await callWithTimeout(generate, prompt, model, config.limits.modelTimeoutMs, signal)
        } catch (error) {
          if (signal?.aborted) throw abortFailure()
          const failure = classify(error)
          if (failure.kind === "aborted") throw failure
          if (!failure.retryable || attempt === config.limits.retries) throw failure
          await sleepWithAbort(sleep, backoff(attempt, random), signal)
        }
      }
      // `retries` is validated as non-negative, so the loop always returns or
      // throws; this keeps the function total for TypeScript.
      throw new ModelFailure("Model call failed", "model", false)
    },
  }
}

// 2.1.4 exposes only `experimental.terminal`; there is no `experimental.generate`.
// The probe is forward-compatibility: a future host that re-adds the API is
// picked up automatically, and 2.1.4 always resolves to `ctx.generate`.
function resolveGenerate(ctx: Pick<Plugin.Context, "generate" | "experimental">): GenerateLike {
  const experimental = ctx.experimental as unknown as { generate?: unknown } | undefined
  const candidate = experimental?.generate
  if (isRecord(candidate) && typeof candidate.text === "function") return candidate as unknown as GenerateLike
  return ctx.generate as unknown as GenerateLike
}

const TRANSIENT_PATTERN =
  /(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|EPIPE|fetch failed|socket hang up|network|unable to connect|connection refused|timed? ?out|timeout|rate[ _-]?limit|overloaded|service[ _-]?unavailable)/i

const AUTH_TAGS = new Set(["UnauthorizedError", "ForbiddenError"])
const CONFIG_TAGS = new Set(["LocationNotFoundError", "ProviderNotFoundError"])
const TRANSIENT_TAGS = new Set(["ServiceUnavailableError", "RpcInternalError", "UnknownError"])

async function callWithTimeout(
  generate: GenerateLike,
  prompt: string,
  model: TimelineModelRef,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) throw abortFailure()

  // Cancellation is best-effort: @opencode/plugin's promise adapter drops
  // request options and some hosts ignore them entirely. Abort the forwarded
  // controller for well-behaved hosts, but always race against the external
  // signal so this promise settles even when the host never observes it.
  const controller = new AbortController()
  const abort = signal ? abortRace(signal, () => controller.abort()) : undefined

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const call = generate.text(
      {
        prompt,
        model: {
          providerID: model.providerID,
          id: model.modelID,
          ...(model.variant ? { variant: model.variant } : {}),
        },
      },
      { signal: controller.signal },
    )
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new ModelFailure("Model call timed out", "transient", true))
      }, timeoutMs)
      timer.unref?.()
    })
    const result = await (abort ? Promise.race([call, timeout, abort.promise]) : Promise.race([call, timeout]))
    // The host may resolve successfully just as the caller aborts. Never
    // return that text once the caller has given up.
    if (signal?.aborted) throw abortFailure()
    if (!isRecord(result) || typeof result.text !== "string" || result.text.trim() === "") {
      throw new ModelFailure("Model returned an empty response", "model", false)
    }
    return result.text
  } catch (error) {
    if (signal?.aborted) throw abortFailure()
    // The timeout rejection may lose the race to a host rejection triggered by
    // the forwarded abort; keep the timeout classification deterministic.
    if (timedOut) throw new ModelFailure("Model call timed out", "transient", true)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    abort?.dispose()
  }
}

function abortRace(
  signal: AbortSignal,
  onAbort?: () => void,
): { readonly promise: Promise<never>; readonly dispose: () => void } {
  let rejectAbort!: (reason?: unknown) => void
  const promise = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const handler = () => {
    onAbort?.()
    rejectAbort(abortFailure())
  }
  signal.addEventListener("abort", handler, { once: true })
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", handler),
  }
}

async function sleepWithAbort(sleep: Sleep, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await sleep(ms)
    return
  }
  if (signal.aborted) throw abortFailure()

  const abort = abortRace(signal)
  try {
    // Race even an injected sleep that ignores its signal so cancellation is
    // never blocked by a sleep implementation.
    await Promise.race([sleep(ms, signal), abort.promise])
  } finally {
    abort.dispose()
  }
  if (signal.aborted) throw abortFailure()
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortFailure())
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(abortFailure())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function classify(error: unknown): ModelFailure {
  if (error instanceof ModelFailure) return error

  const message = messageOf(error)
  const status = statusOf(error)
  const tags = tagsOf(error)

  if (tags.has("ClientError")) return classifyClientError(error, message, status)
  if ([...AUTH_TAGS].some((tag) => tags.has(tag))) return new ModelFailure(message, "auth", false, status)
  if ([...CONFIG_TAGS].some((tag) => tags.has(tag))) return new ModelFailure(message, "config", false, status)
  if ([...TRANSIENT_TAGS].some((tag) => tags.has(tag))) {
    return new ModelFailure(message, "transient", true, status)
  }
  if (tags.has("InvalidRequestError")) {
    // A rate-limit/overload hint is actionable even when the host also tagged
    // the failure as a 400-class InvalidRequestError.
    if (status === 401 || status === 403 || status === 404) return fromStatus(message, status)
    if (TRANSIENT_PATTERN.test(diagnosticText(error))) return new ModelFailure(message, "transient", true, status)
    if (status !== undefined) return fromStatus(message, status)
    return new ModelFailure(message, "model", false)
  }
  if (status !== undefined) return fromStatus(message, status)
  if (TRANSIENT_PATTERN.test(diagnosticText(error))) return new ModelFailure(message, "transient", true)
  return new ModelFailure(message, "model", false)
}

function classifyClientError(error: unknown, message: string, status: number | undefined): ModelFailure {
  const reason = isRecord(error) && typeof error.reason === "string" ? error.reason : undefined
  switch (reason) {
    case "Transport":
    case "SseEventTooLarge":
      return new ModelFailure(message, "transient", true, status)
    case "MalformedResponse":
    case "UnsupportedContentType":
      return new ModelFailure(message, "model", false, status)
    case "UnexpectedStatus":
      if (status !== undefined) return fromStatus(message, status)
      return TRANSIENT_PATTERN.test(diagnosticText(error))
        ? new ModelFailure(message, "transient", true)
        : new ModelFailure(message, "model", false)
  }
  if (status !== undefined) return fromStatus(message, status)
  // Effect's ClientError wraps a transport/protocol defect; retrying is the
  // safe default when no more specific reason or status is available.
  return new ModelFailure(message, "transient", true)
}

function fromStatus(message: string, status: number): ModelFailure {
  if (status === 401 || status === 403) return new ModelFailure(message, "auth", false, status)
  if (status === 404) return new ModelFailure(message, "config", false, status)
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)) {
    return new ModelFailure(message, "transient", true, status)
  }
  return new ModelFailure(message, "model", false, status)
}

function statusOf(error: unknown, seen: Set<object> = new Set()): number | undefined {
  if (!isRecord(error) || seen.has(error)) return undefined
  seen.add(error)
  const data = isRecord(error.data) ? error.data : undefined
  const response = isRecord(error.response) ? error.response : undefined
  for (const value of [error.status, error.statusCode, data?.status, response?.status]) {
    const status = statusValue(value)
    if (status !== undefined) return status
  }
  return statusOf(error.cause, seen)
}

function statusValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

function tagsOf(error: unknown): Set<string> {
  const tags = new Set<string>()
  if (!isRecord(error)) return tags
  for (const key of ["_tag", "name"] as const) {
    const value = error[key]
    if (typeof value === "string") tags.add(value)
  }
  return tags
}

function diagnosticText(error: unknown, seen: Set<object> = new Set()): string {
  if (!isRecord(error) || seen.has(error)) return ""
  seen.add(error)
  const parts: string[] = []
  for (const key of ["code", "errno", "_tag", "name", "message", "kind", "reason"] as const) {
    const value = error[key]
    if (typeof value === "string" || typeof value === "number") parts.push(String(value))
  }
  const nested = error.cause
  if (typeof nested === "string" || typeof nested === "number") {
    parts.push(String(nested))
  } else {
    const causeText = diagnosticText(nested, seen)
    if (causeText !== "") parts.push(causeText)
  }
  return parts.join(" ")
}

function backoff(attempt: number, random: () => number): number {
  return Math.min(5_000, 500 * 2 ** attempt + Math.floor(random() * 250))
}

function abortFailure(): ModelFailure {
  return new ModelFailure("Request aborted", "aborted", false)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.trim() !== "") return error.message
    for (const key of ["_tag", "name"] as const) {
      const value = error[key]
      if (typeof value === "string" && value !== "") return value
    }
  }
  return String(error)
}
