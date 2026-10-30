import { Plugin } from "@opencode/plugin"
import { parseConfig } from "./config.js"
import { TimelineRpc } from "./rpc.js"
import { TimelineFailure, sanitizeError } from "./server/errors.js"
import { createModelClient } from "./server/model.js"
import { TimelineService } from "./server/service.js"
import { PluginTimelineStore } from "./server/store.js"
import { parseBackfillInput, parseExcerptInput, parseSessionInput } from "./shared/contract.js"
import { SERVER_PLUGIN_ID } from "./shared/ids.js"

export { SERVER_PLUGIN_ID } from "./shared/ids.js"

export default Plugin.define({
  id: SERVER_PLUGIN_ID,
  async setup(ctx) {
    const parsed = parseConfig(ctx.options)
    const store = new PluginTimelineStore(ctx.storage)
    const model = createModelClient(ctx, parsed.config)
    const service = new TimelineService(ctx, parsed, store, model)

    const registration = await ctx.rpc.register(TimelineRpc, {
      get: (input, call) => guard(call, () => service.get(parseSessionInput(input).sessionID)),
      ensure: (input, call) => guard(call, () => service.ensure(parseSessionInput(input).sessionID)),
      backfill: (input, call) =>
        guard(call, () => {
          const parsedInput = parseBackfillInput(input)
          return service.backfill(parsedInput.sessionID, parsedInput.confirm)
        }),
      refresh: (input, call) => guard(call, () => service.refresh(parseSessionInput(input).sessionID)),
      rebuild: (input, call) =>
        guard(call, () => {
          const parsedInput = parseBackfillInput(input)
          return service.rebuild(parsedInput.sessionID, parsedInput.confirm)
        }),
      cancel: (input, call) => guard(call, () => service.cancel(parseSessionInput(input).sessionID)),
      excerpt: (input, call) =>
        guard(call, () => {
          const parsedInput = parseExcerptInput(input)
          return service.excerpt(parsedInput.sessionID, parsedInput.messageID)
        }),
    })

    service.bindEvents({
      updated: (data) => void registration.events.emit("updated", data).catch(() => undefined),
      progress: (data) => void registration.events.emit("progress", data).catch(() => undefined),
      error: (data) => void registration.events.emit("error", data).catch(() => undefined),
    })

    await service.start()

    return async () => {
      await service.stop()
      await registration.dispose()
    }
  },
})

interface ErrorFactory {
  error(type: string, message: string, data?: unknown): unknown
}

async function guard<Value>(call: unknown, run: () => Promise<Value>): Promise<Value> {
  const factory = call as ErrorFactory
  try {
    return await run()
  } catch (error) {
    if (error instanceof TimelineFailure) {
      return factory.error(error.code, error.message, errorData(error)) as never
    }
    if (error instanceof TypeError) {
      const message = sanitizeError(error)
      return factory.error("invalid_request", message, { message }) as never
    }
    const message = sanitizeError(error)
    return factory.error("internal", message, { message }) as never
  }
}

/**
 * Error schemas in `src/rpc.ts` require data for the message-only failures.
 * Only the structured failures carry custom data.
 */
function errorData(error: TimelineFailure): unknown {
  if (error.code === "disabled") return { reason: error.message }
  if (error.code === "confirmation_required" || error.code === "session_not_found" || error.code === "busy") {
    return error.data
  }
  return { message: error.message }
}
