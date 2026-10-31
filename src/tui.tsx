/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { TUI_PLUGIN_ID } from "./shared/ids.js"
import { TimelineCommands } from "./tui/commands.js"
import { TimelineSlot } from "./tui/panel.js"

export { TUI_PLUGIN_ID } from "./shared/ids.js"
export { TimelinePanel, TimelineSlot } from "./tui/panel.js"
export { TimelineCommands } from "./tui/commands.js"

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    context.ui.slot({
      append: "session.panel",
      render: (panel) => <TimelineSlot context={context} panel={panel} />,
    })
    context.ui.slot({
      append: "app",
      render: () => <TimelineCommands context={context} />,
    })
  },
})
