import { useCallback, useRef, useState } from "react";
import type { ChatStreamEvent, ModelId } from "@contracts/chat";
import { newMessageId } from "@core/ids";
import { sendChat } from "../api.ts";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  sessionId?: string;
}

export interface TaskEntry {
  id: string;
  tool: string;
  label: string;
  subAgent: boolean;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  costUsd?: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function useChat() {
  const [model, setModel] = useState<ModelId>("sonnet");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [usage, setUsage] = useState<UsageState>({
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  });
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assistantId = useRef<string | null>(null);

  const applyEvent = useCallback((event: ChatStreamEvent) => {
    if (event.sessionId) setSessionId(event.sessionId);
    switch (event.type) {
      case "init":
        if (event.usage?.contextWindow) {
          setUsage((u) => ({ ...u, contextWindow: event.usage!.contextWindow! }));
        }
        break;
      case "delta":
        if (event.text) {
          const text = event.text;
          setMessages((prev) => {
            const id = assistantId.current;
            if (!id) return prev;
            return prev.map((m) => (m.id === id ? { ...m, text: m.text + text } : m));
          });
        }
        break;
      case "tool":
      case "task":
        setTasks((prev) => [
          ...prev,
          {
            id: newMessageId(),
            tool: event.tool ?? event.type,
            label: event.text ?? event.tool ?? event.type,
            subAgent: event.type === "task" || (event.parentToolUseId ?? null) !== null,
          },
        ]);
        break;
      case "result":
        if (event.usage) {
          setUsage((u) => ({
            ...u,
            inputTokens: event.usage!.inputTokens ?? u.inputTokens,
            outputTokens: event.usage!.outputTokens ?? u.outputTokens,
            contextWindow: event.usage!.contextWindow ?? u.contextWindow,
            costUsd: event.costUsd ?? u.costUsd,
          }));
        } else if (event.costUsd !== undefined) {
          setUsage((u) => ({ ...u, costUsd: event.costUsd }));
        }
        break;
      case "error":
        setError(event.message ?? "unknown error");
        break;
    }
  }, []);

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text || streaming) return;
      setError(null);
      setStreaming(true);
      const aid = newMessageId();
      assistantId.current = aid;
      setMessages((prev) => [
        ...prev,
        { id: newMessageId(), role: "user", text },
        { id: aid, role: "assistant", text: "" },
      ]);
      try {
        await sendChat({ prompt: text, sessionId, model, onEvent: applyEvent });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        assistantId.current = null;
        setStreaming(false);
      }
    },
    [applyEvent, model, sessionId, streaming],
  );

  const newSession = useCallback(() => {
    setSessionId(undefined);
    setMessages([]);
    setTasks([]);
    setError(null);
    setUsage({ inputTokens: 0, outputTokens: 0, contextWindow: DEFAULT_CONTEXT_WINDOW });
  }, []);

  return { model, setModel, sessionId, messages, tasks, usage, streaming, error, send, newSession };
}
