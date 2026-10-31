import { describe, expect, test } from "bun:test"
import type { TimelineStatus } from "../src/shared/types"
import {
  artifactSummary,
  chapterRange,
  glyph,
  relativeTime,
  statusColor,
  statusLabel,
  taskSummary,
} from "../src/tui/format"
import { fakeTui } from "./helpers/tui"

const NOW = Date.parse("2026-10-29T12:00:00.000Z")

describe("relativeTime", () => {
  test("formats just now, seconds, minutes, hours, and days", () => {
    expect(relativeTime(new Date(NOW).toISOString(), NOW)).toBe("just now")
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe("30s ago")
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago")
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe("3h ago")
    expect(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d ago")
  })

  test("returns unknown for an invalid timestamp", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("unknown")
  })
})

describe("chapterRange", () => {
  test("formats a same-day range", () => {
    const start = new Date(2026, 9, 29, 10, 0)
    const end = new Date(2026, 9, 29, 11, 30)

    expect(chapterRange(start.toISOString(), end.toISOString())).toBe("10:00–11:30")
  })

  test("formats a cross-day range", () => {
    const start = new Date(2026, 9, 29, 23, 0)
    const end = new Date(2026, 9, 30, 1, 15)
    const range = chapterRange(start.toISOString(), end.toISOString())

    expect(range).toContain(start.toLocaleDateString())
    expect(range).toContain(end.toLocaleDateString())
    expect(range).toContain("23:00")
    expect(range).toContain("01:15")
  })

  test("returns unknown for invalid dates", () => {
    expect(chapterRange("nope", "also-nope")).toBe("unknown")
  })
})

describe("statusLabel", () => {
  test("labels every persisted status", () => {
    const statuses: TimelineStatus[] = ["empty", "backfilling", "paused", "ready", "stale", "error"]
    expect(statuses.map((status) => statusLabel(status, false, false))).toEqual([
      "EMPTY",
      "BACKFILLING",
      "PAUSED",
      "READY",
      "STALE",
      "ERROR",
    ])
  })

  test("disabled and busy override the persisted status", () => {
    expect(statusLabel("ready", true, false)).toBe("DISABLED")
    expect(statusLabel("ready", false, true)).toBe("BACKFILLING")
    expect(statusLabel("error", true, true)).toBe("DISABLED")
  })
})

describe("statusColor", () => {
  const { context } = fakeTui()

  test("uses the semantic theme tokens", () => {
    expect(statusColor(context, "ready", false, false)).toBe(context.theme.text.feedback.success.base)
    expect(statusColor(context, "error", false, false)).toBe(context.theme.text.feedback.error.base)
    expect(statusColor(context, "stale", false, false)).toBe(context.theme.text.feedback.warning.base)
    expect(statusColor(context, "paused", false, false)).toBe(context.theme.text.feedback.warning.base)
    expect(statusColor(context, "backfilling", false, false)).toBe(context.theme.text.feedback.info.base)
    expect(statusColor(context, "empty", false, false)).toBe(context.theme.text.muted)
    expect(statusColor(context, "ready", true, false)).toBe(context.theme.text.muted)
    expect(statusColor(context, "ready", false, true)).toBe(context.theme.text.feedback.info.base)
  })
})

describe("glyph", () => {
  test("maps every highlight kind", () => {
    expect(
      (["decision", "implementation", "task", "pr", "commit", "issue", "note", "plan"] as const).map((kind) =>
        glyph(kind),
      ),
    ).toEqual(["◆", "✦", "✓", "⇗", "⌁", "◇", "·", "→"])
  })
})

describe("taskSummary", () => {
  test("handles no tasks", () => {
    expect(taskSummary({ total: 0, done: 0, open: 0, blocked: 0, openTitles: [], blockedTitles: [] })).toBe("No tasks")
  })

  test("lists open and blocked titles", () => {
    expect(
      taskSummary({
        total: 4,
        done: 1,
        open: 2,
        blocked: 1,
        openTitles: ["Wire RPC", "Add panel"],
        blockedTitles: ["Publish"],
      }),
    ).toBe("1/4 done   open: Wire RPC, Add panel   blocked: Publish")
  })

  test("falls back to counts when titles are unavailable", () => {
    expect(taskSummary({ total: 3, done: 1, open: 2, blocked: 1, openTitles: [], blockedTitles: [] })).toBe(
      "1/3 done   open: 2   blocked: 1",
    )
  })
})

describe("artifactSummary", () => {
  test("handles no artifacts", () => {
    expect(artifactSummary([])).toBe("None")
  })

  test("lists PR states and commits", () => {
    expect(artifactSummary([{ label: "PR #12", state: "merged" }, { label: "commit abc1234" }])).toBe(
      "PR #12 merged; commit abc1234",
    )
  })
})
