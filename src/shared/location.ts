import type { Context } from "@opencode/plugin/tui/context"

export interface RpcLocation {
  directory: string
}

export function requireRpcLocation(context: Context): RpcLocation {
  const directory = context.location?.directory
  if (!directory) throw new Error("Recap requires a project location")
  return { directory }
}
