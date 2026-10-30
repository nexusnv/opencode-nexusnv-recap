import type { Context, KeymapCommand, KeymapLayer, PanelInput } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

export interface FakeRpc {
  ensure: (input: unknown, options?: unknown) => Promise<unknown>
  get: (input: unknown, options?: unknown) => Promise<unknown>
  refresh: (input: unknown, options?: unknown) => Promise<unknown>
  backfill: (input: unknown, options?: unknown) => Promise<unknown>
  rebuild: (input: unknown, options?: unknown) => Promise<unknown>
  cancel: (input: unknown, options?: unknown) => Promise<unknown>
  excerpt: (input: unknown, options?: unknown) => Promise<unknown>
  events: {
    on: (name: string, handler: (event: { data: Record<string, unknown> }) => void, options?: unknown) => () => void
    emit: (name: string, data: Record<string, unknown>) => void
  }
}

export interface FakeUiCalls {
  readonly panelOpen: Array<{ name: string; options: unknown }>
  readonly panelClose: number
  readonly toasts: unknown[]
  readonly confirms: unknown[]
  readonly dialogs: number
}

export interface FakeTuiOptions {
  readonly session?: Record<string, unknown>
  readonly currentPanel?: PanelInput | undefined
  readonly route?: unknown
}

export function fakeTui(overrides: Partial<FakeRpc> = {}, options: FakeTuiOptions = {}) {
  const calls: Array<{ method: string; input: unknown; options: unknown }> = []
  const uiCalls: {
    panelOpen: Array<{ name: string; options: unknown }>
    panelClose: number
    toasts: unknown[]
    confirms: unknown[]
    dialogs: number
  } = { panelOpen: [], panelClose: 0, toasts: [], confirms: [], dialogs: 0 }
  const handlers = new Map<string, Array<(event: { data: Record<string, unknown> }) => void>>()
  const layers: Array<() => KeymapLayer> = []
  const record =
    (method: string, fallback: (input: unknown) => Promise<unknown>) =>
    async (input: unknown, callOptions?: unknown) => {
      calls.push({ method, input, options: callOptions })
      return fallback(input)
    }
  const events = {
    on(name: string, handler: (event: { data: Record<string, unknown> }) => void) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((entry) => entry !== handler),
        )
    },
    emit(name: string, data: Record<string, unknown>) {
      for (const handler of handlers.get(name) ?? []) handler({ data })
    },
  }
  const rpc: FakeRpc = {
    ensure: record("ensure", overrides.ensure ?? (async () => ({ document: null, busy: false, needsBackfill: false }))),
    get: record("get", overrides.get ?? (async () => ({ document: null, busy: false }))),
    refresh: record("refresh", overrides.refresh ?? (async () => ({ started: true, coalesced: false }))),
    backfill: record(
      "backfill",
      overrides.backfill ??
        (async () => ({ started: true, estimate: { messages: 1, chars: 1, chunks: 1, approxCalls: 1 } })),
    ),
    rebuild: record(
      "rebuild",
      overrides.rebuild ??
        (async () => ({ started: true, estimate: { messages: 1, chars: 1, chunks: 1, approxCalls: 1 } })),
    ),
    cancel: record("cancel", overrides.cancel ?? (async () => ({ cancelled: true }))),
    excerpt: record("excerpt", overrides.excerpt ?? (async () => ({ items: [] }))),
    events: overrides.events ?? events,
  }

  const context = {
    options: {},
    location: { directory: "/repo" },
    app: { version: "2.1.4", channel: "dev" },
    client: { rpc: () => rpc },
    data: {
      session: {
        get: (sessionID: string) => ({
          id: sessionID,
          projectID: "prj_1",
          title: "Test",
          time: { created: 0 },
          ...options.session,
        }),
      },
    },
    theme: fakeTheme(),
    keymap: {
      layer(factory: () => KeymapLayer) {
        layers.push(factory)
      },
      commands: () => keymapCommands(),
      dispatch: () => undefined,
      shortcuts: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => "base", push: () => () => undefined },
    },
    ui: {
      panel: {
        open: (name: string, openOptions?: unknown) => {
          uiCalls.panelOpen.push({ name, options: openOptions })
          return true
        },
        close: () => {
          uiCalls.panelClose += 1
        },
        current: () => options.currentPanel,
      },
      toast: {
        show: (input: unknown) => {
          uiCalls.toasts.push(input)
        },
      },
      dialog: {
        show: () => {
          uiCalls.dialogs += 1
        },
        set: () => undefined,
        clear: () => undefined,
        alert: async () => undefined,
        prompt: async () => undefined,
        select: async () => undefined,
        confirm: async (input: unknown) => {
          uiCalls.confirms.push(input)
          return true
        },
      },
      router: { current: () => options.route ?? { type: "session", sessionID: "ses_1" } },
    },
    storage: {
      store: () => [createSignal({}), async () => undefined],
      memory: () => [createSignal({}), () => undefined],
    },
  } as unknown as Context

  const keymapCommands = (): readonly KeymapCommand[] =>
    layers.flatMap((factory) => {
      const layer = factory()
      const enabled = typeof layer.enabled === "function" ? layer.enabled() : layer.enabled !== false
      return enabled ? (layer.commands ?? []) : []
    })

  return { context, rpc, calls, uiCalls, handlers, keymapCommands }
}

function fakeTheme(): Context["theme"] {
  const color = "#aabbcc"
  return {
    text: {
      base: color,
      muted: color,
      faint: color,
      action: { primary: { base: color } },
      feedback: {
        error: { base: color, muted: color },
        warning: { base: color, muted: color },
        success: { base: color, muted: color },
        info: { base: color, muted: color },
      },
    },
    background: { raised: { base: color } },
  } as unknown as Context["theme"]
}

export function panelInput(overrides: Partial<PanelInput> = {}): PanelInput {
  return {
    name: "timeline",
    sessionID: "ses_1",
    width: 100,
    presentation: "panel",
    focused: true,
    focus() {},
    close() {},
    toggleFullscreen() {},
    ...overrides,
  }
}
