export type TimerHandle = ReturnType<typeof setTimeout>

export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle),
}
