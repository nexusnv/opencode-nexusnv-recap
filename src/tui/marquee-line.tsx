/** @jsxImportSource @opentui/solid */
import type { RGBA, TextRenderable } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { MARQUEE_SEPARATOR, marqueeMetrics, marqueeOffset } from "./marquee.js"

const TICK_MS = 80

export interface MarqueeSegment {
  readonly text: string
  readonly color: string | RGBA
}

export function MarqueeLine(props: {
  readonly context: Context
  readonly prefix: string
  readonly prefixColor: string | RGBA
  readonly segments: readonly MarqueeSegment[]
}) {
  let text: TextRenderable | undefined
  const [viewport, setViewport] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)
  let startedAt = Date.now()

  // Highlights come from a model and may contain newlines. A marquee is a
  // single physical line, so flatten whitespace before measuring or rendering.
  const segments = createMemo(() =>
    props.segments.map((segment) => ({ ...segment, text: segment.text.replace(/\s+/g, " ") })),
  )
  const textWidth = createMemo(() => segments().reduce((total, segment) => total + Bun.stringWidth(segment.text), 0))
  const metrics = createMemo(() => marqueeMetrics(textWidth(), viewport()))
  const offset = createMemo(() => marqueeOffset(elapsed(), metrics()))

  function reset(): void {
    startedAt = Date.now()
    setElapsed(0)
  }

  createEffect(
    on(
      () =>
        segments()
          .map((segment) => segment.text)
          .join("\u0000"),
      reset,
    ),
  )
  createEffect(on(viewport, reset))
  createEffect(
    on(
      () => metrics().overflow,
      (overflow) => {
        if (!overflow) reset()
      },
    ),
  )
  createEffect(() => {
    const value = offset()
    if (text) text.scrollX = value
  })

  // Native flex layout does not emit `onSizeChange` for these text nodes, so
  // read the laid-out width from the tick instead of relying on a resize hook.
  function measure(): void {
    const width = text?.width ?? 0
    if (width !== viewport()) setViewport(width)
  }

  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    measure()
    timer = setInterval(() => {
      measure()
      if (!metrics().overflow) return
      setElapsed(Date.now() - startedAt)
    }, TICK_MS)
  })
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer)
  })

  return (
    <box flexDirection="row" width="100%" flexShrink={0}>
      <text flexShrink={0} wrapMode="none" fg={props.prefixColor}>
        {props.prefix}{" "}
      </text>
      <text
        ref={(value) => {
          text = value
        }}
        flexGrow={1}
        flexShrink={1}
        wrapMode="none"
        fg={props.context.theme.text.base}
      >
        <Segments segments={segments()} />
        <Show when={metrics().overflow}>
          <span style={{ fg: props.context.theme.text.faint } as {}}>{MARQUEE_SEPARATOR}</span>
          <Segments segments={segments()} />
        </Show>
      </text>
    </box>
  )
}

function Segments(props: { readonly segments: readonly MarqueeSegment[] }) {
  return <For each={props.segments}>{(segment) => <span style={{ fg: segment.color } as {}}>{segment.text}</span>}</For>
}
