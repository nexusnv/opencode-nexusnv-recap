export interface SessionInput {
  sessionID: string
}

export interface BackfillInput extends SessionInput {
  confirm: boolean
}

export interface ExcerptInput extends SessionInput {
  messageID: string
}

export function parseSessionInput(value: unknown): SessionInput {
  const record = requireRecord(value, "input")
  rejectUnknown(record, ["sessionID"])
  return { sessionID: requireString(record.sessionID, "sessionID") }
}

export function parseBackfillInput(value: unknown): BackfillInput {
  const record = requireRecord(value, "input")
  rejectUnknown(record, ["sessionID", "confirm"])
  return {
    sessionID: requireString(record.sessionID, "sessionID"),
    confirm: record.confirm === undefined ? false : requireBoolean(record.confirm, "confirm"),
  }
}

export function parseExcerptInput(value: unknown): ExcerptInput {
  const record = requireRecord(value, "input")
  rejectUnknown(record, ["sessionID", "messageID"])
  return {
    sessionID: requireString(record.sessionID, "sessionID"),
    messageID: requireString(record.messageID, "messageID"),
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`)
  return value
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`)
  return value
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TypeError(`unknown input key: ${key}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
