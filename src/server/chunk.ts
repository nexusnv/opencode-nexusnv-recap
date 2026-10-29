import type { SessionMessageInfo } from "@opencode/client"
import type { TimelineConfig } from "../config.js"
import type { TimelineEstimate } from "../shared/types.js"
import { buildDigest } from "./digest.js"

export function estimateMessageChars(message: SessionMessageInfo, config: TimelineConfig): number {
  return buildDigest([message], config).chars
}

export function chunkMessages(messages: readonly SessionMessageInfo[], config: TimelineConfig): SessionMessageInfo[][] {
  const budget = config.digest.maxChars
  const chunks: SessionMessageInfo[][] = []
  let current: SessionMessageInfo[] = []
  let chars = 0

  for (const message of messages) {
    const size = estimateMessageChars(message, config)
    if (current.length > 0 && chars + size > budget) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(message)
    chars += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function estimateBackfill(messages: readonly SessionMessageInfo[], config: TimelineConfig): TimelineEstimate {
  const chunks = chunkMessages(messages, config)
  const chars = chunks.reduce((total, chunk) => total + buildDigest(chunk, config).chars, 0)
  return { messages: messages.length, chars, chunks: chunks.length, approxCalls: chunks.length }
}
