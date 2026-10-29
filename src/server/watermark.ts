import type { SessionMessageInfo } from "@opencode/client"
import type { TimelineWatermark } from "../shared/types.js"

export type WatermarkSlice =
  { kind: "new"; messages: SessionMessageInfo[] } | { kind: "empty" } | { kind: "history-changed" }

export function sliceAfterWatermark(
  messages: readonly SessionMessageInfo[],
  watermark: TimelineWatermark | null,
): WatermarkSlice {
  if (messages.length === 0) return { kind: "empty" }
  if (!watermark) return { kind: "new", messages: [...messages] }

  const index = messages.findIndex((message) => message.id === watermark.messageID)
  if (index >= 0) {
    const rest = messages.slice(index + 1)
    return rest.length > 0 ? { kind: "new", messages: rest } : { kind: "empty" }
  }

  const cutoff = Date.parse(watermark.createdAt)
  const rest = Number.isFinite(cutoff) ? messages.filter((message) => message.time.created > cutoff) : []
  if (rest.length > 0) return { kind: "new", messages: rest }
  return { kind: "history-changed" }
}
