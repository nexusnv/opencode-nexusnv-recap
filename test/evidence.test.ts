import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { DEFAULT_BACKFILL, DEFAULT_DIGEST, DEFAULT_LIMITS, DEFAULT_UPDATE, type TimelineConfig } from "../src/config"
import { buildEvidence } from "../src/server/evidence"

const BASE_TIME = Date.parse("2026-10-29T10:00:00.000Z")

function config(): TimelineConfig {
  return {
    enabled: true,
    model: { providerID: "openai", modelID: "gpt-5-mini" },
    update: DEFAULT_UPDATE,
    backfill: DEFAULT_BACKFILL,
    digest: DEFAULT_DIGEST,
    limits: DEFAULT_LIMITS,
  }
}

let sequence = 0

function id(prefix: string): string {
  sequence += 1
  return `${prefix}_${sequence}`
}

function toolPart(name: string, state: SessionMessageAssistantTool["state"]): SessionMessageAssistantTool {
  return { type: "tool", id: id("tool"), name, state, time: { created: BASE_TIME } }
}

function completed(input: Record<string, unknown>, text: string): SessionMessageAssistantTool["state"] {
  return { status: "completed", input: input as never, content: [{ type: "text", text }] }
}

function assistantMessage(tools: SessionMessageAssistantTool[]): SessionMessageInfo {
  return {
    id: id("assistant"),
    time: { created: BASE_TIME },
    type: "assistant",
    agent: "build",
    model: { id: "gpt-5-mini", providerID: "openai" },
    content: tools,
  }
}

function shell(command: string, exit: number, output: string): SessionMessageInfo {
  return {
    id: id("shell"),
    time: { created: BASE_TIME },
    type: "shell",
    shellID: "sh_1",
    command,
    status: "exited",
    exit,
    output: { output, cursor: 0, size: output.length, truncated: false },
  }
}

describe("buildEvidence", () => {
  test("collects files touched from edit, write, and patch", () => {
    const evidence = buildEvidence(
      [
        assistantMessage([
          toolPart("edit", completed({ filePath: "src/a.ts", oldString: "", newString: "x" }, "ok")),
          toolPart("write", completed({ path: "src/b.ts", content: "x" }, "ok")),
          toolPart("patch", completed({ file_path: "src/c.ts", patchText: "@@" }, "ok")),
        ]),
      ],
      config(),
    )
    expect(evidence).toContain("Files touched: src/a.ts, src/b.ts, src/c.ts")
  })

  test("lists commands and check statuses for shell messages and tools", () => {
    const evidence = buildEvidence(
      [
        shell("bun test", 0, "12 tests passed"),
        shell("bun run lint", 1, "1 error"),
        assistantMessage([
          toolPart("shell", completed({ command: "bun run typecheck" }, "ok")),
          toolPart("bash", {
            status: "error",
            input: { command: "bun run build" } as never,
            error: { type: "error", message: "build failed" },
          }),
          toolPart("shell", completed({ command: "cat package.json" }, "file body")),
        ]),
      ],
      config(),
    )
    const checks = evidence.split("\n").find((line) => line.startsWith("Checks:"))
    expect(checks).toContain("bun test passed")
    expect(checks).toContain("bun run lint failed")
    expect(checks).toContain("bun run typecheck passed")
    expect(checks).toContain("bun run build failed")
    expect(checks).not.toContain("cat package.json")
  })

  test("collects PR, commit, gh, and git references", () => {
    const evidence = buildEvidence(
      [
        shell(
          "gh pr create --title Recap",
          0,
          [
            "https://github.com/acme/widgets/pull/42",
            "https://github.com/acme/widgets/pull/42",
            "https://github.com/acme/widgets/commit/abcdef1234567890",
          ].join("\n"),
        ),
        assistantMessage([toolPart("shell", completed({ command: "git commit -m 'feat: recap'" }, "committed"))]),
      ],
      config(),
    )
    expect(evidence).toContain("References:")
    expect(evidence).toContain("https://github.com/acme/widgets/pull/42")
    expect(evidence).toContain("https://github.com/acme/widgets/commit/abcdef1234567890")
    expect(evidence).toContain("gh pr create --title Recap")
    expect(evidence).toContain("git commit -m 'feat: recap'")
    expect(evidence.split("https://github.com/acme/widgets/pull/42").length - 1).toBe(1)
  })

  test("collects todowrite entries", () => {
    const evidence = buildEvidence(
      [
        assistantMessage([
          toolPart(
            "todowrite",
            completed(
              {
                todos: [
                  { content: "write tests", status: "pending" },
                  { content: "ship recap", status: "pending" },
                ],
              },
              "ok",
            ),
          ),
        ]),
      ],
      config(),
    )
    expect(evidence).toContain("Todos: write tests | ship recap")
  })

  test("redacts secrets from generated evidence", () => {
    const evidence = buildEvidence(
      [shell("export api_key=supersecret123", 0, "token ghp_abcdefghijklmnopqrstuvwx")],
      config(),
    )
    expect(evidence).toContain("[REDACTED]")
    expect(evidence).not.toContain("supersecret123")
    expect(evidence).not.toContain("ghp_abcdefghijklmnopqrstuvwx")
  })

  test("caps evidence at 2,000 characters", () => {
    const paths = Array.from({ length: 20 }, (_value, index) => `src/${"a".repeat(120)}-${index}.ts`)
    const evidence = buildEvidence(
      [
        assistantMessage(
          paths.map((path) => toolPart("edit", completed({ filePath: path, oldString: "", newString: "x" }, "ok"))),
        ),
      ],
      config(),
    )
    expect(evidence.length).toBeLessThanOrEqual(2_000)
    expect(evidence).toContain("…[truncated]…")
  })

  test("returns empty evidence for ignored messages", () => {
    const idle: SessionMessageInfo = {
      id: id("idle"),
      time: { created: BASE_TIME },
      type: "idle",
      outcome: "succeeded",
    }
    expect(buildEvidence([idle], config())).toBe("")
  })
})
