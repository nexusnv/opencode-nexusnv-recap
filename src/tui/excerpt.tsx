/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createSignal, onMount } from "solid-js"
import type { ExcerptItem } from "../shared/types.js"
import { relativeTime } from "./format.js"
import type { TimelineState } from "./state.js"

export function openExcerpt(context: Context, state: TimelineState, messageID: string): void {
  context.ui.dialog.show(() => <ExcerptDialog context={context} state={state} messageID={messageID} />)
  context.ui.dialog.set({ size: "large", centered: true })
}

export function ExcerptDialog(props: {
  readonly context: Context
  readonly state: TimelineState
  readonly messageID: string
}) {
  const [items, setItems] = createSignal<ExcerptItem[]>()
  const [error, setError] = createSignal<string>()

  onMount(() => {
    void (async () => {
      try {
        setItems(await props.state.excerpt(props.messageID))
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : typeof cause === "object" &&
                cause !== null &&
                typeof (cause as { message?: unknown }).message === "string"
              ? (cause as { message: string }).message
              : "Could not load the excerpt"
        setError(message)
      }
    })()
  })

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={props.context.theme.background.raised.base}>
      <text fg={props.context.theme.text.base}>Excerpt</text>
      <Show when={items()} fallback={<text fg={props.context.theme.text.muted}>{error() ?? "Loading excerpt…"}</text>}>
        {(current) => (
          <Show
            when={current().length > 0}
            fallback={<text fg={props.context.theme.text.muted}>Original message not available (compacted).</text>}
          >
            <scrollbox flexGrow={1} width="100%">
              <For each={current()}>
                {(item) => (
                  <box flexDirection="column" paddingBottom={1}>
                    <text
                      fg={item.isAnchor ? props.context.theme.text.action.primary.base : props.context.theme.text.muted}
                    >
                      {item.isAnchor ? "→ " : "  "}
                      {item.role} · {relativeTime(item.at)}
                    </text>
                    <text fg={props.context.theme.text.base} wrapMode="word">
                      {item.text}
                    </text>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>
        )}
      </Show>
      <text fg={props.context.theme.text.faint}>esc close</text>
    </box>
  )
}
