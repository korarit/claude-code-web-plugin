import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainChatEvent } from "../src/modules/chat/domain/chat.events.ts";
import {
  buildClaudeTranscriptPath,
  encodeClaudeProjectDir,
  JsonlTranscriptWatcher,
  parseClaudeTranscriptLine,
} from "../src/modules/chat/infrastructure/jsonl-watcher.ts";

describe("jsonl-watcher parser", () => {
  test("encodes project directory path deterministically", () => {
    expect(encodeClaudeProjectDir("/home/korarit/my.app")).toBe("-home-korarit-my-app");
    expect(buildClaudeTranscriptPath("/tmp/.claude", "/home/user/proj", "abc-123")).toBe(
      "/tmp/.claude/projects/-home-user-proj/abc-123.jsonl",
    );
  });

  test("parses user, assistant text, tool_use, Task subagent, usage, and tool_result lines", () => {
    const userEvents = parseClaudeTranscriptLine(
      JSON.stringify({
        type: "user",
        uuid: "u-1",
        timestamp: "2026-11-13T10:00:00Z",
        message: { role: "user", content: "Fix the bug" },
      }),
    );
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]).toMatchObject({ type: "user", role: "user", text: "Fix the bug" });

    const assistantEvents = parseClaudeTranscriptLine(
      JSON.stringify({
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-11-13T10:00:02Z",
        parent_tool_use_id: "task-99",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "text", text: "Inspecting file now." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/app.ts" } },
            { type: "tool_use", id: "task-1", name: "Task", input: { description: "Run tests" } },
          ],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 500,
            output_tokens: 75,
          },
        },
      }),
    );

    expect(assistantEvents.map((e) => e.type)).toEqual(["delta", "tool", "task", "result"]);
    expect(assistantEvents[0]).toMatchObject({
      type: "delta",
      text: "Inspecting file now.",
      parentToolUseId: "task-99",
    });
    expect(assistantEvents[1]).toMatchObject({
      type: "tool",
      tool: "Read",
      toolUseId: "tool-1",
      text: "Read: src/app.ts",
    });
    expect(assistantEvents[2]).toMatchObject({
      type: "task",
      tool: "Task",
      parentToolUseId: "task-1",
    });
    expect(assistantEvents[3]).toMatchObject({
      type: "result",
      usage: { inputTokens: 2600, outputTokens: 75, contextWindow: 200_000 },
    });

    const toolResultEvents = parseClaudeTranscriptLine(
      JSON.stringify({
        type: "user",
        uuid: "u-2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file contents ok" }],
        },
      }),
    );
    expect(toolResultEvents[0]).toMatchObject({
      type: "tool",
      tool: "tool_result",
      toolUseId: "tool-1",
      text: "file contents ok",
    });
  });

  test("tails new bytes incrementally and handles partial lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-jsonl-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(file, "", "utf8");

      const watcher = new JsonlTranscriptWatcher(dir);
      const received: DomainChatEvent[] = [];
      await watcher.watch("sess-1", file, (ev) => received.push(ev));

      // Write a partial line without newline
      appendFileSync(
        file,
        '{"type":"assistant","uuid":"a1","message":{"content":[{"type":"text","text":"Hel',
        "utf8",
      );
      await watcher.flushSession("sess-1");
      expect(received).toHaveLength(0);

      // Complete the line + append a second line
      appendFileSync(
        file,
        'lo world"}]}}\n{"type":"user","uuid":"u1","message":{"content":"Next"}}\n',
        "utf8",
      );
      await watcher.flushSession("sess-1");
      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({ type: "delta", text: "Hello world" });
      expect(received[1]).toMatchObject({ type: "user", text: "Next" });

      const replay = await watcher.readRecentEvents(file);
      expect(replay).toHaveLength(2);

      watcher.unwatch("sess-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
