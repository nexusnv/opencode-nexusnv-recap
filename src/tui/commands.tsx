/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { PANEL_NAME } from "../shared/ids.js"

export function TimelineCommands(props: { readonly context: Context }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "recap.panel.open",
        title: "Open session recap",
        description: "Show the highlight recap for the current session",
        group: "Recap",
        palette: true,
        // `/timeline` is a host command; use a distinct slash name.
        slash: { name: "recap" },
        run() {
          const current = props.context.ui.panel.current()
          if (current?.name === PANEL_NAME) {
            props.context.ui.panel.close()
            return
          }
          const route = props.context.ui.router.current()
          if (route.type !== "session") {
            props.context.ui.toast.show({ message: "Open a session first", variant: "warning" })
            return
          }
          if (props.context.data.session.get(route.sessionID)?.parentID) {
            props.context.ui.toast.show({ message: "Recap is available for root sessions", variant: "warning" })
            return
          }
          if (!props.context.ui.panel.open(PANEL_NAME)) {
            props.context.ui.toast.show({ message: "The session panel is not available", variant: "warning" })
          }
        },
      },
    ],
  }))
  return null
}
