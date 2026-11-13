import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentNode } from "@contracts/agents";
import type { SessionInfo, SessionOrigin } from "@contracts/chat";
import {
  deleteSession,
  fetchSessions,
  subscribeSessionsListEvents,
  updateSession,
} from "../api.ts";

export interface SessionFilters {
  origin: SessionOrigin | "all";
  cwd: string;
  q: string;
}

function sortSessions(items: SessionInfo[]): SessionInfo[] {
  return [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function useSessions(options?: {
  onAgentUpdated?: (sessionId: string, agent: AgentNode) => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<SessionFilters>({
    origin: "all",
    cwd: "",
    q: "",
  });
  const onAgentUpdatedRef = useRef(options?.onAgentUpdated);
  onAgentUpdatedRef.current = options?.onAgentUpdated;

  useEffect(() => {
    let active = true;
    fetchSessions({ archived: "all" })
      .then((list) => {
        if (!active) return;
        setSessions(sortSessions(list));
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError((e as Error).message);
        setLoading(false);
      });

    const unsub = subscribeSessionsListEvents((event) => {
      if (!active) return;
      if (event.type === "snapshot" && event.sessions) {
        setSessions(sortSessions(event.sessions));
        setLoading(false);
      } else if (event.type === "upsert" && event.session) {
        const updated = event.session;
        setSessions((prev) => {
          const without = prev.filter((s) => s.id !== updated.id);
          return sortSessions([updated, ...without]);
        });
      } else if (event.type === "delete" && event.sessionId) {
        const deletedId = event.sessionId;
        setSessions((prev) => prev.filter((s) => s.id !== deletedId));
      } else if (event.type === "agent_updated" && event.sessionId && event.agent) {
        onAgentUpdatedRef.current?.(event.sessionId, event.agent);
      }
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  const upsertLocal = useCallback((session: SessionInfo) => {
    setSessions((prev) => {
      const without = prev.filter((s) => s.id !== session.id);
      return sortSessions([session, ...without]);
    });
  }, []);

  const rename = useCallback(
    async (sessionId: string, title: string) => {
      const updated = await updateSession(sessionId, { title });
      upsertLocal(updated);
      return updated;
    },
    [upsertLocal],
  );

  const archive = useCallback(
    async (sessionId: string) => {
      const updated = await updateSession(sessionId, { archived: true });
      upsertLocal(updated);
      return updated;
    },
    [upsertLocal],
  );

  const unarchive = useCallback(
    async (sessionId: string) => {
      const updated = await updateSession(sessionId, { archived: false });
      upsertLocal(updated);
      return updated;
    },
    [upsertLocal],
  );

  const remove = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }, []);

  const availableCwds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.cwd) set.add(s.cwd);
    }
    return [...set].sort();
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const query = filters.q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filters.origin !== "all" && s.origin !== filters.origin) return false;
      if (filters.cwd && s.cwd !== filters.cwd) return false;
      if (query) {
        const hay = [s.title, s.lastMessagePreview, s.cwd, s.id, s.model]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [sessions, filters]);

  const activeSessions = useMemo(
    () => filteredSessions.filter((s) => !s.archivedAt),
    [filteredSessions],
  );

  const archivedSessions = useMemo(
    () => filteredSessions.filter((s) => Boolean(s.archivedAt)),
    [filteredSessions],
  );

  const hasBackgroundActivity = useCallback(
    (activeSessionId?: string) =>
      sessions.some(
        (s) =>
          !s.archivedAt &&
          s.id !== activeSessionId &&
          (s.status === "running" || s.status === "waiting_permission"),
      ),
    [sessions],
  );

  return {
    sessions,
    activeSessions,
    archivedSessions,
    availableCwds,
    filters,
    setFilters,
    loading,
    error,
    upsertLocal,
    rename,
    archive,
    unarchive,
    remove,
    hasBackgroundActivity,
  };
}
