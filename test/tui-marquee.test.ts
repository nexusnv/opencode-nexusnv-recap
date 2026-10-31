import { describe, expect, test } from "bun:test"
import {
  MARQUEE_END_HOLD_MS,
  MARQUEE_LOOP_PAUSE_MS,
  MARQUEE_SEPARATOR_WIDTH,
  marqueeCycleDuration,
  marqueeMetrics,
  marqueeOffset,
} from "../src/tui/marquee"

const SPEED = 10

describe("marqueeMetrics", () => {
  test("does not overflow when the text fits", () => {
    expect(marqueeMetrics(10, 20)).toEqual({
      textWidth: 10,
      viewportWidth: 20,
      separatorWidth: MARQUEE_SEPARATOR_WIDTH,
      overflow: false,
      holdOffset: 0,
      cycleWidth: 13,
    })
  })

  test("computes the hold offset with the separator at the right edge", () => {
    const metrics = marqueeMetrics(30, 20)

    expect(metrics.overflow).toBe(true)
    expect(metrics.cycleWidth).toBe(33)
    expect(metrics.holdOffset).toBe(13)
  })

  test("treats an unmeasured viewport as fitting", () => {
    const metrics = marqueeMetrics(30, 0)

    expect(metrics.overflow).toBe(false)
    expect(metrics.holdOffset).toBe(0)
  })
})

describe("marqueeOffset", () => {
  const metrics = marqueeMetrics(30, 20)
  const scrollToHoldMs = (metrics.holdOffset / SPEED) * 1000
  const scrollAfterHoldMs = ((metrics.cycleWidth - metrics.holdOffset) / SPEED) * 1000
  const totalMs = marqueeCycleDuration(metrics, SPEED, MARQUEE_END_HOLD_MS, MARQUEE_LOOP_PAUSE_MS)

  test("starts at the beginning", () => {
    expect(marqueeOffset(0, metrics, SPEED)).toBe(0)
  })

  test("scrolls to the end-and-dot hold offset", () => {
    expect(marqueeOffset(scrollToHoldMs, metrics, SPEED)).toBe(metrics.holdOffset)
  })

  test("holds while the dot is visible", () => {
    expect(marqueeOffset(scrollToHoldMs + MARQUEE_END_HOLD_MS - 1, metrics, SPEED)).toBe(metrics.holdOffset)
  })

  test("continues until the second copy starts at column zero", () => {
    expect(marqueeOffset(scrollToHoldMs + MARQUEE_END_HOLD_MS + scrollAfterHoldMs, metrics, SPEED)).toBe(
      metrics.cycleWidth,
    )
  })

  test("loops seamlessly after the cycle", () => {
    expect(marqueeOffset(totalMs + 1, metrics, SPEED)).toBe(0)
  })

  test("returns zero when the text fits", () => {
    expect(marqueeOffset(5_000, marqueeMetrics(10, 20), SPEED)).toBe(0)
  })

  test("never returns a negative offset", () => {
    expect(marqueeOffset(-100, metrics, SPEED)).toBe(0)
  })
})

describe("marqueeCycleDuration", () => {
  test("adds both scroll segments, the hold, and the loop pause", () => {
    const metrics = marqueeMetrics(30, 20)

    expect(marqueeCycleDuration(metrics, SPEED, 1_000, 200)).toBe(1_300 + 1_000 + 2_000 + 200)
  })

  test("is zero for non-overflowing text", () => {
    expect(marqueeCycleDuration(marqueeMetrics(10, 20), SPEED, 1_000, 200)).toBe(0)
  })
})
