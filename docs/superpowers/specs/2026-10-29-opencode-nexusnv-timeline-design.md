# OpenCode Nexusnv Timeline — Design

**Date:** 2026-10-29
**Status:** Design approved in brainstorming; spec self-reviewed and awaiting user review before implementation planning
**Package:** `opencode-nexusnv-timeline`
**Plugin IDs:** `nexusnv.timeline` (server), `nexusnv.timeline.tui` (TUI)

## 1. Problem

Long OpenCode sessions become hard to re-enter. The user remembers that something was decided, implemented, completed, or opened as a PR, but finding it means scrolling through a long transcript full of reasoning, tool output, and narration. Compaction makes this worse because the original messages may no longer be in the active context.

The plugin produces a **session highlight reel**: a small, chronological set of chapters with typed highlights, plus a current-state header answering:

- What was this session trying to do?
- What was decided?
- What was implemented?
- Which tasks are open, done, or blocked?
- Was a PR or commit opened or merged?
- Where in the session did each of those happen?

The timeline must stay short. It is not an activity log, and it must not become as long as the session it summarizes.

## 2. Goals and non-goals

### Goals

1. Build a per-session timeline from the transcript using a configured, cheap model.
2. Keep only high-value milestones: decisions, implementations, task changes, PR/commit events, direction-changing blockers, and important user constraints.
3. Show a status header above the timeline: goal, tasks, decisions, artifacts.
4. Let the user inspect the anchored exchange behind any highlight without scrolling the transcript.
5. Update incrementally after the session goes idle, without blocking the session.
6. Backfill an existing long session on first open, with an estimate and confirmation for large jobs.
7. Persist across restarts without writing into the project repository.
8. Never send reasoning, full file bodies, images, or unredacted secrets to the model; command output is capped and redacted.

### Non-goals (MVP)

- Cross-session or project-wide timeline.
- GUI/desktop part.
- Markdown export (storage is designed so it can be added later).
- Agent-facing tool or automatic handoff summary.
- Manual chapter editing, reordering, or pinning.
- Semantic search or embeddings.
- Direct scroll-to-message. The public TUI API has no message-level navigation destination; the plugin shows an anchored excerpt instead.
- Full recovery of history dropped by OpenCode compaction. Coverage is marked partial when this happens.

## 3. Key decisions

| Decision | Rationale |
|---|---|
| Server-owned engine, thin TUI | Model credentials and durable state belong on the server; updates continue while the panel is closed. The TUI is only a view/control surface. |
| Append-only chapters | Rows never jump or get rewritten as the session grows. History stays auditable. |
| One JSON document per session in plugin storage | No repo files, survives restarts, simple RPC reads. Export can be added later. |
| Incremental digest + watermark | Cost stays bounded regardless of session length. |
| One cheap-model call per batch, plus at most one repair | Simple, predictable cost. Two-stage extraction is a future upgrade if quality is poor. |
| Status header derived from chapters and a task ledger | One source of truth for decisions/PRs; tasks need a mutable ledger for status changes. |
| Explicit model, no fallback | Silently using the session's expensive model defeats the purpose. A missing model is a visible disabled state, not a surprise bill. |
| Panel on demand | No permanent screen cost; enough room for chapters and excerpts. |
| Compaction-aware backfill | `ctx.session.context` only returns messages after the last compaction. The plugin states this honestly and seeds from the compaction summary. |

## 4. Architecture

```text
OpenCode server
├── server plugin (src/index.ts)
│   ├── config + model validation
│   ├── session.idle subscription
│   ├── per-session engine (single-flight, debounce, retry)
│   ├── digest → prompt → cheap model → validate → apply
│   ├── plugin storage (one JSON doc per session)
│   └── RPC: get / ensure / backfill / refresh / rebuild / cancel / excerpt
│
└── TUI plugin (src/tui.tsx)
    ├── /timeline command + session.panel contribution
    ├── panel: status header + chapter accordion + excerpt dialog
    └── thin RPC client; no model calls, no storage
```

Package exports:

- `.` → server plugin
- `./tui` → TUI plugin
- `./rpc` → shared typed RPC contract

The server never modifies the session, its messages, or its configuration. All work is out-of-band.

## 5. Data model

### 5.1 Document

```ts
type TimelineStatus =
  | "empty"        // document created, no history processed yet (watermark is null)
  | "backfilling"  // history is being summarized
  | "paused"       // backfill stopped with partial history; resume or rebuild
  | "ready"        // watermark is current and no backfill is incomplete
  | "stale"        // new messages exist, last update was successful
  | "error"        // last attempt failed; watermark is unchanged

type TimelineModelRef = {
  providerID: string
  modelID: string
  variant?: string
}

type TimelineTask = {
  key: string                              // stable slug, e.g. "rpc-layer"
  title: string
  status: "open" | "done" | "blocked"
  anchorMessageID: string | null
  updatedAt: string                        // ISO timestamp of last change
}

type TimelineHighlightKind =
  | "decision"
  | "implementation"
  | "task"
  | "pr"
  | "commit"
  | "issue"
  | "note"

type TimelineHighlight = {
  id: string
  kind: TimelineHighlightKind
  text: string
  at: string                               // ISO, from the anchor message
  anchorMessageID: string
  task?: { key: string; status: "open" | "done" | "blocked" }
  artifact?: {
    type: "pr" | "commit"
    url?: string
    state?: "opened" | "merged" | "closed"
  }
}

type TimelineChapter = {
  id: string
  title: string
  summary: string
  startedAt: string                        // earliest highlight time
  endedAt: string                          // latest highlight time
  highlights: TimelineHighlight[]
  createdAt: string
  updatedAt: string
}

type TimelineWatermark = {
  messageID: string
  createdAt: string                        // timestamp of the last processed message
  messageCount: number                     // diagnostic: active-context length at set time
}

type TimelineBackfill = {
  processedMessages: number
  totalMessages: number
  startedAt: string
  completedAt?: string
  cancelled?: boolean
  error?: string
}

type TimelineError = {
  message: string
  at: string
  retryable: boolean
  kind: "model" | "config" | "storage" | "invalid-output" | "unknown"
}

type TimelineNotice = {
  kind: "history-changed" | "hourly-cap"
  message: string
  at: string
}

type TimelineMeta = {
  createdAt: string
  updatedAt: string
  lastCheckedAt: string
  model: TimelineModelRef                 // model used for the last successful batch
  promptVersion: number
  callCount: number                       // model calls attempted, including repairs
  recentAutoCalls: string[]               // automatic incremental calls in the last hour; pruned on write
  estimatedInputChars: number             // cumulative estimated digest chars sent
  lastError?: TimelineError
  notice?: TimelineNotice
}

type TimelineDocument = {
  version: 1
  sessionID: string
  sessionTitle: string | null
  goal: string | null
  status: TimelineStatus
  coverage: { partial: boolean; reason?: "compacted-history" }
  tasks: TimelineTask[]
  chapters: TimelineChapter[]
  watermark: TimelineWatermark | null
  backfill: TimelineBackfill | null
  meta: TimelineMeta
}
```

