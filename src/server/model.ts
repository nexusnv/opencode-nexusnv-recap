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
  readonly sleep?: (ms: number) => Promise<void>
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

  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const generate = resolveGenerate(ctx)

  return {
    async complete(prompt, signal) {
      if (signal?.aborted) throw new ModelFailure("Request aborted", "aborted", false)
      let last: ModelFailure | undefined
      for (let attempt = 0; attempt <= config.limits.retries; attempt += 1) {
        try {
          return await callWithTimeout(generate, prompt, model, config.limits.modelTimeoutMs, signal)
        } catch (error) {
          if (signal?.aborted) throw new ModelFailure("Request aborted", "aborted", false)
          const failure = classify(error)
          last = failure
          if (failure.kind === "aborted") throw failure
          if (!failure.retryable || attempt === config.limits.retries) throw failure
          await sleep(backoff(attempt, random))
        }
      }
      throw last ?? new ModelFailure("Model call failed", "model", false)
    },
  }
}

// 2.1.4 exposes only `experimental.terminal`; there is no `experimental.generate`.
// The probe is forward-compatibility: a future host that re-adds the API is
// picked up automatically, and 2.1.4 always resolves to `ctx.generate`.
function resolveGenerate(ctx: Pick<Plugin.Context, "generate" | "experimental">): GenerateLike {
  const experimental = (ctx.experimental as unknown as { generate?: GenerateLike }).generate
  return experimental ?? (ctx.generate as unknown as GenerateLike)
}

const TRANSIENT_PATTERN =
  /(fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timed? ?out)/i

async function callWithTimeout(
  generate: GenerateLike,
  prompt: string,
  model: TimelineModelRef,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) throw new ModelFailure("Request aborted", "aborted", false)

  // The inner controller aborts the HTTP request on timeout or when the
  // engine stops; racing promises alone would leave the request running.
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })

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
    const result = await Promise.race([call, timeout])
    if (!isRecord(result) || typeof result.text !== "string" || result.text.trim() === "") {
      throw new ModelFailure("Model returned an empty response", "model", false)
    }
    return result.text
  } catch (error) {
    // The abort may win the race against the timeout rejection; keep the
    // timeout classification deterministic either way.
    if (timedOut) throw new ModelFailure("Model call timed out", "transient", true)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

function classify(error: unknown): ModelFailure {
  if (error instanceof ModelFailure) return error
  const status = statusOf(error)
  if (status === 401 || status === 403) return new ModelFailure(messageOf(error), "auth", false, status)
  if (status === 404) return new ModelFailure(messageOf(error), "config", false, status)
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return new ModelFailure(messageOf(error), "transient", true, status)
  }
  if (status === undefined && TRANSIENT_PATTERN.test(messageOf(error))) {
    return new ModelFailure(messageOf(error), "transient", true)
  }
  return new ModelFailure(messageOf(error), "model", false, status)
}

function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  for (const key of ["status", "statusCode"]) {
    const value = error[key]
    if (typeof value === "number") return value
  }
  const data = isRecord(error.data) ? error.data : undefined
  if (data && typeof data.status === "number") return data.status
  const response = isRecord(error.response) ? error.response : undefined
  if (response && typeof response.status === "number") return response.status
  return undefined
}

function backoff(attempt: number, random: () => number): number {
  return Math.min(5_000, 500 * 2 ** attempt + Math.floor(random() * 250))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
