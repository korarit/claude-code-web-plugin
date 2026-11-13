import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainChatEvent } from "../src/modules/chat/domain/chat.events.ts";
import {
  SessionBusyError,
  SessionNotFoundError,
} from "../src/modules/chat/domain/errors.ts";
import {
  AbortSessionUsecase,
  DeleteSessionUsecase,
  HandleHookUsecase,
  SendMessageUsecase,
  UpdateSessionUsecase,
  type TerminalRunnerPort,
  type TranscriptWatcherPort,
} from "../src/modules/chat/application/index.ts";
import { InMemoryEventBus } from "../src/modules/chat/infrastructure/event-bus.ts";
import { FileSessionRepository } from "../src/modules/chat/infrastructure/session.repository.ts";

function createFakeRunner() {
  const calls: string[] = [];
  const runner: TerminalRunnerPort = {
    isAvailable: async () => true,
    ensureSession: async ({ sessionId }) => {
      calls.push(`ensure:${sessionId}`);
      return { tmuxSession: `cw-${sessionId.slice(0, 8)}`, isNew: true };
    },
    sendPrompt: async (tmuxSession, prompt) => {
      calls.push(`send:${tmuxSession}:${prompt}`);
    },
    sendRawKeys: async (tmuxSession, keys) => {
      calls.push(`keys:${tmuxSession}:${keys}`);
    },
    abortSession: async (tmuxSession) => {
      calls.push(`abort:${tmuxSession}`);
    },
    stopSession: async (tmuxSession) => {
      calls.push(`stop:${tmuxSession}`);
    },
    listActiveSessions: async () => [],
    notifyReady: (sessionId) => {
      calls.push(`ready:${sessionId}`);
    },
  };
  return { runner, calls };
}

function createFakeWatcher(): TranscriptWatcherPort & { watched: Map<string, string> } {
  const watched = new Map<string, string>();
  return {
    watched,
    resolveTranscriptPath: (cwd, sessionId) => join(cwd, `${sessionId}.jsonl`),
    watch: async (sessionId, path) => {
      watched.set(sessionId, path);
    },
    unwatch: (sessionId) => {
      watched.delete(sessionId);
    },
    readRecentEvents: async () => [],
  };
}

describe("chat usecases and FileSessionRepository", () => {
  test("SendMessageUsecase creates session, rejects busy session, and persists across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hw-uc-"));
    try {
      const repoPath = join(dir, "sessions.json");
      const repo = new FileSessionRepository(repoPath);
      const { runner, calls } = createFakeRunner();
      const watcher = createFakeWatcher();
      const bus = new InMemoryEventBus();

      const sendUc = new SendMessageUsecase(repo, runner, watcher, bus, {
        port: 3000,
        token: "tok",
        defaultCwd: dir,
      });

      const res1 = await sendUc.execute({ prompt: "Hello Claude", model: "sonnet" });
      expect(res1.ok).toBe(true);
      if (!res1.ok) return;
      const session = res1.value.session;
      expect(session.status).toBe("running");
      expect(session.origin).toBe("web");
      expect(watcher.watched.has(session.id)).toBe(true);
      expect(calls.some((c) => c.startsWith("send:"))).toBe(true);

      // Sending while running returns 409 SessionBusyError
      const resBusy = await sendUc.execute({ prompt: "Second", sessionId: session.id });
      expect(resBusy.ok).toBe(false);
      if (!resBusy.ok) {
        expect(resBusy.error).toBeInstanceOf(SessionBusyError);
      }

      // HandleHookUsecase updates SessionStatus accurately
      const events: DomainChatEvent[] = [];
      bus.subscribe(session.id, (e) => events.push(e));
      const hookUc = new HandleHookUsecase(repo, watcher, bus, runner);

      await hookUc.execute({
        sessionId: session.id,
        hookEventName: "PermissionRequest",
        toolName: "Bash",
      });
      expect(repo.get(session.id)?.status).toBe("waiting_permission");
      expect(events.some((e) => e.type === "permission_prompt")).toBe(true);

      await hookUc.execute({ sessionId: session.id, hookEventName: "Stop" });
      expect(repo.get(session.id)?.status).toBe("idle");

      // Rename + reload from disk (simulating API restart)
      const updateUc = new UpdateSessionUsecase(repo, runner, watcher, bus);
      await updateUc.execute({ sessionId: session.id, title: "Auth Investigation" });

      const reloadedRepo = new FileSessionRepository(repoPath);
      const loaded = reloadedRepo.get(session.id);
      expect(loaded?.title).toBe("Auth Investigation");
      expect(loaded?.status).toBe("idle");

      // Archive stops tmux and hides from archived=false filter
      await updateUc.execute({ sessionId: session.id, archived: true });
      expect(repo.get(session.id)?.status).toBe("stopped");
      expect(repo.list({ archived: false })).toHaveLength(0);
      expect(repo.list({ archived: true })).toHaveLength(1);

      // Unarchive + abort + delete permanently
      await updateUc.execute({ sessionId: session.id, archived: false });
      const abortUc = new AbortSessionUsecase(repo, runner, bus);
      const aborted = await abortUc.execute(session.id);
      expect(aborted.ok).toBe(true);
      expect(calls.some((c) => c.startsWith("abort:"))).toBe(true);

      const deleteUc = new DeleteSessionUsecase(repo, runner, watcher, bus);
      const deleted = await deleteUc.execute(session.id);
      expect(deleted.ok).toBe(true);
      expect(repo.get(session.id)).toBeNull();
      expect((await abortUc.execute("missing")).ok).toBe(false);

      const missingUpdate = await updateUc.execute({ sessionId: "missing", title: "X" });
      expect(missingUpdate.ok).toBe(false);
      if (!missingUpdate.ok) expect(missingUpdate.error).toBeInstanceOf(SessionNotFoundError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