`disabled` is **not** a persisted status. It is a runtime condition derived from config and model validation, returned by RPC as `disabledReason`. Keeping it out of the document means enabling the plugin again does not require rewriting existing timelines.

### 5.2 Invariants

- `chapters` is append-only. Existing chapter IDs never change. A chapter may be extended, but its `startedAt` never moves backward.
- `highlights` are append-only within a chapter. Text may not be rewritten.
- `watermark` advances only after a batch has been validated, applied, and persisted atomically in one document write. `meta.updatedAt` is set on every successful write.
- `status` is the only persisted state that describes freshness. `stale` means "new messages are pending but the last update succeeded"; `error` means "the last attempt failed and the watermark did not move." `disabled` is runtime-only and never written to the document.
- `coverage.partial` is true when the available history starts at a compaction boundary. Incremental updates may set it to true; only a full rebuild may clear it, and only when full history is actually available.
- `tasks` is a ledger, not an append-only log. It is replaced when the model returns a new list, with stable-key reconciliation.
- The status header is derived:
  - Goal: `goal`
  - Tasks: `tasks`
  - Decisions: highlights with `kind === "decision"`, deduplicated by normalized text, latest five
  - Artifacts: highlights with an `artifact`, deduplicated by URL or commit SHA (latest state wins), latest five
  There is no separate decisions/PR state to drift. `artifact.state` applies to PRs; a commit has no state.

### 5.3 Storage

- Prefix: `timeline/v1/session/<sessionID>`
- One document per session, written with a single `storage.set`. Readers never observe a partially written document; a failed write leaves the previous value intact.
- In-memory per-session mutex plus a global model-call semaphore. Plugin storage has no compare-and-swap; single-process single-flight is sufficient for one OpenCode server.
- On `session.deleted`, remove the document if the event is available; otherwise delete lazily when a read finds the session missing. This is storage cleanup only, not model work.
- No cap on chapters in the MVP. Output limits keep each chapter small; a very long session is expected to produce tens of chapters, not hundreds.

## 6. Message ingestion

### 6.1 Source

`readSessionMessages(ctx, sessionID)`:

1. Prefer a full-history paginator if the running plugin API exposes one (`ctx.session.message.list`). This is capability-checked at runtime; it is not assumed.
2. Otherwise use `ctx.session.context({ sessionID })`, which returns only messages after the last compaction.
3. Sort ascending by `time.created`, stable for equal timestamps.
4. Return `{ messages, source: "full" | "context", partial }`.

`partial` is true when the source is `context` and the first message is a compaction message. If the runtime exposes a compaction boundary or timestamp, use that instead of the first-message heuristic. The compaction summary is still included in the digest as background.

For incremental updates, `context` is sufficient. If the watermark is missing from it, the engine tries full history (when available) before falling back to a time-based slice. If the compaction summary itself is not present in `context`, coverage is still marked partial when the runtime reports a compaction; the plugin does not claim to have the missing background.

### 6.2 Watermark resolution

Given `watermark` and the current message list:

1. Find `watermark.messageID`. If found, new messages are everything after it.
2. If not found, select messages with `time.created > watermark.createdAt`.
3. If that produces no messages while messages exist, the transcript was rewritten. Set `status = "stale"` and `meta.notice = { kind: "history-changed", ... }`. Do not rebuild silently.
4. If the time-based slice produces messages, process them. The prompt includes the current chapter's highlights so the model can avoid repeating them.

### 6.3 Digest rules

Only the following reach the model:

- **User messages:** text, plus attachment names and MIME types. Attachment contents are never included. Text is capped (default 4,000 chars, head and tail).
- **Assistant messages:** only `text` parts. **All `reasoning` parts are dropped.** Text is capped (default 2,000 chars).
- **Tool calls:**
  - Include tools with side effects (`edit`, `write`, `patch`, `shell`/`bash`, `task`, `todowrite`, or their equivalents), external lookups (`webfetch`, `websearch`), VCS/PR activity, and any tool that errored.
  - Drop successful routine read-only calls (`read`, `grep`, `glob`, `find`, `list`). They add noise without milestones.
  - Include `name`, selected input fields, status, and a truncated result (default 600 chars, head and tail).
  - For `edit`, `write`, and `patch`, include the path and a bounded summary (line counts, first changed hunk), never the full old/new content.
  - Never include full file contents, base64, or images.
