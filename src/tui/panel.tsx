/** @jsxImportSource @opentui/solid */
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { Show, createMemo, onMount } from "solid-js"
import { createTimelineState } from "./state.js"

export function TimelinePanel(props: { readonly context: Context; readonly panel: PanelInput }) {
  const state = createTimelineState(props.context, props.panel.sessionID)
  const isChild = createMemo(() => Boolean(props.context.data.session.get(props.panel.sessionID)?.parentID))
  // Child sessions have no timeline; never call `ensure` for them.
  onMount(() => {
    if (!isChild()) void state.load()
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.raised.base}>
      <Show
        when={!isChild()}
        fallback={<text fg={props.context.theme.text.muted}>Recap is available for root sessions.</text>}
      >
        <Show when={!state.loading()} fallback={<text fg={props.context.theme.text.muted}>Loading recap…</text>}>
          <Show
            when={!state.disabledReason()}
            fallback={<text fg={props.context.theme.text.muted}>{state.disabledReason()}</text>}
          >
            <Show
              when={!state.requestError()}
              fallback={<text fg={props.context.theme.text.feedback.error.base}>{state.requestError()}</text>}
            >
              <text fg={props.context.theme.text.base}>Recap</text>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
