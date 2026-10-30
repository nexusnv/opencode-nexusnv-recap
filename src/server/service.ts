import type { Plugin } from "@opencode/plugin"
import { disabledReasonFor, type ParsedConfig } from "../config.js"
import type { TimelineEstimate } from "../shared/types.js"
import { buildExcerpt } from "./excerpt.js"
import { TimelineEngine, type EngineEventSink, type EnsureResult, type GetResult } from "./engine.js"
import type { ModelClient } from "./model.js"
import { readSessionMessages } from "./read.js"
import type { TimelineStore } from "./store.js"

export class TimelineService {
  private readonly engine: TimelineEngine
  private events: EngineEventSink | undefined

  constructor(
    private readonly ctx: Pick<
      Plugin.Context,
      "session" | "model" | "storage" | "event" | "generate" | "experimental" | "location"
    >,
    private readonly parsed: ParsedConfig,
    store: TimelineStore,
    model: ModelClient,
  ) {
    const sink: EngineEventSink = {
      updated: (data) => this.events?.updated(data),
      progress: (data) => this.events?.progress(data),
      error: (data) => this.events?.error(data),
    }
    this.engine = new TimelineEngine({
      ctx: this.ctx,
      config: parsed.config,
      store,
      model,
      events: sink,
      disabledReason: disabledReasonFor(parsed),
    })
  }

  bindEvents(events: EngineEventSink): void {
    this.events = events
  }

  start(): Promise<void> {
    return this.engine.start()
  }

  stop(): Promise<void> {
    return this.engine.stop()
  }

  get(sessionID: string): Promise<GetResult> {
    return this.engine.get(sessionID)
  }

  ensure(sessionID: string): Promise<EnsureResult> {
    return this.engine.ensure(sessionID)
  }

  backfill(sessionID: string, confirm: boolean): Promise<{ started: boolean; estimate: TimelineEstimate }> {
    return this.engine.backfill(sessionID, confirm)
  }

  refresh(sessionID: string): Promise<{ started: boolean; coalesced: boolean }> {
    return this.engine.refresh(sessionID, "manual")
  }

  rebuild(sessionID: string, confirm: boolean): Promise<{ started: boolean; estimate: TimelineEstimate }> {
    return this.engine.rebuild(sessionID, confirm)
  }

  cancel(sessionID: string): Promise<{ cancelled: boolean }> {
    return this.engine.cancel(sessionID)
  }

  async excerpt(sessionID: string, messageID: string): Promise<{ items: ReturnType<typeof buildExcerpt> }> {
    await this.engine.resolve(sessionID)
    const read = await readSessionMessages(this.ctx, sessionID)
    return { items: buildExcerpt(read.messages, messageID, this.parsed.config) }
  }
}
