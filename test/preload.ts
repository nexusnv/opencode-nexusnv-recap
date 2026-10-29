/**
 * Mirror the OpenCode host's TUI plugin loader in tests.
 *
 * OpenCode registers `@opentui/solid`'s Bun plugin before importing a TUI
 * plugin: it compiles TSX with the Solid Babel preset and serves the client
 * Solid runtime in place of the server build. Without this, `createEffect` is
 * a no-op and JSX props are evaluated once, so reactive render tests would lie.
 */
import solidPlugin from "@opentui/solid/bun-plugin"

Bun.plugin(solidPlugin)
