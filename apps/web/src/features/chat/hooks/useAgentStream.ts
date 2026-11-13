import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentNode } from "@contracts/agents";
import type { ChatStreamEvent } from "@contracts/chat";
import { newMessageId } from "@core/ids";
import { subscribeAgentEvents } from "../api.ts";
import type { ChatMessage, TaskEntry, ToolBlock, UsageState } from "./useChat.ts";

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function useAgentStream({
  activeSessionId,
  activeAgentId,
}: {
  activeSessionId?: string;
  activeAgentId?: string;
}) {
  const [agent, setAgent] = useState<AgentNode | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [usage, setUsage] = useState<UsageState>({
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  });
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  const applyEvent = useCallback((event: ChatStreamEvent) => {
    if (event.id) {
      const key = `${event.type}:${event.id}:${event.toolUseId ?? ""}:${event.text?.slice(0, 24) ?? ""}`;
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
    }

    switch (event.type) {
      case "agent_updated":
        if (event.agent) setAgent(event.agent);
        break;
      case "user":
        if (event.text) {
          const text = event.text;
          setMessages((prev) => [
            ...prev,
            {
              id: event.id ?? newMessageId(),
              role: "user",
              text,
              timestamp: event.timestamp,
            },
          ]);
        }
        break;
      case "delta":
        if (event.text) {
          const text = event.text;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              if (last.text === text) return prev;
              const nextText = last.text ? `${last.text}\n\n${text}` : text;
              return [...prev.slice(0, -1), { ...last, text: nextText }];
            }
            return [
              ...prev,
              {
                id: event.id ?? newMessageId(),
                role: "assistant",
                text,
                timestamp: event.timestamp,
              },
            ];
          });
        }
        break;
      case "tool":
      case "task": {
        const toolName = event.tool ?? event.type;
        const summary = event.text ?? toolName;
        const block: ToolBlock = {
          id: event.toolUseId ?? event.id ?? newMessageId(),
          tool: toolName,
          summary,
          input: event.toolInput,
          subAgent: true,
        };
        if (toolName !== "Thinking") {
          setTasks((prev) =>
            prev.some((t) => t.id === block.id)
              ? prev
              : [...prev, { id: block.id, tool: toolName, label: summary, subAgent: true }],
          );
        }
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            const existingTools = last.tools ?? [];
            if (existingTools.some((t) => t.id === block.id && t.summary === block.summary)) {
              return prev;
            }
            return [...prev.slice(0, -1), { ...last, tools: [...existingTools, block] }];
          }
          return [
            ...prev,
            {
              id: newMessageId(),
              role: "assistant",
              text: "",
              tools: [block],
              timestamp: event.timestamp,
            },
          ];
        });
        break;
      }
      case "result":
        if (event.usage) {
          setUsage((u) => ({
            ...u,
            inputTokens: event.usage!.inputTokens ?? u.inputTokens,
            outputTokens: event.usage!.outputTokens ?? u.outputTokens,
            contextWindow: event.usage!.contextWindow ?? u.contextWindow,
            costUsd: event.costUsd ?? u.costUsd,
          }));
        }
        break;
      case "error":
        setError(event.message ?? "Subagent stream error");
        break;
    }
  }, []);

  useEffect(() => {
    seenRef.current = new Set();
    setAgent(null);
    setMessages([]);
    setTasks([]);
    setError(null);
    setUsage({
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });

    if (!activeSessionId || !activeAgentId || activeAgentId === "main") {
      return;
    }

    const unsub = subscribeAgentEvents(activeSessionId, activeAgentId, applyEvent);
    return () => {
      unsub();
    };
  }, [activeSessionId, activeAgentId, applyEvent]);

  return {
    agent,
    messages,
    tasks,
    usage,
    error,
  };
}
