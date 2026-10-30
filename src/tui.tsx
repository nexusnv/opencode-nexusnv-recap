/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { PANEL_NAME, TUI_PLUGIN_ID } from "./shared/ids.js"
import { TimelineCommands } from "./tui/commands.js"
import { TimelinePanel } from "./tui/panel.js"

export { TUI_PLUGIN_ID } from "./shared/ids.js"
export { TimelinePanel } from "./tui/panel.js"
export { TimelineCommands } from "./tui/commands.js"

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <TimelinePanel context={context} panel={panel} />
        </Show>
      ),
    })
    context.ui.slot({
      append: "app",
      render: () => <TimelineCommands context={context} />,
    })
  },
})
