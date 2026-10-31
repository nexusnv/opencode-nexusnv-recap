/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { deriveHeader } from "../shared/document.js"
import type { TimelineDocument } from "../shared/types.js"
import { artifactSummary, relativeTime, statusColor, statusLabel, taskSummary } from "./format.js"

export function TimelineHeader(props: {
  readonly context: Context
  readonly document: TimelineDocument
  readonly disabled: boolean
}) {
  const header = () => deriveHeader(props.document)
  // The persisted status already distinguishes a backfill (`backfilling`) from
  // an incremental update, so a generic busy flag must not override it.
  const status = () => statusLabel(props.document.status, props.disabled, false)

  return (
    <box flexDirection="column" flexShrink={0} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.context.theme.text.base}>Recap</text>
        <text fg={statusColor(props.context, props.document.status, props.disabled, false)}>
          {status()} · {relativeTime(props.document.meta.updatedAt)} · {props.document.meta.model.modelID}
        </text>
      </box>
      <text fg={props.context.theme.text.base} wrapMode="word">
        Goal {props.document.goal ?? "No goal recorded yet"}
      </text>
      <text fg={props.context.theme.text.muted} wrapMode="word">
        Tasks {taskSummary(header().tasks)}
      </text>
      <Show when={header().decisions.length > 0}>
        <text fg={props.context.theme.text.muted} wrapMode="word">
          Decisions{" "}
          {header()
            .decisions.map((decision) => decision.text)
            .join("; ")}
        </text>
      </Show>
      <Show when={header().artifacts.length > 0}>
        <text fg={props.context.theme.text.muted} wrapMode="word">
          Artifacts {artifactSummary(header().artifacts)}
        </text>
      </Show>
      <Show when={props.document.coverage.partial}>
        <text fg={props.context.theme.text.feedback.warning.base}>
          {props.document.coverage.reason === "pagination-limit"
            ? "Partial: transcript pagination limit reached."
            : "Partial: earlier history was compacted."}
        </text>
      </Show>
    </box>
  )
}
