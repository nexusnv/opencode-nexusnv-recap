/** @jsxImportSource @opentui/solid */
import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context"
import { TimelineRpc } from "../rpc.js"
import { deriveHeader } from "../shared/document.js"
import { requireRpcLocation } from "../shared/location.js"
import type { TimelineDocument } from "../shared/types.js"
import { isEstimate, messageOf, parseEnvelope, rpcFailure } from "./envelope.js"
import { relativeTime, taskSummary } from "./format.js"

type RecapAction = "build" | "resume" | "refresh" | "rebuild" | "cancel"

export function TimelineCommands(props: { readonly context: Context }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "recap.actions",
        title: "Recap actions",
        description: "Build, resume, refresh, rebuild, or cancel the current session recap",
        group: "Recap",
        palette: true,
        // The action menu needs a selected session; keep the command out of
        // discovery and slash completion elsewhere.
        enabled: () => props.context.ui.router.current().type === "session",
        slash: { name: "recap" },
        run() {
          return runRecapMenu(props.context)
        },
      },
    ],
  }))
  return null
}

async function runRecapMenu(context: Context): Promise<void> {
  const route = context.ui.router.current()
  if (route.type !== "session") {
    context.ui.toast.show({ message: "Open a session first", variant: "warning" })
    return
  }
  if (context.data.session.get(route.sessionID)?.parentID) {
    context.ui.toast.show({ message: "Recap is available for root sessions", variant: "warning" })
    return
  }

  const sessionID = route.sessionID
  const rpc = context.client.rpc(TimelineRpc)
  const location = requireRpcLocation(context)

  let document: TimelineDocument | null
  let busy: boolean
  try {
    const envelope = parseEnvelope(await rpc.get({ sessionID }, { location }))
    if (envelope.disabledReason) {
      context.ui.toast.show({ message: envelope.disabledReason, variant: "warning" })
      return
    }
    document = envelope.document
    busy = envelope.busy
  } catch (cause) {
    context.ui.toast.show({ message: messageOf(cause), variant: "error" })
    return
  }

  const options = recapActions(document, busy)
  if (options.every((option) => option.disabled)) {
    context.ui.toast.show({ message: "No recap actions available", variant: "info" })
    return
  }

  const action = await context.ui.dialog.select<RecapAction>({
    title: "Recap",
    placeholder: "Choose an action",
    options,
  })
  if (!action) return

  async function start(method: "backfill" | "rebuild"): Promise<void> {
    try {
      await rpc[method]({ sessionID, confirm: false }, { location })
    } catch (cause) {
      const failure = rpcFailure(cause)
      if (failure.type !== "confirmation_required" || !isEstimate(failure.data)) throw cause
      const confirmed = await context.ui.dialog.confirm({
        title: method === "backfill" ? "Build recap?" : "Rebuild recap?",
        message: `${failure.data.messages} messages, about ${failure.data.approxCalls} model calls.`,
        label: { confirm: method === "backfill" ? "Build" : "Rebuild", cancel: "Cancel" },
      })
      if (!confirmed) return
      await rpc[method]({ sessionID, confirm: true }, { location })
    }
  }

  try {
    if (action === "build" || action === "resume") {
      await start("backfill")
      return
    }
    if (action === "rebuild") {
      await start("rebuild")
      return
    }
    if (action === "refresh") {
      await rpc.refresh({ sessionID }, { location })
      return
    }
    await rpc.cancel({ sessionID }, { location })
  } catch (cause) {
    context.ui.toast.show({ message: messageOf(cause), variant: "error" })
  }
}

function recapActions(document: TimelineDocument | null, busy: boolean): DialogSelectOption<RecapAction>[] {
  const resumable = document?.backfill != null && document.backfill.completedAt === undefined
  const hasWatermark = document?.watermark !== null && document?.watermark !== undefined
  const running = busy || document?.status === "backfilling"
  const runningBackfill = document?.status === "backfilling" || (busy && !hasWatermark)
  const historyChanged = document?.meta.notice?.kind === "history-changed"
  const taskLine = document && document.tasks.length > 0 ? taskSummary(deriveHeader(document).tasks) : undefined
  const updatedLine = document ? `updated ${relativeTime(document.meta.updatedAt)}` : undefined
  const refreshDescription = ["Update with new activity", updatedLine, taskLine].filter(Boolean).join(" · ")

  return [
    {
      title: "Build",
      value: "build",
      description: resumable
        ? "Backfill paused; use Resume"
        : hasWatermark
          ? "Recap is already built"
          : "Build from session history",
      disabled: Boolean(running || resumable || hasWatermark),
    },
    {
      title: "Resume",
      value: "resume",
      description: resumable ? "Continue the paused backfill" : "No paused backfill",
      disabled: Boolean(!resumable || running),
    },
    {
      title: "Refresh",
      value: "refresh",
      description: historyChanged ? "Rebuild required" : refreshDescription,
      disabled: Boolean(!document || !hasWatermark || runningBackfill || resumable || historyChanged),
    },
    {
      title: "Rebuild",
      value: "rebuild",
      description: "Discard and rebuild from session history",
      disabled: Boolean(!document || !hasWatermark || running || resumable),
    },
    {
      title: "Cancel",
      value: "cancel",
      description: "Cancel the running build",
      disabled: !running,
    },
  ]
}
