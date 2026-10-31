/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { TUI_PLUGIN_ID } from "./shared/ids.js"
import { TimelineCommands } from "./tui/commands.js"
import { RecapSidebar } from "./tui/sidebar.js"

export { TUI_PLUGIN_ID } from "./shared/ids.js"
export { RecapSidebar } from "./tui/sidebar.js"
export { TimelineCommands } from "./tui/commands.js"

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <RecapSidebar context={context} sessionID={input.sessionID} />,
    })
    context.ui.slot({
      append: "app",
      render: () => <TimelineCommands context={context} />,
    })
  },
})