- **Shell messages:** command plus a short output excerpt. Commands whose primary effect is dumping file contents (`cat`, `head`, `tail`, `less`, `sed -n`) are reduced to the command and status, not the output. Incidental text in other command output is capped and redacted; the plugin does not deliberately forward file bodies.
- **Compaction messages:** the summary, capped at 4,000 chars, as background context.
- **Ignored:** synthetic messages, system messages, skill activations, idle markers, agent/model/location switches, and all reasoning.

Each included message gets a short alias (`m1`, `m2`, …) and a UTC timestamp. The model cites aliases; the plugin maps them back to real message IDs. Aliases prevent mangled IDs and shrink the prompt.

A deterministic `EVIDENCE` block is appended:

- Files touched (from edit/write/patch inputs).
- Commands run (truncated).
- Test/lint/build/typecheck commands and their status.
- PR and commit references found in tool output (`https://github.com/.../pull/N`, `.../commit/SHA`, `gh pr ...`, `git commit`).
- `todowrite` task lists when present.

Evidence is capped at 2,000 chars. It helps the model avoid inventing artifacts; it is not stored separately.

### 6.4 Redaction

Enabled by default. Before the digest is sent:

- Redact common key/token shapes (`sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, bearer tokens, private-key blocks, `api_key=…`).
- Replace with `[REDACTED]`.
- Redaction applies to user text, assistant text, tool inputs, and tool results.
- The plugin never logs prompt bodies or message contents. Logs contain session IDs, sizes, durations, and sanitized errors only.

### 6.5 Chunking

- The digest for one model call is capped by `digest.maxChars` (default 28,000 chars, roughly 7k tokens). The same cap is used for incremental updates and backfill.
- A larger batch is split at message boundaries into sequential sub-chunks.
- Each sub-chunk is processed and persisted before the next. If a later sub-chunk fails, earlier sub-chunks remain committed and the watermark points at the last successful message.
- The prompt for a sub-chunk includes the goal, task ledger, and the current (last) chapter's `id`, title, summary, and highlights for continuity.

## 7. Model contract

### 7.1 Input

The prompt contains, in order:

1. Role and rules.
2. Current goal (or `(none yet)`).
3. Current task ledger.
4. Current chapter (`id`, title, summary, last highlights) or `(none)`.
5. `NEW MESSAGES` digest with aliases and timestamps.
6. `EVIDENCE` block.
7. Output schema and limits.

The prompt instructs the model to write in the same language as the user's messages, keep code identifiers verbatim, and return JSON only (no Markdown, no code fences). The current chapter `id` is included so `mode: "extend"` can target it exactly.

The digest is untrusted data. The prompt explicitly says to ignore any instructions found inside message text or tool output; the model's only job is extraction. This limits prompt-injection attempts from repository files or pasted content.

The config uses `modelID`; the generate adapter maps it to the API's `{ providerID, id, variant? }` shape.

### 7.2 Output

```json
{
  "goal": "…",
  "tasks": [
    { "key": "rpc-layer", "title": "Build the RPC layer", "status": "done", "anchor": "m42" }
  ],
  "chapters": [
    {
      "mode": "extend",
      "chapterID": "ch_…",
      "title": "…",
      "summary": "…",
      "highlights": [
        {
          "kind": "decision",
          "text": "…",
          "anchor": "m42",
          "artifact": { "type": "pr", "url": "https://github.com/acme/repo/pull/42", "state": "opened" }
        }
      ]
    }
  ]
}
```

Semantics:

- `goal`: empty string means "keep the existing goal"; a non-empty string replaces it.
- `tasks`: `null` means "no change"; an array replaces the ledger with the complete current list.
- `chapters`: 0–2 entries. Zero entries with `tasks: null` and an empty goal is a no-op.
- `mode: "extend"` is valid only for the current last chapter; `chapterID` must match it. An extend targeting any other chapter is treated as a new chapter, and a warning is logged. History is never rewritten.
- `mode: "new"` appends a chapter.
- `anchor` is an alias from `NEW MESSAGES`. For a task, it is optional; an unchanged task keeps its previous anchor.
- If the model returns no valid highlights for a chapter, the chapter is dropped.

### 7.3 Relevance rules (prompt-enforced)

Include only:

- Explicit decisions and chosen trade-offs.
- Implementations actually made (features, fixes, files/areas).
- Task status changes.
- PR/commit/issue events with evidence.
- Blockers or errors that changed direction or remain unresolved.
- Important user constraints and corrections.

Exclude:

- Reasoning and thinking.
- Routine reads, searches, and exploration.
- Repeated failed attempts unless the failure changed direction.
- Tool mechanics and "I will now…" narration.
- Verbose explanations and restatements of the prompt.
- Tentative ideas presented as decisions.

State rules:

- Keep the existing goal unless the session's objective clearly changed.
- Return the complete task ledger whenever tasks change; carry forward tasks that are still relevant and do not drop a task just because it was not mentioned in this batch. Return `null` only when no task changed.

Chapter rules:

- A chapter is a coherent phase, not a turn. A typical session should produce roughly 3–6 chapters.
- Extend the current chapter when work continues the same goal.
- Start a new chapter when the user changes goal, a phase completes, or a new problem redirects the work.
- Prefer one strong highlight over three weak ones. Omit when unsure.
- Titles ≤ 60 chars, summaries ≤ 180 chars, highlights ≤ 160 chars.

Factuality rules:

- Only claim a PR, commit, test, or build result when the digest or evidence shows it.
- Include the PR URL or number when present.
- Use `state: "merged"` or `"closed"` only when the output shows it; otherwise use `"opened"` or omit.
- Do not invent file names, issue numbers, or timestamps.

### 7.4 Validation and repair

1. Parse JSON. If it is wrapped in a code fence, unwrap it.
2. Validate the top-level shape against a strict schema. Unknown keys are errors.
3. On parse/schema failure, make one repair call that includes the validation error and the raw output (truncated). If repair fails, mark the batch `error` and do not advance the watermark.
4. Enforce limits: at most 2 chapters, at most 5 highlights per chapter, at most 100 tasks. Truncate overlong text. Drop individual tasks or highlights with invalid enum values or missing required fields; do not fail the whole batch for one bad item.
5. Resolve aliases. Drop highlights with unknown anchors. Drop artifact URLs that are not `http(s)` and keep the highlight without the artifact. Keep tasks with unknown anchors but set `anchorMessageID = null`.
6. Deduplicate tasks by key, then fuzzy-match titles to existing keys before adding a new key. Deduplicate highlights by normalized text within a chapter.
7. Compute timestamps from anchor messages; the model never supplies timestamps.
8. If nothing valid remains and tasks/goal are unchanged, treat the batch as a no-op and advance the watermark.

## 8. Update pipeline

### 8.1 Triggers

- `session.idle` event, debounced (default 15 s). A new idle resets the debounce.
- Panel open via `ensure`, if the last check is older than `openRefreshAfterMinutes` (default 2) and new messages exist.
- Manual `refresh` from the panel.
- A force timer set when an idle batch is below threshold, so a quiet session still updates after `forceAfterMinutes` (default 10).
- Backfill completion runs at most one incremental refresh if new messages arrived during the backfill; otherwise the watermark is current.

Hard constraints:

- **Idle events never start a first-time backfill.** They only update a session that already has a watermark. The first build is initiated from the panel, where the estimate and confirmation live. This prevents a long session from silently spending many model calls after the plugin is installed.
- **Incomplete backfills pause incremental updates.** If a backfill was cancelled or failed with a partial watermark, idle updates do not append newer chapters until the backfill is resumed or rebuilt. This preserves chronological order.
- **Child sessions are ignored.** Sessions with a `parentID` (subagent sessions) do not get timelines in the MVP, and no model calls are made for them. Every entry point resolves the session first and returns before reading or writing a document when `parentID` is set. The panel shows a short explanation instead.

### 8.2 Thresholds

An idle update is skipped when all of these are true:

- New user messages < `minNewUserTurns` (default 2), and
- New messages < `minNewMessages` (default 6), and
- The oldest unprocessed message is younger than `forceAfterMinutes`.

When skipped, set `status = "stale"`, update `meta.lastCheckedAt`, persist, and schedule the force timer.

If the force timer fires while the session is busy, do not summarize a partial turn. Compare the session's `time.idle` to the last message timestamp when available; otherwise re-read the message tail and treat a trailing user message, a running tool call, or an unfinished assistant message as busy. In that case set a `forceOnNextIdle` flag instead; the next idle refreshes regardless of the threshold. This keeps continuous runs from producing half-finished chapters while still ensuring the timeline catches up at the next pause.

### 8.3 Algorithm

```text
refresh(sessionID, reason):                 // reason: "idle" | "open" | "manual"
  reject if disabled
  singleFlight(sessionID):
    doc = load
    if doc is missing or doc.watermark is null: return   // first build is panel-driven
    if incompleteBackfill(doc): return                    // preserve chronological order
    if doc.meta.notice?.kind == "history-changed": return // rebuild required
    { messages, partial } = readSessionMessages(sessionID)
    newMessages = sliceAfterWatermark(messages, doc.watermark)
    if newMessages is empty:
      doc.status = "ready"
      doc.meta.lastCheckedAt = now
      doc.meta.notice = undefined
      persist; emit("updated"); return
    if reason == "idle" and belowThreshold(newMessages, doc):
      doc.status = "stale"; doc.meta.lastCheckedAt = now
      persist; emit("updated"); scheduleForceTimer; return
    if reason != "manual" and overHourlyCap(doc):
      doc.status = "stale"
      doc.meta.notice = { kind: "hourly-cap", message: "...", at: now }
      doc.meta.lastCheckedAt = now
      persist; emit("updated"); return
    for chunk of chunkByChars(newMessages):
      digest = buildDigest(chunk)
      output = callModel(prompt(doc, digest))
      { parsed, callsMade } = validateAndRepair(output)
      apply(doc, parsed, digest.aliasMap)
      doc.watermark = lastMessage(chunk)
      doc.status = "ready"
      doc.meta.notice = undefined
      doc.meta.lastError = undefined
      recordModelCalls(doc, digest, reason != "manual", callsMade)
      persist(doc)                  // atomic document write
      emit("progress")
    emit("updated")
```

`incompleteBackfill(doc)` is `doc.backfill !== null && doc.backfill.completedAt == null`. A completed backfill with a later incremental error is not incomplete, so automatic retries still work.

`overHourlyCap(doc)` counts `meta.recentAutoCalls` within the last 60 minutes. `recordModelCalls(doc, digest, automatic, callsMade)` increments `callCount` by `callsMade` and adds the digest size to `estimatedInputChars`. It appends one timestamp per call to `recentAutoCalls` only when `automatic` is true, and prunes entries older than one hour before the document is persisted. Backfill and manual refresh pass `automatic: false`; idle/open refreshes pass `true`. `callsMade` is 1 for a valid first response and 2 when a repair call was needed. Failed calls are recorded too; a batch that errors still consumes the cap window.

The session is never blocked. The model call is out-of-band.

### 8.4 Apply

- New chapter: assign `ch_<uuid>`, resolve highlight anchors, compute `startedAt`/`endedAt` from highlight times, append.
- Extend: append highlights, update `summary`/`title` when non-empty, set `endedAt = max(endedAt, latest highlight time)`, set `updatedAt`.
- Tasks: replace the ledger when the model returns an array; preserve `updatedAt` for unchanged tasks, set it to now for changed ones.
- Goal: replace when non-empty.
- Set `coverage.partial = true` when the source is partial; never clear it here.
- Set `meta.model` to the model used for the successful batch and `meta.promptVersion` to the current prompt version.
- Advance the watermark and persist in one write.

### 8.5 Concurrency

- Single-flight per session. A request during an active run sets a `rerunRequested` flag; the engine runs once more after the current run.
- A global semaphore caps concurrent model calls (default 2). Additional calls wait.
- Backfill and refresh share the per-session lock. Idle events during an active backfill queue one refresh for after completion. This shares the same coalescing flag as the post-completion check, so at most one follow-up refresh runs. If the backfill is paused or failed (not running), idle updates are skipped until it is resumed or rebuilt.
- `cancel` stops backfill between chunks and ignores an in-flight model result. Partial work is kept, the watermark remains at the last successful chunk, `backfill.cancelled` is set, and `status` becomes `paused` when a watermark exists or `empty` otherwise. A cancelled backfill is not resumed automatically; the user must start it again.
- On plugin unload, clear debounce/force timers and abort the event subscription. In-flight model results are ignored.

### 8.6 Failure behavior

| Failure | Behavior |
|---|---|
| No model configured | runtime `disabledReason`; panel shows the exact config snippet; zero calls |
| Model not found | runtime `disabledReason`; revalidated on plugin reload |
| 401/403 | runtime `disabledReason` (auth); no automatic retries until reload |
| 429/5xx/timeout | Retry twice with backoff and jitter; then `error`, watermark unchanged |
| Invalid JSON/schema | One repair call; then `error`, watermark unchanged |
| Unknown anchors | Drop affected highlights; keep tasks with null anchors; still advance |
| Storage write failure | `error`; watermark unchanged; retry on next trigger |
| Hourly cap reached | `stale` plus `meta.notice` of kind `hourly-cap`; automatic calls stop; manual refresh bypasses the cap and clears the notice |
| Transcript changed | `stale` plus `meta.notice` of kind `history-changed`; automatic refreshes stop; the panel offers rebuild |
| Server restart | Document persists; in-flight work is lost. A completed timeline resumes from the watermark; an interrupted backfill is surfaced as paused/error for explicit resume |
| Session deleted | Delete the document if the event is available; otherwise lazy-delete on read |

Automatic incremental updates respect `maxUpdatesPerHour` (default 30 per session). Manual refresh bypasses thresholds and the cap because the user explicitly asked, and it clears the cap notice. Backfill is user-initiated and does not count against the incremental cap. A `history-changed` notice is not bypassed by manual refresh; only a rebuild resolves it.

## 9. Backfill

### 9.1 Estimate

`estimateBackfill(messages)` returns:

```ts
{ messages: number; chars: number; chunks: number; approxCalls: number }
```

`approxCalls = chunks`. Chars are the estimated digest size after filtering and truncation; the estimate is intentionally rough.

### 9.2 Flow

1. `ensure(sessionID)` loads the document.
   - Reject child sessions before doing any work.
   - If a backfill is actively running, return `busy: true` and `needsBackfill: false`.
   - If the document has an incomplete backfill (`paused`, cancelled, errored during backfill, or interrupted), return `needsBackfill: true` with an estimate for the remaining messages. Do not auto-resume.
   - If the document has `status === "error"` from an incremental update and a watermark, return it unchanged. The panel offers retry.
   - If the document has a `history-changed` notice, return it unchanged. Only a rebuild resolves it.
   - If the document has a watermark and no incomplete backfill, optionally start `refresh("open")` when the last check is older than `openRefreshAfterMinutes` and new messages exist. Return the document with `busy`.
   - If there is no document, or `watermark === null`, read messages.
     - If there are no messages, create or return an `empty` document with `needsBackfill: false`; no model call.
     - Estimate. If `approxCalls <= confirmOverCalls` (default 10) and `backfill.cancelled` is not set, start backfill automatically.
     - Otherwise return `needsBackfill: true` with the estimate. The TUI asks for confirmation.
2. `backfill(sessionID, { confirm: true })` creates or resumes a document with `status = "backfilling"`, clears `backfill.cancelled`/`backfill.error`, and processes a **snapshot** of messages taken at start. It rejects with `busy` if a backfill is already running. New messages that arrive during backfill are left for the follow-up refresh.
3. On a fresh backfill, chunk 1 has no prior chapter. Later chunks receive the goal, task ledger, and the last chapter's summary/highlights for continuity.
4. After each chunk: update the watermark, `backfill.processedMessages`, `meta.lastCheckedAt`, and the model counters (with `automatic: false`); persist and emit progress.
5. On completion: set `backfill.completedAt`, set coverage, and leave the watermark at the last snapshot message. After the backfill releases the session lock, re-read the message tail. If messages newer than the watermark exist, set `status = "stale"` and queue exactly one `refresh("open")`; otherwise set `status = "ready"`.
6. On failure: keep partial work, `status = "error"`, `backfill.error`, and resume from the watermark on retry. The panel shows "Paused at N/M messages — Retry."
7. On cancel: keep partial work, set `backfill.cancelled`, and set `status` to `paused` when a watermark exists or `empty` otherwise. The panel offers "Resume backfill" instead of auto-resuming.
8. If a fresh backfill finds no messages: create an `empty` document with no model call.
9. `rebuild` requires confirmation and returns an estimate first; it clears the document and reruns this flow.
10. On startup, a document left in `backfilling` with no active run is treated as interrupted: mark it `paused` (or `error` if the last chunk failed), keep the partial work, and offer resume. Do not auto-resume.

Backfill only starts when there is no watermark, or when an incomplete backfill is being resumed. Once a backfill has completed, use `rebuild` to regenerate. Backfill continues if the panel closes. Progress events are live-only; the panel refetches on open.

While a backfill is incomplete (cancelled or errored with a partial watermark), incremental updates are paused. Idle events do not append newer chapters, and manual `refresh` returns `invalid_request` until the user resumes or rebuilds. This keeps chapters chronological instead of mixing newer work ahead of unprocessed older work.

### 9.3 Compaction

If the first available message is a compaction message:

- Set `coverage = { partial: true, reason: "compacted-history" }`.
- Include the compaction summary in the first digest as background.
- The panel shows "Partial: earlier history was compacted."
- The timeline does not pretend to cover the dropped transcript.

If the runtime exposes full-history pagination, the engine uses it and `partial` is false.

## 10. RPC contract

RPC id: `nexusnv.timeline`. Defined with `Rpc.define` and shared portable JSON Schemas (`as const`, matching the sibling plugin). The TUI imports the contract from `./rpc`. Model output is validated separately with a strict runtime schema (Zod or equivalent).

### 10.1 Methods

| Method | Input | Output | Notes |
|---|---|---|---|
| `get` | `{ sessionID }` | `{ document, busy, disabledReason? }` | No model work triggered; rejects child sessions |
| `ensure` | `{ sessionID }` | `{ document, busy, needsBackfill, estimate?, disabledReason? }` | Starts small backfills; returns an estimate for large ones; rejects child sessions |
| `backfill` | `{ sessionID, confirm? }` | `{ started, estimate }` | Starts an unbuilt timeline or resumes an incomplete backfill; `confirmation_required` when over threshold without confirm |
| `refresh` | `{ sessionID }` | `{ started, coalesced }` | Requires a watermark and a completed backfill; bypasses thresholds and the hourly cap |
| `rebuild` | `{ sessionID, confirm? }` | `{ started, estimate }` | `confirmation_required` with an estimate unless `confirm: true`; clears and re-backfills |
| `cancel` | `{ sessionID }` | `{ cancelled }` | Stops between chunks |
| `excerpt` | `{ sessionID, messageID }` | `{ items: ExcerptItem[] }` | Sanitized surrounding text for the dialog |

```ts
type ExcerptItem = {
  role: "user" | "assistant" | "tool" | "system"
  at: string
  text: string
  messageID: string
  isAnchor: boolean
}
```

`ensure` starts an automatic backfill only when the estimate is at or below `confirmOverCalls`. Otherwise it returns `needsBackfill` and the TUI asks. `ensure` does not auto-retry an `error` document; it returns the error state so the panel can offer retry. A document with an incomplete backfill returns `needsBackfill: true` so the panel offers resume. Child sessions return `invalid_request` with a clear message.

`disabledReason` is runtime-only. When present, the panel renders the disabled state and no method makes a model call. `refresh` returns `started: true` when a run begins and `coalesced: true` when it joined an active run instead. `backfill` and `rebuild` return `started: false` only when there was nothing to do. Long-running methods return immediately after starting work; progress arrives through events and the panel refetches on open.

### 10.2 Events

| Event | Data |
|---|---|
| `updated` | `{ sessionID, status, chapterCount, taskCount, updatedAt }` |
| `progress` | `{ sessionID, phase: "backfill" \| "update", processed, total, chapters }` |
| `error` | `{ sessionID, kind, message, retryable }` |

The TUI subscribes, filters by `sessionID`, and refetches `get` on `updated`, on `error`, and on `progress` when the chapter count changes. Events are live-only; opening the panel always refetches. `updated` is emitted on successful updates and on status transitions such as `stale`, `error`, cap/history notices, and backfill cancellation.

### 10.3 Errors

- `session_not_found` → `{ sessionID }`
- `disabled` → `{ reason }`
- `confirmation_required` → `{ estimate }`
- `busy` → `{ sessionID }`
- `invalid_request` → `{ message }`
- `internal` → `{ message }`

RPC transport/system errors such as `rpc.unavailable` or `rpc.invalid_output` surface in the panel as a generic error state with a retry; they are not modeled as plugin errors.

### 10.4 Access

The RPC validates that the session exists and belongs to the plugin's project (project ID, including worktrees). It does not expose sessions from other projects, and it rejects child sessions with `invalid_request`. The excerpt method also verifies that `messageID` belongs to the session and returns sanitized text only: no reasoning, no file contents, no images.

## 11. TUI

### 11.1 Layout

One column, usable in a narrow side panel and fullscreen:

```text
Timeline                                  READY · 2m ago · gpt-5-mini
Goal  Add a session timeline plugin for OpenCode
Tasks 3/7 done   open: TUI panel, backfill, tests
Decisions  server-owned engine; append-only chapters
Artifacts  PR #42 opened

10:12–10:38  Built the server engine                 3 highlights  ▾
  ◆ Decision  Timeline is append-only
  ◆ Impl      Watermark + digest pipeline
  ◆ Task      Engine tests passing
10:40–11:05  TUI panel                               2 highlights  ▸
11:07–11:20  Backfill + failure handling             4 highlights  ▸
```

- **Header:** goal, task counts with open/blocked items, latest decisions, latest artifacts (PRs and commits), status badge, model name, relative update time.
- **Timeline:** chronological, oldest first, auto-scrolled to the newest chapter on open. The selected chapter expands inline. Chapter rows show time range, title, summary, and highlight count.
- **Highlights:** typed glyph, text, time. Selecting one opens the excerpt dialog.
- **Footer:** state-aware hints (`j/k`, `enter`, `r`, `b`, `x`).

### 11.2 States

- **Empty:** no document, or a document that has never processed history (watermark null, with no active or failed backfill). Show "Build timeline from this session's history" with message count and estimated calls. `b` builds. If the session has no messages, say "No messages yet" instead of offering a build.
- **Needs confirmation:** large backfill; show the estimate and confirm/cancel.
- **Backfilling:** progress bar, processed/total, cancel.
- **Paused/cancelled:** partial timeline (or empty when no chunk succeeded) plus "Backfill paused — resume" action; no automatic resume.
- **Ready:** normal layout. If the watermark is current but no chapter qualified, show "No milestones found yet. New activity will update this timeline." instead of the build prompt.
- **Stale:** "New activity — r to refresh" badge; opening the panel refreshes when older than the configured interval.
- **Notice:** a one-line banner for `hourly-cap` ("Automatic updates paused; r to refresh now") or `history-changed` ("Transcript changed; b to rebuild"). The timeline below remains readable.
- **Error:** message, retry action, and a hint for config/auth failures. If the error came from backfill, `b` resumes from the watermark.
- **Disabled:** if `enabled` is false, say the timeline is disabled; otherwise show the config snippet with the required `model` option. No calls are made.
- **Child session:** "Timeline is available for root sessions."

### 11.3 Excerpt dialog

- Fetches `excerpt` for the highlight's anchor.
- Shows 1–5 sanitized items: nearest user message, the anchor, and the assistant conclusion after it. Tool items show the name, status, and a short output excerpt for side-effecting tools; read/file-content results are excluded.
- Reasoning and file contents are never shown.
- If the message is no longer available (compacted), show "Original message not available (compacted)."
- Scrollable, large dialog, centered.

### 11.4 Commands and keys

- Global command: "Open session timeline", slash `/timeline`, palette entry. Enabled only when a session is selected. No default keybind, to avoid conflicts.
- Panel-scoped, only when focused:
  - `j`/`down`, `k`/`up`: move across chapters and visible highlights.
  - `enter`: expand/collapse a chapter, or open the excerpt for a highlight.
  - `r`: refresh (disabled during backfill; retries an incremental error and clears an hourly-cap notice). It does not resume a paused backfill or clear a `history-changed` notice.
  - `b`: build a fresh timeline, resume a paused/backfill-errored document, or rebuild a completed one. Confirmation is required for a fresh build over the call threshold and for any rebuild.
  - `x`: cancel backfill.
  - `g`/`G`: first/last row.

### 11.5 Presentation

- Theme tokens only; no hardcoded colors.
- Status colors: ready = success, stale = warning, paused = warning, error = error, runtime disabled = muted, backfilling = info.
- Relative times ("just now", "2m ago"); chapter ranges use local `HH:MM`, with a date when the chapter crosses days.
- Long text wraps or truncates; the panel must not overflow at narrow widths.
- The TUI caches in memory only. No TUI storage.

## 12. Configuration

```jsonc
{
  "plugins": [{
    "package": "opencode-nexusnv-timeline",
    "options": {
      "enabled": true,
      "model": { "providerID": "openai", "modelID": "gpt-5-mini" },
      "update": {
        "debounceMs": 15000,
        "minNewUserTurns": 2,
        "minNewMessages": 6,
        "forceAfterMinutes": 10,
        "openRefreshAfterMinutes": 2
      },
      "backfill": {
        "confirmOverCalls": 10
      },
      "digest": {
        "maxChars": 28000,
        "maxUserChars": 4000,
        "maxAssistantChars": 2000,
        "maxToolResultChars": 600,
        "maxCompactionChars": 4000,
        "redact": true
      },
      "limits": {
        "maxConcurrentCalls": 2,
        "maxUpdatesPerHour": 30,
        "modelTimeoutMs": 60000,
        "retries": 2
      }
    }
  }]
}
```

- `model` is required unless `enabled` is false. No fallback.
- Unknown keys are rejected (strict schema) to catch typos.
- Invalid config loads the plugin but disables the engine. The panel shows the error and the required snippet.
- The model is validated against `ctx.model.list()` by matching `providerID` and `modelID` at setup and again on first use. A missing model produces a runtime `disabledReason`, not a runtime surprise. If the model list read itself fails, the engine defers validation to the first call and reports a model error.
- `digest.maxChars` caps one model call's digest and is shared by incremental updates and backfill.
- `limits.maxUpdatesPerHour` is per session and applies to automatic incremental updates only. Backfill and manual refresh are user-initiated and are not counted.
- Config changes reload the plugin; existing documents are kept and continue with the new model on the next update.

## 13. Error handling and limits

- **Timeouts:** each model call has a timeout (default 60 s). The generate API may not support cancellation; late results are ignored.
- **Retries:** two retries for transient failures, with exponential backoff and jitter. No retry for auth or model-not-found errors.
- **Hourly cap:** automatic incremental model calls are capped per session (default 30/hour). Manual refresh and backfill bypass the cap. The panel explains when the cap is reached.
- **Global concurrency:** at most two model calls in flight across sessions. Others wait.
- **Storage:** documents are written atomically. A failed write leaves the previous document and watermark intact. Because the failure cannot be persisted, it is kept as a runtime error overlay for that session and returned by RPC; the next successful trigger retries from the persisted watermark.
- **No prompt logging:** logs include session IDs, sizes, durations, and sanitized errors only.
- **No session mutation:** the plugin never prompts, compacts, edits, or interrupts the session.

## 14. Testing

### Unit

- Digest: user/assistant/tool filtering, reasoning dropped, routine reads dropped, error tools included, truncation, aliases, redaction, evidence, char budget.
- Watermark: found, missing with time fallback, compaction, empty.
- Model output: valid, no-op, extend, new, fenced JSON, invalid JSON, unknown keys, invalid anchors, too many chapters/highlights, long text, duplicate tasks/highlights, invalid URLs, per-item invalid enums.
- Apply: append/extend, timestamps from anchors, `endedAt` max, task ledger replacement, goal updates, coverage set-only, watermark advance, no-op.
- Prompt: includes state/chapter ID/digest/evidence/schema/limits and the untrusted-data rule; snapshot test.
- Config: defaults, missing model, unknown keys, disabled, invalid model.
- Excerpt: surrounding messages, reasoning stripped, truncation, missing anchor.
- Estimate: chunks and calls.
- Notices: hourly cap, history changed, clearing on manual refresh/rebuild.
- Artifacts: PR and commit deduplication; header derives from any artifact highlight.
- Status: `disabled` is runtime-only and never persisted.

### Engine

- Debounce, threshold skip, force timer.
- Idle events do not start a first-time backfill.
- Child sessions are ignored and make zero model calls.
- Single-flight and coalescing.
- Retry/backoff, auth error disables, invalid output repair.
- Failure preserves the watermark; retry does not duplicate chapters.
- Backfill across chunks, failure on chunk 2, resume, cancel, and cancelled-state persistence.
- Backfill completion with messages that arrived during the snapshot runs exactly one follow-up refresh.
- Paused/incomplete backfill blocks idle updates and manual refresh.
- History-changed notice blocks all refreshes until rebuild.
- Hourly cap sets a notice; manual refresh bypasses and clears it.
- Global concurrency cap.
- Server restart resume from persisted state.

### RPC and TUI

- RPC schema validation, error mapping, event emission.
- TUI view-model: row flattening, selection, expansion, status folding, relative time, excerpt formatting.
- Render smoke test if the OpenTUI harness supports it; otherwise manual smoke.

### Tooling

- TypeScript ESM on Bun, `tsc --noEmit`, oxlint, Prettier, and `bun test`.
- Pin `@opencode/plugin` and `@opencode/theme` to `2.1.4`, `@opentui/core` and `@opentui/solid` to `0.6.8`, and Bun to `1.4.x`, matching the sibling plugin.
- `bun run check` runs format check, lint, typecheck, and tests.

### Manual smoke

- Load the plugin locally; open `/timeline` on a long session.
- Confirm backfill, watch progress, close and reopen the panel.
- Restart OpenCode; verify persistence.
- Use an invalid model; verify the disabled state and zero calls.
- Inject a model failure; verify stale/error and retry.
- Verify reasoning and file contents never appear in the panel or excerpt.

### Acceptance criteria

1. A 40-turn session produces roughly 3–6 chapters, not one per turn.
2. Every highlight opens an excerpt with the relevant user/assistant text and no reasoning.
3. A PR highlight appears only when the evidence contains a PR URL or number.
4. A failed update leaves the watermark unchanged; a retry produces no duplicates.
5. Backfill resumes after a failed chunk without redoing successful chunks.
6. The timeline survives a server restart.
7. A missing model produces a clear disabled state and zero model calls.
8. A large backfill asks for confirmation and can be cancelled.
9. An idle event on a session with no timeline does not start a backfill or make a model call.
10. Child sessions produce no timeline and no model calls.
11. Messages that arrive during a backfill are summarized by exactly one follow-up refresh, not lost.
12. A completed timeline with no qualifying highlights shows "No milestones found yet", not the build prompt.
13. A runtime-disabled plugin does not rewrite existing documents; re-enabling resumes from the stored watermark.

## 15. Security and privacy

- The digest is sent only to the configured provider. The panel shows which model is used.
- Reasoning, full file bodies, images, and attachment data are never deliberately sent. Command output is capped and redacted because it can contain incidental text.
- Secrets are redacted by default.
- Prompts and message contents are never logged.
- Storage is local to the OpenCode server; there is no external sync.
- The RPC validates project access and returns sanitized excerpts only.

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `ctx.session.context` loses pre-compaction history | Mark coverage partial; seed from the compaction summary; use full-history pagination if the runtime exposes it |
| The compaction summary is absent from `context` | Mark partial from the runtime's compaction signal; never claim coverage of the dropped transcript |
| One-shot generate API differs by OpenCode version | Adapter prefers `ctx.experimental.generate.text`, falls back to `ctx.generate.text`; maps `modelID` to the API's `id`; document the tested version |
| Cheap model produces weak chapter boundaries | Prompt versioning, strict limits, rebuild action; two-stage extraction is the fallback upgrade |
| Model hallucinates PR/test results | Evidence block, factuality rules, anchor validation, excerpt verification |
| Long backfill cost | Estimate, confirmation over 10 calls, progress, cancel, resume |
| RPC events missed while the panel is closed | Refetch on mount; events are an optimization, not the source of truth |
| `session.deleted` event unavailable | Lazy deletion when a read finds the session missing |
| Task ledger drift | Stable keys, fuzzy title matching, `todowrite` evidence, prompt requires carrying tasks forward |

## 17. Implementation outline

1. Domain types, config schema, storage wrapper, document invariants, persisted status vs runtime disabled/notice.
2. Digest, evidence, redaction, aliasing, chunking, estimate.
3. Prompt template, model adapter, output validation/repair.
4. Apply/merge, watermark, task reconciliation.
5. Engine: triggers, thresholds, single-flight, retries, limits.
6. Backfill: estimate, confirmation, progress, resume, cancel.
7. RPC contract and handlers.
8. TUI: command, panel, header, chapter list, excerpt dialog, states.
9. Tests, manual smoke, packaging, README.

## 18. Future work

- Markdown export.
- Project-wide timeline across sessions.
- Direct message navigation if OpenCode adds it.
- Two-stage extraction/chaptering for higher quality.
- Manual pinning/editing of chapters.
- Agent-facing timeline tool for handoff.
- GUI panel.
- Full pre-compaction backfill when full-history pagination is available.
- Usage/cost display if the generate API returns usage.
