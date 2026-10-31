# OpenCode Nexusnv Recap

Recap turns a long OpenCode session into a short, chronological highlight reel. It answers the questions you actually have when you come back to a session: what was this trying to do, what was decided, what was implemented, which tasks are still open, which PRs or commits came out of it, and what it plans to do next.

It is built for OpenCode V2. The server owns the model calls and the durable timeline; the TUI is a thin view and control surface. The plugin never prompts, compacts, edits, or interrupts the session.

```text
Recap                                        1/3
▸ Built the server engine · 10:12–10:38
Now Backfill + failure handling · ✦ Engine tests passing
Next → add Markdown export
```

The sidebar is a compact table of contents for the session. It shows one chapter at a time, the current chapter with its latest highlight, and the newest explicit plan. Every line that overflows scrolls horizontally instead of truncating, so narrow sidebars stay readable without ellipses.

## Install

Add the package as a plugin and configure an explicit model:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-nexusnv-recap",
      "options": {
        "enabled": true,
        "model": { "providerID": "openai", "modelID": "gpt-5-mini" },
        "update": {
          "debounceMs": 15000,
          "minNewUserTurns": 2,
          "minNewMessages": 6,
          "forceAfterMinutes": 10,
          "openRefreshAfterMinutes": 2,
        },
        "backfill": {
          "confirmOverCalls": 10,
        },
        "digest": {
          "maxChars": 28000,
          "maxUserChars": 4000,
          "maxAssistantChars": 2000,
          "maxToolResultChars": 600,
          "maxCompactionChars": 4000,
          "redact": true,
        },
        "limits": {
          "maxConcurrentCalls": 2,
          "maxUpdatesPerHour": 30,
          "modelTimeoutMs": 60000,
          "retries": 2,
        },
      },
    },
  ],
}
```

**The model is required and there is no fallback.** If `model` is missing, the plugin loads but the engine stays disabled and the sidebar shows the configuration snippet. It never silently uses the session's model. A configured model is checked against `ctx.model.list()` at setup and again on first use; a missing model is a visible disabled state, not a surprise bill.

Unknown configuration keys are rejected so typos are caught early. A malformed configuration disables the engine with the reason and the required snippet.

## Usage

The sidebar appears automatically for root sessions. It never starts a model call when it mounts: it only reads the stored recap. Mounting is free.

Run `/recap` in a root session, or use the **Recap actions** entry in the command palette. The menu offers the actions that apply to the current document:

- **Build** — build a recap from session history.
- **Resume** — continue a paused or interrupted backfill.
- **Refresh** — fold new activity into an existing recap.
- **Rebuild** — discard the recap and rebuild from history.
- **Cancel** — stop a running build.

Large backfills ask for confirmation first. Backfill progress replaces the `Next` line while it runs, and continues while the sidebar is closed. New activity marks the recap stale; the header says `stale`, and **Refresh** catches up. Automatic updates also run after the session goes idle, subject to the hourly cap.

`/timeline` is a built-in OpenCode command. Recap deliberately uses `/recap` so the two do not collide.

There is no default global keybind, to avoid conflicts with the host. The sidebar is display-only.

## Privacy

Recap sends a bounded digest to the configured model, not the raw transcript:

- Reasoning and thinking content is never sent.
- Full file bodies, images, and attachment data are never sent.
- Routine read-only tool calls are excluded; side-effecting tool output is capped and redacted.
- Secrets are redacted by default (`digest.redact: true`).
- Prompts and message contents are never logged. Logs contain session IDs, sizes, durations, and sanitized errors only.
- The plugin never mutates the session or its configuration.

## Compaction limitation

`ctx.session.context` only returns messages after the last compaction. When Recap detects that earlier history is no longer available, it marks coverage as partial and the sidebar header says `partial`; it seeds the backfill from the compaction summary when one exists. Full recovery of pre-compaction history is future work.

## Storage

Timelines are stored as plugin-scoped JSON documents under `recap/v1/session/<sessionID>`. Nothing is written into the project repository. Documents survive restarts and are updated atomically; a failed write leaves the previous document and watermark intact.

## Development

```bash
bun install
bun run check        # format check, lint, typecheck, build, and tests
bun run build
bun run pack:check   # verifies the built package and its exports
```

The test suite is hermetic: it uses fake model and storage clients and does not call a real provider.

Tested with OpenCode plugin API 2.1.4, OpenTUI 0.6.8, and Bun 1.4.x.

## Limitations

- Root sessions only; child sessions show no sidebar and make no calls.
- One timeline per session; there is no project-wide or cross-session timeline.
- No manual chapter editing, reordering, or pinning.
- No direct scroll-to-message navigation.
- Plan staleness is newest-wins: a completed plan disappears when a newer plan is recorded, not when it is finished.
- Markdown export is not implemented yet; storage is designed so it can be added later.

## License

MIT
