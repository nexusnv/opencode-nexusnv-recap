const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, "$1=[REDACTED]"],
]

export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement)
  return result
}

export function clip(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  const marker = "\n…[truncated]…\n"
  if (marker.length >= max) return text.slice(0, max)
  const budget = max - marker.length
  const head = Math.ceil(budget * 0.7)
  const tail = budget - head
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`
}

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase()
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    // Keep letters and digits from any script: task keys must stay distinct
    // for non-Latin titles instead of collapsing to the same fallback.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return [...slug].slice(0, 48).join("") || "task"
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
