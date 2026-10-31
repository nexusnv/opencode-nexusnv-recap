export const MARQUEE_SEPARATOR = " · "
export const MARQUEE_SEPARATOR_WIDTH = 3
export const MARQUEE_COLUMNS_PER_SECOND = 18
export const MARQUEE_END_HOLD_MS = 1_200
export const MARQUEE_LOOP_PAUSE_MS = 300

export interface MarqueeMetrics {
  textWidth: number
  viewportWidth: number
  separatorWidth: number
  overflow: boolean
  holdOffset: number
  cycleWidth: number
}

export function marqueeMetrics(
  textWidth: number,
  viewportWidth: number,
  separatorWidth = MARQUEE_SEPARATOR_WIDTH,
): MarqueeMetrics {
  const text = Math.max(0, textWidth)
  const viewport = Math.max(0, viewportWidth)
  const separator = Math.max(0, separatorWidth)
  const overflow = viewport > 0 && text > viewport
  const cycleWidth = text + separator
  const holdOffset = overflow ? Math.max(0, cycleWidth - viewport) : 0
  return {
    textWidth: text,
    viewportWidth: viewport,
    separatorWidth: separator,
    overflow,
    holdOffset,
    cycleWidth,
  }
}

export function marqueeOffset(
  elapsedMs: number,
  metrics: MarqueeMetrics,
  columnsPerSecond = MARQUEE_COLUMNS_PER_SECOND,
  holdMs = MARQUEE_END_HOLD_MS,
  loopPauseMs = MARQUEE_LOOP_PAUSE_MS,
): number {
  if (elapsedMs <= 0 || !metrics.overflow || columnsPerSecond <= 0) return 0
  const total = marqueeCycleDuration(metrics, columnsPerSecond, holdMs, loopPauseMs)
  if (total <= 0) return 0

  const time = elapsedMs % total
  const scrollToHoldMs = (metrics.holdOffset / columnsPerSecond) * 1000
  const scrollAfterHoldMs = ((metrics.cycleWidth - metrics.holdOffset) / columnsPerSecond) * 1000
  const hold = Math.max(0, holdMs)

  let offset: number
  if (time < scrollToHoldMs) {
    offset = (time / 1000) * columnsPerSecond
  } else if (time < scrollToHoldMs + hold) {
    offset = metrics.holdOffset
  } else if (time < scrollToHoldMs + hold + scrollAfterHoldMs) {
    offset = metrics.holdOffset + ((time - scrollToHoldMs - hold) / 1000) * columnsPerSecond
  } else {
    offset = metrics.cycleWidth
  }

  return Math.max(0, Math.min(metrics.cycleWidth, Math.floor(offset)))
}

export function marqueeCycleDuration(
  metrics: MarqueeMetrics,
  columnsPerSecond = MARQUEE_COLUMNS_PER_SECOND,
  holdMs = MARQUEE_END_HOLD_MS,
  loopPauseMs = MARQUEE_LOOP_PAUSE_MS,
): number {
  if (!metrics.overflow || columnsPerSecond <= 0) return 0
  const scrollToHoldMs = (metrics.holdOffset / columnsPerSecond) * 1000
  const scrollAfterHoldMs = ((metrics.cycleWidth - metrics.holdOffset) / columnsPerSecond) * 1000
  return scrollToHoldMs + Math.max(0, holdMs) + scrollAfterHoldMs + Math.max(0, loopPauseMs)
}
