import type { Plugin } from "@opencode/plugin"
import { STORAGE_PREFIX } from "../shared/ids.js"
import { parseDocument } from "../shared/document.js"
import type { TimelineDocument } from "../shared/types.js"

export interface TimelineStore {
  load(sessionID: string): Promise<TimelineDocument | undefined>
  save(document: TimelineDocument, now: string): Promise<void>
  remove(sessionID: string): Promise<void>
}

type StorageDomain = Plugin.Context["storage"]
type StoredJson = Parameters<StorageDomain["set"]>[1]

export class PluginTimelineStore implements TimelineStore {
  constructor(private readonly storage: StorageDomain) {}

  private key(sessionID: string): string {
    return `${STORAGE_PREFIX}/${sessionID}`
  }

  async load(sessionID: string): Promise<TimelineDocument | undefined> {
    const value = await this.storage.get(this.key(sessionID))
    if (value === undefined) return undefined
    const decoded = typeof value === "string" ? safeJson(value) : value
    return parseDocument(decoded)
  }

  async save(document: TimelineDocument, now: string): Promise<void> {
    document.meta.updatedAt = now
    await this.storage.set(this.key(document.sessionID), document as unknown as StoredJson)
  }

  async remove(sessionID: string): Promise<void> {
    await this.storage.remove(this.key(sessionID))
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
