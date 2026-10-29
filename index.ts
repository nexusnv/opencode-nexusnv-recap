/**
 * Local-directory entrypoint. The host probes `<dir>/server` before
 * `<dir>/index`; package targets use the `exports` map.
 */
export { default } from "./src/index.js"
export * from "./src/index.js"
