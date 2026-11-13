import { useCallback, useEffect, useState } from "react";
import type { AgentNode, TeamTaskItem } from "@contracts/agents";
import { fetchAllAgents, fetchSessionAgents } from "../api.ts";

function upsertAgentList(list: AgentNode[], updated: AgentNode): AgentNode[] {
  const idx = list.findIndex((a) => a.agentId === updated.agentId);
  if (idx >= 0) {
    return list.map((a, i) => (i === idx ? updated : a));
  }
  if (updated.agentId === "main") {
    return [updated, ...list];
  }
  return [...list, updated];
}

export function useAgents(activeSessionId?: string) {
  const [agents, setAgents] = useState<AgentNode[]>([]);
  const [agentsBySession, setAgentsBySession] = useState<Record<string, AgentNode[]>>({});
  const [tasks, setTasks] = useState<TeamTaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchAllAgents()
      .then((res) => {
        if (!active) return;
        setAgentsBySession(res.bySession);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(
    async (targetId = activeSessionId) => {
      if (!targetId) {
        setAgents([]);
        setTasks([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetchSessionAgents(targetId);
        setAgents(res.agents);
        setTasks(res.tasks);
        const subagents = res.agents.filter((a) => a.agentId !== "main");
        setAgentsBySession((prev) => ({ ...prev, [targetId]: subagents }));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [activeSessionId],
  );

  useEffect(() => {
    if (!activeSessionId) {
      setAgents([]);
      setTasks([]);
      setError(null);
      return;
    }
    void refresh(activeSessionId);
  }, [activeSessionId, refresh]);

  const applySessionAgentUpdated = useCallback((sessionId: string, updated: AgentNode) => {
    if (updated.agentId !== "main") {
      setAgentsBySession((prev) => ({
        ...prev,
        [sessionId]: upsertAgentList(prev[sessionId] ?? [], updated),
      }));
    }
    if (sessionId === activeSessionId) {
      setAgents((prev) => upsertAgentList(prev, updated));
    }
  }, [activeSessionId]);

  const applyAgentUpdated = useCallback(
    (updated: AgentNode) => {
      setAgents((prev) => upsertAgentList(prev, updated));
      if (activeSessionId && updated.agentId !== "main") {
        setAgentsBySession((prev) => ({
          ...prev,
          [activeSessionId]: upsertAgentList(prev[activeSessionId] ?? [], updated),
        }));
      }
    },
    [activeSessionId],
  );

  const applyTasksUpdated = useCallback((nextTasks: TeamTaskItem[]) => {
    setTasks(nextTasks);
  }, []);

  return {
    agents,
    agentsBySession,
    tasks,
    loading,
    error,
    refresh,
    applyAgentUpdated,
    applySessionAgentUpdated,
    applyTasksUpdated,
  };
}
