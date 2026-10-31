import { z } from "zod"
import type { TimelineModelRef } from "./shared/types.js"

export interface UpdateConfig {
  debounceMs: number
  minNewUserTurns: number
  minNewMessages: number
  forceAfterMinutes: number
  openRefreshAfterMinutes: number
}

export interface BackfillConfig {
  confirmOverCalls: number
}

export interface DigestConfig {
  maxChars: number
  maxUserChars: number
  maxAssistantChars: number
  maxToolResultChars: number
  maxCompactionChars: number
  redact: boolean
}

export interface LimitsConfig {
  maxConcurrentCalls: number
  maxUpdatesPerHour: number
  modelTimeoutMs: number
  retries: number
}

export interface TimelineConfig {
  enabled: boolean
  model?: TimelineModelRef | undefined
  update: UpdateConfig
  backfill: BackfillConfig
  digest: DigestConfig
  limits: LimitsConfig
}

export const DEFAULT_UPDATE: UpdateConfig = {
  debounceMs: 15_000,
  minNewUserTurns: 2,
  minNewMessages: 6,
  forceAfterMinutes: 10,
  openRefreshAfterMinutes: 2,
}

export const DEFAULT_BACKFILL: BackfillConfig = { confirmOverCalls: 10 }
export const DEFAULT_DIGEST: DigestConfig = {
  maxChars: 28_000,
  maxUserChars: 4_000,
  maxAssistantChars: 2_000,
  maxToolResultChars: 600,
  maxCompactionChars: 4_000,
  redact: true,
}
export const DEFAULT_LIMITS: LimitsConfig = {
  maxConcurrentCalls: 2,
  maxUpdatesPerHour: 30,
  modelTimeoutMs: 60_000,
  retries: 2,
}

export const DISABLED_REASON = "Recap is disabled."

export const CONFIG_SNIPPET = `{
  "plugins": [{
    "package": "opencode-nexusnv-recap",
    "options": {
      "model": { "providerID": "openai", "modelID": "gpt-5-mini" }
    }
  }]
}`

/**
 * The config snippet belongs in disabled states that need configuration, but
 * not when recap is intentionally disabled and not twice when the reason
 * already embeds it.
 */
export function disabledConfigSnippet(reason: string | undefined): string | undefined {
  if (!reason || reason === DISABLED_REASON || reason.includes(CONFIG_SNIPPET)) return undefined
  return CONFIG_SNIPPET
}

const modelSchema = z.strictObject({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
})

// Each nested field has its own default so a user can override one setting
// without restating the whole object. Unknown keys are still rejected.
const updateSchema = z.strictObject({
  debounceMs: z.number().int().min(1_000).max(300_000).default(DEFAULT_UPDATE.debounceMs),
  minNewUserTurns: z.number().int().min(1).max(100).default(DEFAULT_UPDATE.minNewUserTurns),
  minNewMessages: z.number().int().min(1).max(1_000).default(DEFAULT_UPDATE.minNewMessages),
  forceAfterMinutes: z.number().int().min(1).max(1_440).default(DEFAULT_UPDATE.forceAfterMinutes),
  openRefreshAfterMinutes: z.number().int().min(1).max(1_440).default(DEFAULT_UPDATE.openRefreshAfterMinutes),
})

const backfillSchema = z.strictObject({
  confirmOverCalls: z.number().int().min(1).max(1_000).default(DEFAULT_BACKFILL.confirmOverCalls),
})

const digestSchema = z.strictObject({
  maxChars: z.number().int().min(2_000).max(200_000).default(DEFAULT_DIGEST.maxChars),
  maxUserChars: z.number().int().min(200).max(100_000).default(DEFAULT_DIGEST.maxUserChars),
  maxAssistantChars: z.number().int().min(200).max(100_000).default(DEFAULT_DIGEST.maxAssistantChars),
  maxToolResultChars: z.number().int().min(100).max(50_000).default(DEFAULT_DIGEST.maxToolResultChars),
  maxCompactionChars: z.number().int().min(200).max(100_000).default(DEFAULT_DIGEST.maxCompactionChars),
  redact: z.boolean().default(DEFAULT_DIGEST.redact),
})

const limitsSchema = z.strictObject({
  maxConcurrentCalls: z.number().int().min(1).max(16).default(DEFAULT_LIMITS.maxConcurrentCalls),
  maxUpdatesPerHour: z.number().int().min(1).max(1_000).default(DEFAULT_LIMITS.maxUpdatesPerHour),
  modelTimeoutMs: z.number().int().min(1_000).max(600_000).default(DEFAULT_LIMITS.modelTimeoutMs),
  retries: z.number().int().min(0).max(10).default(DEFAULT_LIMITS.retries),
})

const configSchema = z.strictObject({
  enabled: z.boolean().default(true),
  model: modelSchema.optional(),
  update: updateSchema.default(DEFAULT_UPDATE),
  backfill: backfillSchema.default(DEFAULT_BACKFILL),
  digest: digestSchema.default(DEFAULT_DIGEST),
  limits: limitsSchema.default(DEFAULT_LIMITS),
})

export interface ParsedConfig {
  readonly config: TimelineConfig
  readonly problem?: string | undefined
}

export function parseConfig(options: unknown): ParsedConfig {
  const input = options === undefined || options === null ? {} : options
  const result = configSchema.safeParse(input)
  if (!result.success) {
    return {
      config: {
        enabled: false,
        update: DEFAULT_UPDATE,
        backfill: DEFAULT_BACKFILL,
        digest: DEFAULT_DIGEST,
        limits: DEFAULT_LIMITS,
      },
      problem: formatConfigProblem(result.error),
    }
  }
  if (result.data.enabled && !result.data.model) {
    return {
      config: result.data,
      problem: `Recap requires an explicit \`model\`. No fallback is used. Add:\n${CONFIG_SNIPPET}`,
    }
  }
  return { config: result.data }
}

export function formatConfigProblem(error: z.ZodError): string {
  const first = error.issues[0]
  const path = first?.path.length ? first.path.join(".") : "options"
  return `Invalid recap configuration at \`${path}\`: ${first?.message ?? "unknown error"}\n${CONFIG_SNIPPET}`
}

export function disabledReasonFor(parsed: ParsedConfig): string | undefined {
  if (parsed.problem) return parsed.problem
  if (!parsed.config.enabled) return DISABLED_REASON
  if (!parsed.config.model) return `Recap requires an explicit \`model\`.\n${CONFIG_SNIPPET}`
  return undefined
}
