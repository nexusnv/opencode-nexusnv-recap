/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import type { TimelineChapter, TimelineHighlight } from "../shared/types.js"
import { chapterRange, glyph, relativeTime } from "./format.js"

export function ChapterRow(props: {
  readonly context: Context
  readonly chapter: TimelineChapter
  readonly expanded: boolean
  readonly selected: boolean
}) {
  const marker = () => (props.selected ? ">" : " ")
  const disclosure = () => (props.expanded ? "▾" : "▸")
  return (
    <box id={`timeline-chapter-${props.chapter.id}`} flexDirection="column" flexShrink={0}>
      <text
        fg={props.selected ? props.context.theme.text.action.primary.base : props.context.theme.text.base}
        wrapMode="none"
        truncate
      >
        {marker()} {chapterRange(props.chapter.startedAt, props.chapter.endedAt)} {props.chapter.title}{" "}
        {props.chapter.highlights.length} highlights {disclosure()}
      </text>
      <text fg={props.context.theme.text.muted} wrapMode="word">
        {props.chapter.summary}
      </text>
    </box>
  )
}

export function HighlightRow(props: {
  readonly context: Context
  readonly highlight: TimelineHighlight
  readonly selected: boolean
}) {
  return (
    <text
      id={`timeline-highlight-${props.highlight.id}`}
      fg={props.selected ? props.context.theme.text.action.primary.base : props.context.theme.text.muted}
      wrapMode="none"
      truncate
    >
      {props.selected ? ">" : " "} {glyph(props.highlight.kind)} {label(props.highlight.kind)} {props.highlight.text}{" "}
      {relativeTime(props.highlight.at)}
    </text>
  )
}

function label(kind: TimelineHighlight["kind"]): string {
  switch (kind) {
    case "decision":
      return "Decision"
    case "implementation":
      return "Impl"
    case "task":
      return "Task"
    case "pr":
      return "PR"
    case "commit":
      return "Commit"
    case "issue":
      return "Issue"
    case "note":
      return "Note"
    case "plan":
      return "Plan"
  }
}
